import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(packageRoot, "dist");
const curatedScalars = `import { z } from "zod";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const SEMVER_PATTERN = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const PackIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"PackId">();
export const SourceIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"SourceId">();
export const RevisionIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"RevisionId">();
export const InstallationIdSchema = z.string().regex(IDENTIFIER_PATTERN).brand<"InstallationId">();
export const SemanticVersionSchema = z.string().regex(SEMVER_PATTERN).brand<"SemanticVersion">();
export const Sha256DigestSchema = z.string().regex(SHA256_PATTERN).brand<"Sha256Digest">();

export type PackId = z.infer<typeof PackIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type RevisionId = z.infer<typeof RevisionIdSchema>;
export type InstallationId = z.infer<typeof InstallationIdSchema>;
export type SemanticVersion = z.infer<typeof SemanticVersionSchema>;
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;
`;
const knowledgeScopeBoundaryPlugin = {
  name: "knowledge-scope-contract-boundary",
  setup(build) {
    build.onLoad({ filter: /context-pack\/src\/scalars\.(?:js|ts)$/ }, () => ({
      contents: curatedScalars,
      loader: "ts",
    }));
  },
};

await rm(distDirectory, { force: true, recursive: true });
await mkdir(distDirectory, { recursive: true });

for (const [entry, isMain] of [
  ["main.ts", "true"],
  ["index.ts", "false"],
  ["context-pack.ts", "false"],
]) {
  const bundle = await Bun.build({
    define: { "import.meta.main": isMain },
    entrypoints: [join(packageRoot, "src", entry)],
    format: "esm",
    naming: "[name].[ext]",
    outdir: distDirectory,
    packages: "bundle",
    plugins: [knowledgeScopeBoundaryPlugin],
    target: "node",
  });
  if (!bundle.success) {
    for (const log of bundle.logs) console.error(log);
    throw new Error(`Knowledge Scope bundle failed for ${entry}`);
  }
}
await chmod(join(distDirectory, "main.js"), 0o755);

const compileDeclarations = (configuration) => {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "tsc", "-p", configuration],
    cwd: packageRoot,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Declaration build failed for ${configuration}`);
};

compileDeclarations("tsconfig.build-context.json");

const contextTypesDirectory = join(distDirectory, "types", "context-pack");
const scalarDeclarations = await readFile(join(contextTypesDirectory, "scalars.d.ts"), "utf8");
await writeFile(
  join(contextTypesDirectory, "scalars.d.ts"),
  scalarDeclarations.split("\n").filter((line) => !line.includes("RuntimeId")).join("\n"),
);
await writeFile(join(contextTypesDirectory, "index.d.ts"), `export {
  InstallationIdSchema,
  PackIdSchema,
  RevisionIdSchema,
  SemanticVersionSchema,
  Sha256DigestSchema,
  SourceIdSchema,
} from "./scalars.js";
export type {
  InstallationId,
  PackId,
  RevisionId,
  SemanticVersion,
  Sha256Digest,
  SourceId,
} from "./scalars.js";
export { CanonicalJsonError, canonicalJson, digestCanonicalJson } from "./canonical.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./canonical.js";
export {
  AuthorizationDecisionSchema,
  CandidateEnvelopeSchema,
  CitationSchema,
  EffectiveScopeSchema,
  KnowledgeScopeDefinitionSchema,
  QueryCapabilitySchema,
  QueryProviderSchema,
  ScopeAuthoritySchema,
} from "./knowledge-scope.js";
export type {
  AuthorizationDecision,
  CandidateEnvelope,
  KnowledgeScopeDefinition,
  QueryCapability,
  QueryProvider,
} from "./knowledge-scope.js";
export {
  KnowledgeScopeMountSchema,
  KnowledgeScopePackSchema,
  materializeKnowledgeScopePack,
} from "./knowledge-scope-mount.js";
export type { KnowledgeScopeMount, KnowledgeScopePack } from "./knowledge-scope-mount.js";
export {
  KnowledgeScopeLockSchema,
  buildKnowledgeScopeLock,
  digestKnowledgeScopeDefinition,
  verifyKnowledgeScopeLock,
} from "./knowledge-scope-lock.js";
export type { KnowledgeScopeLock } from "./knowledge-scope-lock.js";
export {
  CandidateAdmissionReceiptSchema,
  CapabilityExecutionRequestSchema,
  ProviderResultSchema,
  ScopeRequirementReceiptSchema,
} from "./knowledge-scope-execution.js";
export type {
  AdmissionDenialReason,
  CandidateAdmissionReceipt,
  CapabilityExecutionRequest,
  ProviderResult,
  ScopeRequirementReceipt,
} from "./knowledge-scope-execution.js";
export { CapabilityBatchOperationSchema, CapabilityBatchExecutionRequestSchema } from "./knowledge-scope-batch.js";
export type { CapabilityBatchOperation, CapabilityBatchExecutionRequest } from "./knowledge-scope-batch.js";
export {
  ADMISSION_DENIAL_REASONS,
  admitKnowledgeScopeCandidate,
  admitKnowledgeScopeCandidates,
} from "./knowledge-scope-admission.js";
export type {
  AdmissionResult,
  KnowledgeScopeAdmissionInput,
  KnowledgeScopeBatchAdmissionInput,
} from "./knowledge-scope-admission.js";
`);

compileDeclarations("tsconfig.build.json");

const rewriteDeclarations = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarations(path);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      const declaration = await readFile(path, "utf8");
      await writeFile(
        path,
        declaration.replaceAll(
          '"@schift-io/context-pack"',
          '"@schift-io/knowledge-scope/context-pack"',
        ),
      );
    }
  }
};

await rewriteDeclarations(join(distDirectory, "types"));
