import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

export type DurableWriteFaults = Readonly<{ beforeRename?: () => Promise<void>; afterRename?: () => Promise<void> }>;
export class DurableWriteError extends Error {
  public override readonly name = "DurableWriteError";
  public readonly code = "commit_uncertain";
  public constructor(cause: unknown) { super("commit_uncertain", { cause }); }
}

/** Exclusive creation never overwrites. On failure retain the possibly visible file for recovery. */
export const writeDurableNewFile = async (path: string, contents: string, faults: Readonly<{ beforeSync?: () => Promise<void> }> = {}): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await faults.beforeSync?.();
    await handle.sync();
    await syncDirectory(dirname(path));
  } catch (error) { throw new DurableWriteError(error); }
  finally { await handle.close(); }
};

/** After rename a directory-sync failure means commit durability is uncertain. */
export const writeDurableFile = async (path: string, contents: string, faults: DurableWriteFaults = {}): Promise<void> => {
  const temporary = join(dirname(path), `.ks-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await faults.beforeRename?.();
    await rename(temporary, path);
    try { await faults.afterRename?.(); await syncDirectory(dirname(path)); }
    catch (error) { throw new DurableWriteError(error); }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
};
