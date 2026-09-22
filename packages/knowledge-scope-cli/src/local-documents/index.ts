import { mkdir, lstat, open, link, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderResultSchema, type ProviderResult } from "@schift-io/context-pack";
import type { ProviderExecutionContext } from "../application-execution.js";
import type { KnowledgeScopeStateStoreOptions } from "../state-store.js";
import { canonicalJson, parseJsonText } from "../json.js";
import { LocalDocumentError, LOCAL_LIMITS, readBounded, mapLocalFileError } from "./files.js";
import { buildSnapshot, chunksFor, digest, lexicalTerms, snapshotId, SnapshotSchema, type Snapshot } from "./snapshot.js";
export { LocalDocumentError, LOCAL_LIMITS } from "./files.js";

const QuerySchema = z.object({ query: z.string().min(1).max(8192) }).strict();
const assertPrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())) throw new LocalDocumentError("local_snapshot_invalid");
};

/** Private snapshots belong to the local filesystem owner, not a multi-user ACL service. */
export class LocalDocumentStore {
  public readonly home: string;
  public constructor(options: KnowledgeScopeStateStoreOptions = {}) {
    this.home = options.home ?? (options.environment ?? process.env)["SCHIFT_KS_HOME"] ?? join(homedir(), ".schift", "knowledge-scope");
  }
  private async directory(): Promise<string> {
    try {
      await assertPrivateDirectory(this.home);
      const directory = join(this.home, "local-documents");
      await assertPrivateDirectory(directory); return directory;
    } catch (error) { return mapLocalFileError(error, true); }
  }
  public async ingest(sourcePath: string): Promise<Readonly<{ indexRef: string; documentCount: number; chunkCount: number }>> {
    const snapshot = await buildSnapshot(sourcePath);
    const chunks = chunksFor(snapshot);
    if (chunks.length === 0) throw new LocalDocumentError("local_source_invalid");
    const indexRef = snapshotId(snapshot); const directory = await this.directory();
    const temporary = join(directory, `.ingest-${randomUUID()}`);
    const serialized = canonicalJson(snapshot);
    if (Buffer.byteLength(serialized) > LOCAL_LIMITS.snapshotBytes) throw new LocalDocumentError("local_limit_exceeded");
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8"); await handle.sync();
      try { await link(temporary, join(directory, `${indexRef.slice(6)}.json`)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    } finally { await handle.close(); await rm(temporary, { force: true }); }
    return { indexRef, documentCount: snapshot.documents.length, chunkCount: chunks.length };
  }
  private async read(indexRef: string): Promise<Snapshot> {
    if (!/^local:[a-f0-9]{64}$/u.test(indexRef)) throw new LocalDocumentError("local_snapshot_invalid");
    const directory = await this.directory();
    const text = await readBounded(join(directory, `${indexRef.slice(6)}.json`), LOCAL_LIMITS.snapshotBytes, true);
    const parsed = SnapshotSchema.safeParse(parseJsonText(text, "local snapshot", { maxBytes: LOCAL_LIMITS.snapshotBytes }));
    if (!parsed.success || snapshotId(parsed.data) !== indexRef) throw new LocalDocumentError("local_snapshot_invalid");
    return parsed.data;
  }
  public async execute(context: ProviderExecutionContext): Promise<readonly ProviderResult[]> {
    const { capability, binding, request, mount } = context;
    if (mount.state !== "mounted" || !mount.sourceBindings.some((entry) => canonicalJson(entry) === canonicalJson(binding)) ||
      capability.provider.kind !== "local_documents" || binding.sourceClass !== "document" ||
      binding.providerRef !== capability.provider.indexRef || binding.connectorRef !== undefined ||
      binding.permissionMode !== "static" || !binding.operationIds.includes(capability.operationId) ||
      request.operationId !== capability.operationId || request.installationId !== mount.installationId ||
      request.effectiveScope.tenant !== mount.scopeAuthority.tenant ||
      request.effectiveScope.namespace !== undefined || request.effectiveScope.subject !== undefined || request.effectiveScope.session !== undefined ||
      (capability.requiredProviderScopes?.length ?? 0) > 0 || Object.keys(request.filters ?? {}).length > 0) throw new LocalDocumentError("local_scope_invalid");
    const query = QuerySchema.safeParse(request.input);
    if (!query.success || !context.validateInput(request.input).valid) throw new LocalDocumentError("local_source_invalid");
    const snapshot = await this.read(capability.provider.indexRef);
    const terms = lexicalTerms(query.data.query);
    const ranked = chunksFor(snapshot).map((chunk) => {
      const tokens = new Set(lexicalTerms(chunk.text));
      return { chunk, score: terms.filter((term) => tokens.has(term)).length };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    const results: ProviderResult[] = []; let bytes = 0;
    for (const { chunk, score } of ranked.slice(0, Math.min(capability.limits?.maxRows ?? 8, 100))) {
      const sourcePath = fileURLToPath(chunk.document.uri);
      const documentId = `doc:${digest(chunk.document.uri)}`;
      const payload = { text: chunk.text, sourceId: binding.sourceId, documentId, sourcePath, chunkId: chunk.id, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, score };
      if (!context.validateResult(payload).valid) throw new LocalDocumentError("local_source_invalid");
      const result = ProviderResultSchema.parse({ resultId: chunk.id, srn: `srn:local:${chunk.id.slice(6)}`, revision: chunk.document.revision,
        freshness: snapshot.capturedAt, payload, citation: { uri: `schift://local-documents/${capability.provider.indexRef}/${documentId}#L${chunk.lineStart}-L${chunk.lineEnd}`, label: `${basename(sourcePath)}:L${chunk.lineStart}-L${chunk.lineEnd}` },
        providerScopes: [], providerEvidence: { kind: "local_documents", indexRef: capability.provider.indexRef } });
      bytes += Buffer.byteLength(canonicalJson(result));
      if (bytes > Math.min(capability.limits?.maxResultBytes ?? 1_048_576, 8_388_608)) throw new LocalDocumentError("local_limit_exceeded");
      results.push(result);
    }
    return results;
  }
}
