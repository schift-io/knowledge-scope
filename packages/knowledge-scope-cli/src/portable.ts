import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  KnowledgeScopeDefinitionSchema,
  KnowledgeScopeLockSchema,
  buildKnowledgeScopeLock,
  verifyKnowledgeScopeLock,
  type KnowledgeScopeDefinition,
  type KnowledgeScopeLock,
} from "@schift-io/context-pack";

import { productError } from "./errors.js";
import {
  DEFAULT_MAX_JSON_BYTES,
  canonicalJson,
  decodeUtf8Strict,
  parseJsonText,
  type JsonValue,
} from "./json.js";
import { compileSchemaSubset } from "./schema-subset.js";

export type PortableKnowledgeScope = Readonly<{
  directory: string;
  definition: KnowledgeScopeDefinition;
  files: Readonly<Record<string, JsonValue>>;
  lock?: KnowledgeScopeLock;
}>;

export type LoadPortableScopeOptions = Readonly<{ readLock?: boolean }>;

const normalizeRelativePath = (path: string): string => {
  const normalized = path.split(sep).join("/");
  if (
    normalized.length === 0 || normalized.startsWith("/") || normalized.includes("\\") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw productError("path_invalid");
  }
  return normalized;
};

const hasCode = (value: unknown, code: string): boolean =>
  value !== null && typeof value === "object" && "code" in value && value.code === code;

const readNoFollowText = async (
  path: string,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<string> => {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw productError("path_invalid");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw productError("path_invalid");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw productError("path_invalid");
    if (metadata.size > maxBytes) throw productError("json_limits_exceeded");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, size);
      if (bytesRead === 0) return decodeUtf8Strict(Buffer.concat(chunks, size));
      size += bytesRead;
      if (size > maxBytes) throw productError("json_limits_exceeded");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    throw productError("json_limits_exceeded");
  } finally {
    await handle.close();
  }
};

const walkJsonFiles = async (root: string, current = root): Promise<readonly string[]> => {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) throw productError("path_invalid");
  if (!metadata.isDirectory()) throw productError("path_invalid");
  const paths: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const entryMetadata = await lstat(absolute);
    if (entryMetadata.isSymbolicLink()) throw productError("path_invalid");
    const path = normalizeRelativePath(relative(root, absolute));
    if (entryMetadata.isDirectory()) {
      if (path !== ".schift") paths.push(...await walkJsonFiles(root, absolute));
      continue;
    }
    if (!entryMetadata.isFile()) throw productError("path_invalid");
    if (path !== "scope.lock.json") paths.push(path);
  }
  return paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
};

const readJsonFile = async (root: string, path: string): Promise<JsonValue> => {
  const normalized = normalizeRelativePath(path);
  const absolute = resolve(root, normalized);
  const prefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(prefix)) throw productError("path_invalid");
  const text = await readNoFollowText(absolute).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      throw productError("portable_file_missing");
    }
    throw error;
  });
  return parseJsonText(text, normalized, { maxDepth: 40 });
};

const declaredPaths = (definition: KnowledgeScopeDefinition): readonly string[] => [
  "scope.json",
  ...new Set(definition.capabilities.flatMap((capability) => [
    normalizeRelativePath(capability.inputSchemaRef),
    normalizeRelativePath(capability.resultSchemaRef),
  ])),
].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

export const loadPortableScope = async (
  directory: string,
  options: LoadPortableScopeOptions = {},
): Promise<PortableKnowledgeScope> => {
  const root = resolve(directory);
  const discovered = await walkJsonFiles(root);
  if (!discovered.includes("scope.json")) throw productError("portable_file_missing");
  const rawDefinition = await readJsonFile(root, "scope.json");
  const parsedDefinition = KnowledgeScopeDefinitionSchema.safeParse(rawDefinition);
  if (!parsedDefinition.success) throw productError("definition_invalid");
  const expected = declaredPaths(parsedDefinition.data);
  const extras = discovered.filter((path) => !expected.includes(path));
  if (extras.length > 0) throw productError("portable_file_extra");
  if (expected.some((path) => !discovered.includes(path))) throw productError("portable_file_missing");
  const entries = await Promise.all(expected.map(async (path) => [path, await readJsonFile(root, path)] as const));
  const files: Readonly<Record<string, JsonValue>> = Object.fromEntries(entries);
  for (const path of expected.filter((item) => item !== "scope.json")) compileSchemaSubset(files[path]);
  if (options.readLock === false) return { directory: root, definition: parsedDefinition.data, files };
  const lockPath = join(root, "scope.lock.json");
  try {
    const rawLock = parseJsonText(await readNoFollowText(lockPath), "scope.lock.json");
    const parsedLock = KnowledgeScopeLockSchema.safeParse(rawLock);
    if (!parsedLock.success) throw productError("lock_invalid");
    return { directory: root, definition: parsedDefinition.data, files, lock: parsedLock.data };
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { directory: root, definition: parsedDefinition.data, files };
    }
    throw error;
  }
};

export const createPortableLock = async (directory: string): Promise<KnowledgeScopeLock> => {
  const portable = await loadPortableScope(directory, { readLock: false });
  const lock = await buildKnowledgeScopeLock(portable.definition, portable.files);
  const lockPath = join(portable.directory, "scope.lock.json");
  const temporaryPath = join(dirname(lockPath), `.scope-lock-${randomUUID()}.tmp`);
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(temporaryPath, "wx", 0o644);
  try {
    await handle.writeFile(`${canonicalJson(lock)}\n`, "utf8");
    await handle.sync();
    await rename(temporaryPath, lockPath);
  } finally {
    await handle.close();
    await rm(temporaryPath, { force: true });
  }
  return lock;
};

export const verifyPortableLock = async (directory: string): Promise<boolean> => {
  const portable = await loadPortableScope(directory);
  if (portable.lock === undefined) throw productError("lock_invalid");
  return verifyKnowledgeScopeLock(portable.definition, portable.files, portable.lock);
};
