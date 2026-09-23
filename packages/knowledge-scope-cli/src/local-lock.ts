import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createServer } from "node:net";
import { syncDirectory } from "./durable-file.js";

export class LocalLockError extends Error {
  public override readonly name = "LocalLockError";
  public constructor(public readonly code: "busy" | "invalid" | "unavailable") { super(code); }
}
const hasCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

// Nested project -> state acquisition must never contend with itself.
export const localGuardPort = (lockName: string, unsignedHash: number): number =>
  lockName === "state.lock" ? 16384 + (unsignedHash % 16384) : 1024 + (unsignedHash % 15360);

const guardPort = async (path: string): Promise<number> => {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new LocalLockError("invalid");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && parent.uid !== process.getuid())) throw new LocalLockError("invalid");
  // All aliases for one parent inode converge. A port collision fails closed.
  const hash = createHash("sha256").update(`schift-ks-lock-v1:${parent.dev}:${parent.ino}:${basename(path)}`).digest();
  return localGuardPort(basename(path), hash.readUInt32BE(0));
};

/** Permanent empty directory blocks legacy file-lock writers; never unlink it. */
const prepareMarker = async (path: string): Promise<void> => {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const marker = await lstat(path);
  if (marker.isSymbolicLink() || (marker.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && marker.uid !== process.getuid())) throw new LocalLockError("invalid");
  if (marker.isFile()) throw new LocalLockError("busy");
  if (!marker.isDirectory() || (await readdir(path)).length !== 0) throw new LocalLockError("invalid");
};

/** Kernel guard also used by explicit, quiesced legacy-marker recovery. */
export const withLocalGuard = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
  const port = await guardPort(path);
  const server = createServer((socket) => socket.destroy());
  const controller = new AbortController();
  server.maxConnections = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { controller.abort(); reject(new LocalLockError("busy")); }, 5000);
      const failed = (error: Error): void => { clearTimeout(timer); reject(error); };
      server.once("error", failed);
      server.listen({ host: "127.0.0.1", port, exclusive: true, signal: controller.signal }, () => {
        clearTimeout(timer); server.removeListener("error", failed); resolve();
      });
    });
  } catch (error) {
    controller.abort();
    server.close();
    if (hasCode(error, "EADDRINUSE")) throw new LocalLockError("busy");
    if (hasCode(error, "EPERM") || hasCode(error, "EACCES") || hasCode(error, "EADDRNOTAVAIL")) throw new LocalLockError("unavailable");
    throw error;
  }
  try { return await action(); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
};

export const withLocalLock = async <T>(path: string, action: () => Promise<T>): Promise<T> =>
  withLocalGuard(path, async () => { await prepareMarker(path); await syncDirectory(dirname(path)); return action(); });
