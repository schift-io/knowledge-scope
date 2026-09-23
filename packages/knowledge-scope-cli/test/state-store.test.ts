import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { KnowledgeScopeStateStore, MAX_STATE_BYTES } from "../src/state-store.js";

const homes: string[] = [];

const createHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "schift-ks-state-"));
  homes.push(home);
  await chmod(home, 0o700);
  return home;
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("KnowledgeScopeStateStore", () => {
  it("rejects a FIFO state file without waiting for a writer", async () => {
    // Given
    const home = await createHome();
    expect(spawnSync("mkfifo", ["-m", "600", join(home, "state.json")]).status).toBe(0);
    const module = new URL("../src/state-store.ts", import.meta.url).href;
    // When: an external timeout prevents a broken implementation from hanging the suite.
    const child = spawnSync(process.execPath, ["--eval", `import { KnowledgeScopeStateStore } from ${JSON.stringify(module)}; try { await new KnowledgeScopeStateStore({ home: ${JSON.stringify(home)} }).read(); process.exitCode = 1; } catch(error) { console.log(error.code); }`], { timeout: 2000, encoding: "utf8" });
    // Then
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("state_permissions_invalid");
  });
  it("keeps the previous state readable when atomic replacement fails", async () => {
    // Given
    const home = await createHome();
    const stable = new KnowledgeScopeStateStore({ home });
    await stable.initialize();
    const failing = new KnowledgeScopeStateStore({
      home,
      faults: { beforeRename: async () => { throw new Error("injected rename failure"); } },
    });

    // When
    const write = failing.transact((state) => ({
      state: { ...state, revision: state.revision + 1 },
      value: undefined,
    }));

    // Then
    await expect(write).rejects.toThrow("injected rename failure");
    expect((await stable.read()).revision).toBe(0);
  });

  it("maps malformed persistent JSON to a fail-closed state error", async () => {
    // Given
    const home = await createHome();
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    await writeFile(join(home, "state.json"), '{"revision":0,"revision":1}', { mode: 0o600 });

    // When / Then
    await expect(store.read()).rejects.toThrow("state_corrupt");
  });

  it("refuses an existing state home with group permissions", async () => {
    // Given
    const home = await createHome();
    await chmod(home, 0o750);

    // When / Then
    await expect(new KnowledgeScopeStateStore({ home }).initialize())
      .rejects.toThrow("state_permissions_invalid");
  });

  it("fails rather than overwriting state while a live process owns the lock", async () => {
    // Given
    const home = await createHome();
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    await writeFile(join(home, "state.lock"), JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: "live-owner",
    }), { mode: 0o600 });

    // When / Then
    await expect(store.transact((state) => ({ state, value: undefined })))
      .rejects.toThrow("lock_conflict");
  });

  it("leaves a dead-owner lock untouched for manual recovery", async () => {
    // Given
    const home = await createHome();
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    const deadLock = JSON.stringify({
      pid: 2_147_483_647,
      createdAt: Date.now(),
      nonce: "dead-owner",
    });
    await writeFile(join(home, "state.lock"), deadLock, { mode: 0o600 });

    // When / Then
    await expect(store.transact((state) => ({ state, value: undefined })))
      .rejects.toThrow("lock_conflict");
    expect(await Bun.file(join(home, "state.lock")).text()).toBe(deadLock);
    expect((await store.read()).revision).toBe(0);
  });

  it("refuses a recent malformed lock without deleting it", async () => {
    // Given
    const home = await createHome();
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    const lockPath = join(home, "state.lock");
    await writeFile(lockPath, "busy", { mode: 0o600 });

    // When / Then
    await expect(store.transact((state) => ({ state, value: undefined })))
      .rejects.toThrow("lock_conflict");
    expect(await Bun.file(lockPath).text()).toBe("busy");
  });

  it("rejects a symbolic-link state file without following it", async () => {
    // Given
    const home = await createHome();
    const external = join(await createHome(), "external-state.json");
    await writeFile(external, "{}", { mode: 0o600 });
    await symlink(external, join(home, "state.json"));

    // When / Then
    await expect(new KnowledgeScopeStateStore({ home }).initialize())
      .rejects.toThrow("state_permissions_invalid");
  });

  it("rejects a symbolic-link lock without following it", async () => {
    // Given
    const home = await createHome();
    const external = join(await createHome(), "external-lock.json");
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    await writeFile(external, "busy", { mode: 0o600 });
    await symlink(external, join(home, "state.lock"));

    // When / Then
    await expect(store.transact((state) => ({ state, value: undefined })))
      .rejects.toThrow("state_permissions_invalid");
  });

  it("rejects an oversized persisted state from metadata before loading it", async () => {
    // Given
    const home = await createHome();
    const store = new KnowledgeScopeStateStore({ home });
    await store.initialize();
    await truncate(join(home, "state.json"), MAX_STATE_BYTES + 1);

    // When / Then
    await expect(store.read()).rejects.toThrow("state_corrupt");
  });
});
