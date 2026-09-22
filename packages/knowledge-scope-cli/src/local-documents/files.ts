import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { decodeUtf8Strict } from "../json.js";

export class LocalDocumentError extends Error {
  public override readonly name = "LocalDocumentError";
  public constructor(public readonly code: "local_source_invalid" | "local_limit_exceeded" | "local_snapshot_invalid" | "local_scope_invalid") {
    super({ local_source_invalid: "Select regular UTF-8 Markdown (.md) or text (.txt) files; symlinks, hardlinks and binary files are unsupported.",
      local_limit_exceeded: "Local documents exceed the supported file, byte, or chunk limits.",
      local_snapshot_invalid: "Local document snapshot is missing, unsafe, or corrupt; ingest the source again.",
      local_scope_invalid: "Local documents require the mounted tenant and document binding; filters and narrowed scopes are unsupported." }[code]);
  }
}
export const LOCAL_LIMITS = { files: 100, fileBytes: 1_048_576, totalBytes: 8_388_608, snapshotBytes: 16_777_216, chunks: 4000, entries: 2000, depth: 16, chunkCharacters: 2000 } as const;

type FileIdentity = Readonly<Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "nlink">>;
type DirectoryIdentity = Readonly<{ path: string; dev: number; ino: number }>;
export type CollectedFile = Readonly<{ path: string; root: string; identity: FileIdentity; ancestors: readonly DirectoryIdentity[] }>;
const identityMatches = (left: FileIdentity, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1;
const checkDirectories = async (directories: readonly DirectoryIdentity[]): Promise<void> => {
  for (const directory of directories) {
    const current = await lstat(directory.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino ||
      await realpath(directory.path) !== directory.path) throw new LocalDocumentError("local_source_invalid");
  }
};
export const mapLocalFileError = (error: unknown, ownerOnly: boolean): never => {
  if (error instanceof Error && "code" in error && typeof error.code === "string" &&
    ["ENOENT", "ELOOP", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error.code)) {
    throw new LocalDocumentError(ownerOnly ? "local_snapshot_invalid" : "local_source_invalid");
  }
  throw error;
};
export const readBounded = async (source: string | CollectedFile, maxBytes: number, ownerOnly = false): Promise<string> => {
  try { return await readFileContents(source, maxBytes, ownerOnly); }
  catch (error) { return mapLocalFileError(error, ownerOnly); }
};
const readFileContents = async (source: string | CollectedFile, maxBytes: number, ownerOnly: boolean): Promise<string> => {
  if (!constants.O_NOFOLLOW) throw new LocalDocumentError("local_source_invalid");
  const path = typeof source === "string" ? source : source.path;
  if (typeof source !== "string") {
    await checkDirectories(source.ancestors);
    const currentPath = await realpath(path);
    const inside = relative(source.root, currentPath);
    if (currentPath !== path || inside === ".." || inside.startsWith(`..${sep}`)) throw new LocalDocumentError("local_source_invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (typeof source !== "string") {
      if (!identityMatches(source.identity, before)) throw new LocalDocumentError("local_source_invalid");
      await checkDirectories(source.ancestors);
    }
    if (!before.isFile() || (ownerOnly && ((before.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && before.uid !== process.getuid())))) throw new LocalDocumentError("local_snapshot_invalid");
    if (before.size > maxBytes) throw new LocalDocumentError("local_limit_exceeded");
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > maxBytes) throw new LocalDocumentError("local_limit_exceeded");
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      (typeof source !== "string" && !identityMatches(source.identity, after))) throw new LocalDocumentError("local_source_invalid");
    if (typeof source !== "string") await checkDirectories(source.ancestors);
    const text = decodeUtf8Strict(buffer.subarray(0, length));
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new LocalDocumentError("local_source_invalid");
    return text;
  } finally { await handle.close(); }
};

export const collectFiles = async (source: string): Promise<readonly CollectedFile[]> => {
  try { return await collectSourceFiles(source); }
  catch (error) { return mapLocalFileError(error, false); }
};
const collectSourceFiles = async (source: string): Promise<readonly CollectedFile[]> => {
  const selected = resolve(source);
  const selectedMetadata = await lstat(selected);
  if (selectedMetadata.isSymbolicLink()) throw new LocalDocumentError("local_source_invalid");
  const root = await realpath(selected);
  const rootMetadata = await lstat(root);
  if (selectedMetadata.dev !== rootMetadata.dev || selectedMetadata.ino !== rootMetadata.ino) throw new LocalDocumentError("local_source_invalid");
  const boundary = rootMetadata.isDirectory() ? root : dirname(root);
  const parentMetadata = await lstat(dirname(boundary));
  const parents: readonly DirectoryIdentity[] = [{ path: dirname(boundary), dev: parentMetadata.dev, ino: parentMetadata.ino }];
  const files: CollectedFile[] = []; let entries = 1;
  const visit = async (path: string, depth: number, ancestors: readonly DirectoryIdentity[]): Promise<void> => {
    await checkDirectories(ancestors);
    if (entries > LOCAL_LIMITS.entries || depth > LOCAL_LIMITS.depth) throw new LocalDocumentError("local_limit_exceeded");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new LocalDocumentError("local_source_invalid");
    if (metadata.isDirectory()) {
      const directories = [...ancestors, { path, dev: metadata.dev, ino: metadata.ino }];
      await checkDirectories(directories);
      const directory = await opendir(path);
      for await (const child of directory) {
        entries += 1;
        if (entries > LOCAL_LIMITS.entries) throw new LocalDocumentError("local_limit_exceeded");
        if (child.name.startsWith(".") || child.name === "node_modules") continue;
        await visit(join(path, child.name), depth + 1, directories);
      }
      await checkDirectories(directories);
      return;
    }
    if (!metadata.isFile()) throw new LocalDocumentError("local_source_invalid");
    if (![".md", ".txt"].includes(extname(path).toLowerCase())) {
      if (depth === 0) throw new LocalDocumentError("local_source_invalid");
      return;
    }
    if (metadata.nlink !== 1 || await realpath(path) !== path) throw new LocalDocumentError("local_source_invalid");
    files.push({ path, root: boundary, identity: metadata, ancestors });
    if (files.length > LOCAL_LIMITS.files) throw new LocalDocumentError("local_limit_exceeded");
  };
  const boundaryMetadata = await lstat(boundary);
  await visit(root, 0, rootMetadata.isDirectory() ? parents : [...parents, { path: boundary, dev: boundaryMetadata.dev, ino: boundaryMetadata.ino }]);
  if (files.length === 0) throw new LocalDocumentError("local_source_invalid");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
};
