import { expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { askLocalProject, connectLocalProject, refreshLocalProject } from "../src/local-project.js";

it("restores a quiesced project and runtime backup into isolated local paths", async () => {
  // Given: a complete project, with no writers running during the backup.
  const root = await mkdtemp(join(tmpdir(), "ks-restore-"));
  const source = join(root, "notes.md"); const directory = join(root, "project");
  const home = join(root, "state"); const restoredRoot = join(root, "restored");
  await writeFile(source, "Refund requests must arrive within fourteen days.\n");
  const original = createCliDependencies({ home, environment: {} });
  await connectLocalProject({ directory, source }, original);
  await mkdir(restoredRoot, { mode: 0o700 });
  try {
    // When: the operator restores both private directories, not just a portable Pack.
    const restoredProject = join(restoredRoot, "project"); const restoredHome = join(restoredRoot, "state");
    await cp(directory, restoredProject, { recursive: true, preserveTimestamps: true });
    await cp(home, restoredHome, { recursive: true, preserveTimestamps: true });
    const restored = createCliDependencies({ home: restoredHome, environment: {} });
    const result = await askLocalProject({ directory: restoredProject, query: "Refund" }, restored);
    // Then: evidence and future updates work without touching the original state.
    expect(result).toMatchObject({ status: "ready" });
    expect(JSON.stringify(result)).toContain("fourteen days");
    const before = await readFile(join(home, "state.json"), "utf8");
    await refreshLocalProject({ directory: restoredProject }, restored);
    expect(await readFile(join(home, "state.json"), "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
