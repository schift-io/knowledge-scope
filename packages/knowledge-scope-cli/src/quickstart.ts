import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema, ScopeAuthoritySchema } from "@schift-io/context-pack";
import type { CliDependencies } from "./cli.js";
import { canonicalJson, parseJsonText, type JsonValue } from "./json.js";
import { OnboardingError, searchConfiguration, type OnboardingEnvironment } from "./onboarding-config.js";
import { KnowledgeScopeApiError } from "./api.js";
import { KnowledgeScopeProductError } from "./errors.js";
import { HttpProviderAdapterError } from "./adapters/provider-port.js";

export type QuickstartRequest = Readonly<{ directory: string; index: string; tenant: string; query: string }>;
const json = (value: unknown): JsonValue => parseJsonText(JSON.stringify(value), "quickstart");

export const quickstart = async (request: QuickstartRequest, dependencies: CliDependencies, environment: OnboardingEnvironment): Promise<JsonValue> => {
  const issues = searchConfiguration(environment);
  if (issues.length > 0) throw new OnboardingError("configuration_invalid", { environment: issues });
  const scopeAuthority = ScopeAuthoritySchema.safeParse({ organizationId: environment["SCHIFT_KS_SEARCH_ORGANIZATION_ID"], tenant: request.tenant });
  if (!scopeAuthority.success || request.query.trim().length === 0 || request.query.length > 8192) throw new OnboardingError("argument_invalid");
  const definition = KnowledgeScopeDefinitionSchema.safeParse({
    packId: "search-project", version: "0.1.0", responsibility: "project-context",
    scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
    authority: { allowed: ["read", "draft"], forbidden: ["send", "approve", "mutate_source", "workflow"], precedence: ["primary", "operational", "approved", "observed", "derived"] },
    capabilities: [{ operationId: "search", provider: { kind: "schift_search", indexRef: request.index }, inputSchemaRef: "schemas/input.json", resultSchemaRef: "schemas/result.json", limits: { maxRows: 8, maxResultBytes: 131072 } }],
    contextPolicy: { mustConsider: [{ id: "project-evidence", minEvidence: 1, selector: { sourceClasses: ["document"] } }], mayConsider: [], mustNotUse: [{ id: "derived-context", selector: { authorities: ["derived"] } }] },
    evidence: { requireCitation: true, freshness: { defaultMaxAgeSeconds: 86400 }, coverageAssertions: ["project-evidence"] },
  });
  if (!definition.success) throw new OnboardingError("argument_invalid");
  const directory = resolve(request.directory);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new OnboardingError("directory_exists");
    throw error;
  }
  const pack = join(directory, "pack");
  const bindingsPath = join(directory, "bindings.json");
  const inputPath = join(directory, "input.json");
  let installationId: string | undefined;
  let artifactsComplete = false;
  const recovery = (): JsonValue => installationId === undefined
    ? ["schift-ks", "mount", pack, "--bindings", bindingsPath]
    : ["schift-ks", "run", installationId, "search", "--input", inputPath];
  try {
    await mkdir(join(pack, "schemas"), { recursive: true, mode: 0o700 });
    const bindings = { scopeAuthority: scopeAuthority.data, sourceBindings: [{ sourceId: "project-documents", sourceClass: "document", authority: "approved", permissionMode: "mirrored", providerRef: request.index, operationIds: ["search"] }] };
    const input = { effectiveScope: { tenant: request.tenant }, input: { query: request.query } };
    const files: Readonly<Record<string, JsonValue>> = {
      [join(pack, "scope.json")]: json(definition.data),
      [join(pack, "schemas/input.json")]: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 8192 } }, additionalProperties: false },
      [join(pack, "schemas/result.json")]: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: true },
      [bindingsPath]: json(bindings), [inputPath]: input,
    };
    for (const [path, value] of Object.entries(files)) await writeFile(path, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
    await dependencies.authoring.lock(pack);
    artifactsComplete = true;
    const mounted = KnowledgeScopeMountSchema.parse(await dependencies.embedded.mount(await dependencies.authoring.mountPayload(pack, bindingsPath)));
    installationId = mounted.installationId;
    await writeFile(join(directory, "installation.json"), `${JSON.stringify(mounted)}\n`, { flag: "wx", mode: 0o600 });
    const result = await dependencies.embedded.run({ installationId, operationId: "search", ...input });
    return { directory, installationId, operationId: "search", result, recovery: recovery(), status: "completed" };
  } catch (error) { // no-excuse-ok: catch -- Preserve artifacts and attach only redacted recovery metadata.
    const code = error instanceof KnowledgeScopeApiError || error instanceof KnowledgeScopeProductError || error instanceof HttpProviderAdapterError ? error.code : "quickstart_failed";
    throw new OnboardingError(code, { directory, artifactsComplete, recovery: artifactsComplete ? recovery() : ["schift-ks", "validate", pack], ...(installationId === undefined ? {} : { installationId }) });
  }
};
