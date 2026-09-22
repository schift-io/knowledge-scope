import { z } from "zod";

import { canonicalJson, digestCanonicalJson } from "./canonical.js";
import type { JsonValue } from "./canonical.js";
import { BoundedJsonValueSchema } from "./bounded-json.js";
import { KnowledgeScopeDefinitionSchema } from "./knowledge-scope.js";
import type { KnowledgeScopeDefinition } from "./knowledge-scope.js";
import { PackIdSchema, SemanticVersionSchema, Sha256DigestSchema } from "./scalars.js";
import type { Sha256Digest } from "./scalars.js";

const LOCK_SCHEMA_VERSION = "knowledge-scope-lock.schift.dev/v0.1" as const;
const PortablePathSchema = z.string().min(1).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && !path.includes("://") &&
  path.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."),
"Lock paths must be normalized relative paths");
const LockFileSchema = z.object({ path: PortablePathSchema, digest: Sha256DigestSchema }).strict().readonly();
const LockProjectionBaseSchema = z.object({
  schemaVersion: z.literal(LOCK_SCHEMA_VERSION), packId: PackIdSchema,
  version: SemanticVersionSchema, definitionDigest: Sha256DigestSchema,
  files: z.array(LockFileSchema).min(1).readonly(),
}).strict();
const validateSortedFiles = (lock: z.infer<typeof LockProjectionBaseSchema>, context: z.RefinementCtx): void => {
  const paths = lock.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || canonicalJson(paths) !== canonicalJson([...paths].sort())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Lock files must be unique and lexically sorted" });
  }
};
const LockProjectionSchema = LockProjectionBaseSchema.superRefine(validateSortedFiles).readonly();
export const KnowledgeScopeLockSchema = LockProjectionBaseSchema.extend({
  lockDigest: Sha256DigestSchema,
}).strict().superRefine(validateSortedFiles).readonly();

export type KnowledgeScopeLock = z.infer<typeof KnowledgeScopeLockSchema>;
export type KnowledgeScopeFileValues = Readonly<Record<string, JsonValue>>;

export class KnowledgeScopeLockError extends Error {
  public readonly code: "invalid_file_inventory" | "definition_file_mismatch" | "non_portable_number";

  public constructor(code: KnowledgeScopeLockError["code"], message: string) {
    super(message);
    this.name = "KnowledgeScopeLockError";
    this.code = code;
  }
}

const normalizePortableJson = (value: JsonValue): JsonValue => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new KnowledgeScopeLockError(
        "non_portable_number",
        "Knowledge Scope lock JSON numbers must be portable safe integers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizePortableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizePortableJson(entry)]),
    );
  }
  return value;
};

export const digestKnowledgeScopeDefinition = async (
  definition: KnowledgeScopeDefinition,
): Promise<Sha256Digest> => digestCanonicalJson(
  normalizePortableJson(BoundedJsonValueSchema.parse(definition)),
);

const expectedPaths = (definition: KnowledgeScopeDefinition): readonly string[] => [
  "scope.json",
  ...new Set(definition.capabilities.flatMap((capability) => [
    capability.inputSchemaRef, capability.resultSchemaRef,
  ])),
].sort();

const validateInventory = (
  definition: KnowledgeScopeDefinition,
  files: KnowledgeScopeFileValues,
): readonly string[] => {
  const paths = Object.keys(files).sort();
  const parsed = z.array(PortablePathSchema).safeParse(paths);
  if (!parsed.success || canonicalJson(paths) !== canonicalJson(expectedPaths(definition))) {
    throw new KnowledgeScopeLockError("invalid_file_inventory", "Files must exactly match scope.json and declared schemas");
  }
  const scopeFile = files["scope.json"];
  const parsedScope = KnowledgeScopeDefinitionSchema.safeParse(scopeFile);
  if (!parsedScope.success ||
    canonicalJson(normalizePortableJson(BoundedJsonValueSchema.parse(parsedScope.data))) !==
      canonicalJson(normalizePortableJson(BoundedJsonValueSchema.parse(definition)))) {
    throw new KnowledgeScopeLockError("definition_file_mismatch", "scope.json must match the parsed definition");
  }
  return paths;
};

export const buildKnowledgeScopeLock = async (
  definition: KnowledgeScopeDefinition,
  files: KnowledgeScopeFileValues,
): Promise<KnowledgeScopeLock> => {
  const paths = validateInventory(definition, files);
  const lockProjection = LockProjectionSchema.parse({
    schemaVersion: LOCK_SCHEMA_VERSION,
    packId: definition.packId,
    version: definition.version,
    definitionDigest: await digestKnowledgeScopeDefinition(definition),
    files: await Promise.all(paths.map(async (path) => ({
      path,
      digest: await digestCanonicalJson(
        normalizePortableJson(BoundedJsonValueSchema.parse(files[path] ?? null)),
      ),
    }))),
  });
  return KnowledgeScopeLockSchema.parse({
    ...lockProjection, lockDigest: await digestCanonicalJson(lockProjection),
  });
};

export const verifyKnowledgeScopeLock = async (
  definition: KnowledgeScopeDefinition,
  files: KnowledgeScopeFileValues,
  lock: KnowledgeScopeLock,
): Promise<boolean> => {
  const parsed = KnowledgeScopeLockSchema.safeParse(lock);
  if (!parsed.success) return false;
  const expected = await buildKnowledgeScopeLock(definition, files);
  return canonicalJson(expected) === canonicalJson(parsed.data);
};
