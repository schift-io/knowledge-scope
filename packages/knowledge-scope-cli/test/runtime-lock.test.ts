import { afterAll, expect, it } from "bun:test";
import { mkdtemp, rm, lstat, readdir, mkdir, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProjectLock } from "../src/local-project-files.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import { localGuardPort, withLocalLock } from "../src/local-lock.js";

const homes: string[] = [];
const home = async (): Promise<string> => { const path = await mkdtemp(join(tmpdir(), "ks-lock-proof-")); homes.push(path); return path; };
const nodeModules = async (): Promise<string> => {
  const directory = await home();
  const result = await Bun.build({ entrypoints: ["local-project-files", "state-store"].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname), tsconfig: new URL("../tsconfig.json", import.meta.url).pathname, root: new URL("../src", import.meta.url).pathname, outdir: directory, target: "node", format: "esm", naming: "[name].mjs" });
  if (!result.success || result.outputs[0] === undefined) throw new Error(`Node fixture build failed: ${result.logs.join("; ")}`);
  return directory;
};
const fixtureModules = nodeModules();
const nodeModule = async (name: string): Promise<string> => new URL(`file://${join(await fixtureModules, `${name}.mjs`)}`).href;
const waitForReady = async (child: Bun.Subprocess<"ignore", "pipe", "pipe">, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const ready = await reader.read();
        if (!new TextDecoder().decode(ready.value).includes("ready")) {
          child.kill("SIGKILL");
          throw new Error(`Node lock fixture exited before ready: ${await new Response(child.stderr).text()}`);
        }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Node lock fixture ready timeout")); }, 3000); }),
    ]);
  } finally { clearTimeout(timer); }
};
afterAll(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("separates nested state and project guards even when their hash values collide", () => {
  // Given / When: every possible low-bit bucket plus the largest unsigned hash.
  const separated = [...Array.from({ length: 32768 }, (_, index) => index), 0xffffffff].every((hash) => {
    const state = localGuardPort("state.lock", hash);
    const project = localGuardPort(".project.lock", hash);
    // Then: disjoint bands prevent permanent self-conflict during nested writes.
    return state >= 16384 && state < 32768 && project >= 1024 && project < 16384;
  });
  expect(separated).toBe(true);
});

it("releases project exclusion when its real owner is killed", async () => {
  // Given: a child owns the actual project lock, with an event-driven ready signal.
  const directory = await home();
  const module = await nodeModule("local-project-files");
  const child = Bun.spawn(["node", "--input-type=module", "--eval", `import { withProjectLock } from ${JSON.stringify(module)}; await withProjectLock(${JSON.stringify(directory)}, async () => { console.log('ready'); await new Promise(() => {}); });`], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    await waitForReady(child, reader);
    await expect(withProjectLock(directory, async () => true)).rejects.toThrow("project_busy");
    // When
    child.kill("SIGKILL"); await child.exited;
    // Then
    expect(await withProjectLock(directory, async () => "recovered")).toBe("recovered");
    expect((await lstat(join(directory, ".project.lock"))).isDirectory()).toBe(true);
  } finally { reader.releaseLock(); child.kill(); await child.exited; }
});

it("holds state exclusion through asynchronous maintenance and preserves permanent marker", async () => {
  // Given
  const directory = await home(); const store = new KnowledgeScopeStateStore({ home: directory });
  // When
  await store.withMaintenance(async (state, persist) => {
    await expect(store.transact((current) => ({ state: current, value: undefined }))).rejects.toThrow("lock_conflict");
    await persist({ ...state, revision: 1 });
  });
  // Then
  expect((await store.read()).revision).toBe(1);
  expect(await readdir(join(directory, "state.lock"))).toEqual([]);
});

it("recovers state mutations after a real writer is killed before its commit", async () => {
  // Given
  const directory = await home(); const store = new KnowledgeScopeStateStore({ home: directory }); await store.initialize();
  const module = await nodeModule("state-store");
  const child = Bun.spawn(["node", "--input-type=module", "--eval", `import { KnowledgeScopeStateStore } from ${JSON.stringify(module)}; await new KnowledgeScopeStateStore({ home: ${JSON.stringify(directory)}, faults: { beforeRename: async () => { console.log('ready'); await new Promise(() => {}); } } }).transact(state => ({ state: { ...state, revision: 1 }, value: null }));`], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    await waitForReady(child, reader);
    // When
    child.kill("SIGKILL"); await child.exited;
    // Then
    expect((await store.read()).revision).toBe(0);
    await store.transact((state) => ({ state: { ...state, revision: 2 }, value: undefined }));
    expect((await store.read()).revision).toBe(2);
  } finally { reader.releaseLock(); child.kill(); await child.exited; }
});

it("uses one exclusion domain for canonical and system-aliased paths", async () => {
  // Given
  const directory = await home(); const canonical = await realpath(directory);
  // When / Then
  await withLocalLock(join(directory, "guard"), async () => {
    await expect(withLocalLock(join(canonical, "guard"), async () => true)).rejects.toThrow("busy");
  });
});

it("refuses populated and symlink lock markers without removing their contents", async () => {
  // Given
  const directory = await home(); const marker = join(directory, "guard");
  await mkdir(marker, { mode: 0o700 }); await writeFile(join(marker, "foreign"), "preserved");
  const alias = join(directory, "alias"); await symlink(marker, alias);
  // When / Then
  await expect(withLocalLock(marker, async () => true)).rejects.toThrow("invalid");
  await expect(withLocalLock(alias, async () => true)).rejects.toThrow("invalid");
  expect(await readdir(marker)).toEqual(["foreign"]);
});
