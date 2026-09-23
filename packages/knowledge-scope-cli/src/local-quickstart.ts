import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema, ScopeAuthoritySchema, buildKnowledgeScopeLock, type KnowledgeScopeMount } from "@schift-io/context-pack";
import type { CliDependencies } from "./cli.js";
import { canonicalJson, parseJsonText, type JsonValue } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";
import { KnowledgeScopeProductError } from "./errors.js";
import { KnowledgeScopeApiError } from "./api.js";
import { LocalDocumentError } from "./local-documents/index.js";
import { DurableWriteError, syncDirectory, writeDurableNewFile } from "./durable-file.js";

export type LocalDocumentImportPort = Readonly<{
  ingest: (sourcePath: string, options?:Readonly<{beforePublish:(indexRef:string)=>Promise<void>}>) => Promise<Readonly<{ indexRef: string; documentCount: number; chunkCount: number }>>;
}>;
export const localQuickstart = async (
  request: Readonly<{ directory: string; source: string; tenant: string; query: string }>,
  dependencies: CliDependencies,
): Promise<JsonValue> => prepareLocalSnapshot(request, dependencies);

export const prepareLocalSnapshot = async (
  request: Readonly<{ directory: string; source: string; tenant: string; query?: string; packId?:string; progress?:Readonly<{beforePublish:(indexRef:string)=>Promise<void>;beforeFiles:(files:Readonly<Record<string,JsonValue>>)=>Promise<void>;mounted:(mount:KnowledgeScopeMount)=>Promise<void>}> }>,
  dependencies: CliDependencies,
): Promise<JsonValue> => {
  const importer = dependencies.localDocuments;
  if (importer === undefined) throw new OnboardingError("local_import_unavailable");
  const scopeAuthority = ScopeAuthoritySchema.safeParse({ organizationId: "local-organization", tenant: request.tenant });
  if (!scopeAuthority.success || (request.query !== undefined && (request.query.trim().length === 0 || request.query.length > 8192))) throw new OnboardingError("argument_invalid");
  const directory = resolve(request.directory);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new OnboardingError("directory_exists", { nextAction: "Choose a new workspace directory; your existing files were not changed." });
    throw error;
  }
  const pack = join(directory, "pack"); const bindingsPath = join(directory, "bindings.json");
  let installationId: string | undefined; let artifactsComplete = false;
  try {
    const imported = await importer.ingest(request.source,request.progress===undefined?undefined:{beforePublish:request.progress.beforePublish});
    const definition = KnowledgeScopeDefinitionSchema.parse({
      packId: request.packId??"local-project", version: "0.1.0", responsibility: "project-context",
      scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
      authority: { allowed: ["read", "draft"], forbidden: ["send", "approve", "mutate_source", "workflow"], precedence: ["primary", "operational", "approved", "observed", "derived"] },
      capabilities: [{ operationId: "search", provider: { kind: "local_documents", indexRef: imported.indexRef }, inputSchemaRef: "schemas/input.json", resultSchemaRef: "schemas/result.json", limits: { maxRows: 8, maxResultBytes: 131072 } }],
      contextPolicy: { mustConsider: [{ id: "project-evidence", minEvidence: 1, selector: { sourceClasses: ["document"] } }], mayConsider: [], mustNotUse: [{ id: "derived-context", selector: { authorities: ["derived"] } }] },
      evidence: { requireCitation: true, freshness: { defaultMaxAgeSeconds: 86400 }, coverageAssertions: ["project-evidence"] },
    });
    const bindings = { scopeAuthority: scopeAuthority.data, sourceBindings: [{ sourceId: "project-documents", sourceClass: "document", authority: "approved", permissionMode: "static", providerRef: imported.indexRef, operationIds: ["search"] }] };
    const input = { effectiveScope: { tenant: request.tenant }, input: { query: request.query ?? "" } };
    await mkdir(join(pack, "schemas"), { recursive: true, mode: 0o700 });
    const files: Readonly<Record<string, JsonValue>> = {
      [join(pack, "scope.json")]: parseJsonText(JSON.stringify(definition), "local definition"),
      [join(pack, "schemas/input.json")]: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 8192 } }, additionalProperties: false },
      [join(pack, "schemas/result.json")]: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: true },
      [bindingsPath]: bindings, [join(directory, "input.json")]: input,
    };
    const lockFiles:Record<string,JsonValue>={};
    for(const [path,value] of Object.entries(files)) if(path.startsWith(`${pack}/`)) lockFiles[path.slice(pack.length+1)]=value;
    const plannedLock=await buildKnowledgeScopeLock(definition,lockFiles);
    await request.progress?.beforeFiles({...files,[join(pack,"scope.lock.json")]:parseJsonText(JSON.stringify(plannedLock),"lock")});
    for (const [path, value] of Object.entries(files)) await writeDurableNewFile(path, `${canonicalJson(value)}\n`);
    await dependencies.authoring.lock(pack);
    await syncDirectory(pack); await syncDirectory(directory); artifactsComplete = true;
    const mounted = KnowledgeScopeMountSchema.parse(await dependencies.embedded.mount(await dependencies.authoring.mountPayload(pack, bindingsPath)));
    installationId = mounted.installationId;
    await request.progress?.mounted(mounted);
    await writeDurableNewFile(join(directory, "installation.json"), `${JSON.stringify(mounted)}\n`);
    const result = request.query === undefined ? null : await dependencies.embedded.run({ installationId, operationId: "search", expectedRevision: mounted.revision, ...input });
    return { directory, installationId, tenant: request.tenant, operationId: "search", documentCount: imported.documentCount, chunkCount: imported.chunkCount,
      result, nextQuery: ["schift-ks", "query", installationId, "--query", "Your next question"], status: "completed",
      storage: "local_snapshot", note: "Documents stay on this computer. Search uses keywords, not semantic embeddings. Re-import into a new workspace to refresh the snapshot." };
  } catch (error) { // no-excuse-ok: catch -- Onboarding boundary preserves artifacts and redacts source contents and filesystem errors.
    if (error instanceof DurableWriteError) throw error;
    const code = error instanceof LocalDocumentError || error instanceof OnboardingError || error instanceof KnowledgeScopeProductError || error instanceof KnowledgeScopeApiError ? error.code : "local_quickstart_failed";
    const recovery = installationId !== undefined ? ["schift-ks", "query", installationId, "--query", request.query ?? "<question>"]
      : artifactsComplete ? ["schift-ks", "mount", pack, "--bindings", bindingsPath] : ["schift-ks", "quickstart", "<new-workspace>", "--source", "<file-or-directory>", "--query", "<question>"];
    throw new OnboardingError(code, { directory, artifactsComplete, recovery, nextAction: artifactsComplete ? "Use the recovery command to retry; your source files were not changed." : "Check that your source contains readable .md or .txt files, then retry with a new workspace. Your source files were not changed.", ...(installationId === undefined ? {} : { installationId }) });
  }
};
