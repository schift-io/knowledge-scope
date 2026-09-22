import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { KnowledgeScopeProductError, productError } from "./errors.js";
import { DEFAULT_MAX_JSON_BYTES, canonicalJson, decodeUtf8Strict, parseJsonText } from "./json.js";
import {
  EMPTY_KNOWLEDGE_SCOPE_STATE,
  KnowledgeScopeStateSchema,
  type KnowledgeScopeState,
} from "./state-contract.js";

export type StateMutation<T> = Readonly<{ state: KnowledgeScopeState; value: T }>;

export interface StateStoreFaults {
  beforeRename(): Promise<void>;
}

export type KnowledgeScopeStateStoreOptions = Readonly<{
  home?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  faults?: StateStoreFaults;
}>;

type LockOwner = Readonly<{ pid: number; createdAt: number; nonce: string }>;
export const MAX_STATE_BYTES = 16 * 1_024 * 1_024;
export const MAX_STATE_DEPTH = 48;
export const MAX_STATE_NODES = 250_000;
const STATE_PARSE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  maxDepth: MAX_STATE_DEPTH,
  maxNodes: MAX_STATE_NODES,
} as const;

const serializeState = (state: KnowledgeScopeState): string => {
  const serialized = `${canonicalJson(state)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
    throw productError("state_capacity_exceeded");
  }
  try {
    const reparsed = parseJsonText(serialized, "state.json", STATE_PARSE_OPTIONS);
    if (!KnowledgeScopeStateSchema.safeParse(reparsed).success) throw productError("state_corrupt");
  } catch (error) {
    if (error instanceof KnowledgeScopeProductError && error.code === "json_limits_exceeded") {
      throw productError("state_capacity_exceeded");
    }
    throw error;
  }
  return serialized;
};

const hasCode = (value: unknown, code: string): boolean => {
  if (value === null || typeof value !== "object" || !("code" in value)) return false;
  return value.code === code;
};

const assertOwnerOnly = async (path: string, expectedDirectory: boolean): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    (expectedDirectory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw productError("state_permissions_invalid");
  }
};

const noFollowReadFlags = (): number => {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw productError("state_permissions_invalid");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
};

const readOwnerOnlyFile = async (path: string, maxBytes: number): Promise<string> => {
  let handle;
  try {
    handle = await open(path, noFollowReadFlags());
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw productError("state_permissions_invalid");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw productError("state_permissions_invalid");
    }
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

export class KnowledgeScopeStateStore {
  public readonly home: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly faults: StateStoreFaults | undefined;

  public constructor(options: KnowledgeScopeStateStoreOptions = {}) {
    const environment = options.environment ?? process.env;
    this.home = options.home ?? environment["SCHIFT_KS_HOME"] ?? join(homedir(), ".schift", "knowledge-scope");
    this.statePath = join(this.home, "state.json");
    this.lockPath = join(this.home, "state.lock");
    this.faults = options.faults;
  }

  public async initialize(): Promise<void> {
    const created = await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (created === undefined) await assertOwnerOnly(this.home, true);
    else await chmod(this.home, 0o700);
    try {
      await readOwnerOnlyFile(this.statePath, MAX_STATE_BYTES);
    } catch (error) {
      if (error instanceof KnowledgeScopeProductError && error.code === "json_limits_exceeded") {
        throw productError("state_corrupt");
      }
      if (!hasCode(error, "ENOENT")) throw error;
      await this.createInitialState();
      await readOwnerOnlyFile(this.statePath, MAX_STATE_BYTES);
    }
  }

  private async createInitialState(): Promise<void> {
    const temporaryPath = join(dirname(this.statePath), `.state-init-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serializeState(EMPTY_KNOWLEDGE_SCOPE_STATE), "utf8");
      await handle.sync();
      if (this.faults !== undefined) await this.faults.beforeRename();
      try {
        await link(temporaryPath, this.statePath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        return;
      }
      const directory = await open(this.home, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close();
      await rm(temporaryPath, { force: true });
    }
  }

  public async read(): Promise<KnowledgeScopeState> {
    await this.initialize();
    try {
      const text = await readOwnerOnlyFile(this.statePath, MAX_STATE_BYTES);
      const parsed = parseJsonText(text, "state.json", STATE_PARSE_OPTIONS);
      const result = KnowledgeScopeStateSchema.safeParse(parsed);
      if (!result.success) throw productError("state_corrupt");
      return result.data;
    } catch (error) {
      if (error instanceof KnowledgeScopeProductError && [
        "invalid_json", "duplicate_json_key", "json_limits_exceeded",
      ].includes(error.code)) throw productError("state_corrupt");
      throw error;
    }
  }

  public async transact<T>(update: (state: KnowledgeScopeState) => StateMutation<T>): Promise<T> {
    await this.initialize();
    const lockHandle = await this.acquireLock();
    try {
      const current = await this.read();
      const mutation = update(current);
      await this.writeAtomically(mutation.state);
      return mutation.value;
    } finally {
      await lockHandle.close();
      await rm(this.lockPath, { force: true });
    }
  }

  private async acquireLock(): Promise<Awaited<ReturnType<typeof open>>> {
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      try {
        await readOwnerOnlyFile(this.lockPath, DEFAULT_MAX_JSON_BYTES);
      } catch (lockError) {
        if (lockError instanceof KnowledgeScopeProductError && lockError.code === "json_limits_exceeded") {
          throw productError("lock_conflict");
        }
        if (!hasCode(lockError, "ENOENT")) throw lockError;
      }
      throw productError("lock_conflict");
    }
    try {
      const owner: LockOwner = { pid: process.pid, createdAt: Date.now(), nonce: randomUUID() };
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close();
      await rm(this.lockPath, { force: true });
      throw error;
    }
  }

  private async writeAtomically(state: KnowledgeScopeState): Promise<void> {
    const serialized = serializeState(state);
    const temporaryPath = join(dirname(this.statePath), `.state-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      if (this.faults !== undefined) await this.faults.beforeRename();
      await rename(temporaryPath, this.statePath);
      const directory = await open(this.home, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await chmod(this.statePath, 0o600);
    } finally {
      await handle.close();
      await rm(temporaryPath, { force: true });
    }
  }
}
