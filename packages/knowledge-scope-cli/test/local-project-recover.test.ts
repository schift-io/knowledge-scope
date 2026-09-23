import { afterEach, expect, it } from "bun:test";
import { link, lstat, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCliDependencies } from "../src/main.js";
import { connectLocalProject, refreshLocalProject } from "../src/local-project.js";
import { recoverLocalProject } from "../src/local-project-recover.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-recover-")); roots.push(root);
  const source = join(root, "notes.md"); const directory = join(root, "project"); const home = join(root, "state");
  await writeFile(source, "Refunds within seven days.");
  const dependencies = createCliDependencies({ home, environment: {} });
  await connectLocalProject({ source, directory }, dependencies);
  return { root, source, directory, home, dependencies, lock: join(directory, ".project.lock"), stateLock: join(home, "state.lock") };
};
const legacy = async (path: string, text = "") => { await rmdir(path); await writeFile(path, text, { mode: 0o600 }); };
const token = (value: unknown): string => z.object({ plan: z.string() }).parse(value).plan;

it("previews a legacy empty lock without changing files", async () => {
  // Given
  const f = await fixture(); await legacy(f.lock); const before = await readdir(f.directory);
  // When
  const result = await recoverLocalProject({ directory: f.directory }, f.dependencies);
  // Then
  expect(result).toMatchObject({ status: "recovery_preview", requiresQuiescence: true });
  expect(await readFile(f.lock, "utf8")).toBe(""); expect(await readdir(f.directory)).toEqual(before);
});
it("requires an explicit quiescence assertion on apply", async () => {
  // Given
  const f = await fixture(); await legacy(f.lock); const plan = token(await recoverLocalProject({ directory: f.directory }, f.dependencies));
  // When / Then
  await expect(recoverLocalProject({ directory: f.directory, apply: true, plan }, f.dependencies)).rejects.toThrow("recover_quiescence_required");
});
it("rejects a changed preview token without moving locks", async () => {
  // Given
  const f = await fixture(); await legacy(f.lock);
  // When / Then
  await expect(recoverLocalProject({ directory: f.directory, apply: true, plan: "obsolete", quiesced: true }, f.dependencies)).rejects.toThrow("recover_plan_changed");
  expect((await lstat(f.lock)).isFile()).toBe(true);
});
it("refuses a live legacy writer even when quiescence is asserted", async () => {
  // Given
  const f = await fixture(); await legacy(f.stateLock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: "owner" }));
  // When / Then
  await expect(recoverLocalProject({ directory: f.directory, apply: true, plan: "ignored", quiesced: true }, f.dependencies)).rejects.toThrow("recover_live_writer");
});
it("quarantines dead legacy locks and allows a new refresh", async () => {
  // Given
  const f = await fixture(); await legacy(f.lock); const stateText = JSON.stringify({ pid: 2147483647, createdAt: Date.now(), nonce: "dead" });
  await legacy(f.stateLock, stateText); const plan = token(await recoverLocalProject({ directory: f.directory }, f.dependencies));
  // When
  const result = z.object({ status: z.string(), quarantined: z.array(z.object({ original: z.string(), quarantine: z.string() })) }).parse(
    await recoverLocalProject({ directory: f.directory, apply: true, plan, quiesced: true }, f.dependencies));
  // Then
  expect(result.status).toBe("recovered"); expect(result.quarantined).toHaveLength(2);
  for (const entry of result.quarantined) expect(await readFile(entry.quarantine, "utf8")).toBe(entry.original.endsWith("state.lock") ? stateText : "");
  expect((await lstat(f.lock)).isDirectory()).toBe(true); expect((await lstat(f.stateLock)).isDirectory()).toBe(true);
  expect(await refreshLocalProject({ directory: f.directory }, f.dependencies)).toMatchObject({ status: "refreshed" });
  expect(await readFile(f.source, "utf8")).toBe("Refunds within seven days.");
});
it("keeps healthy directory sentinels unchanged", async () => {
  // Given
  const f = await fixture(); const before = await lstat(f.lock); const plan = token(await recoverLocalProject({ directory: f.directory }, f.dependencies));
  // When
  const result = await recoverLocalProject({ directory: f.directory, apply: true, plan, quiesced: true }, f.dependencies);
  // Then
  expect(result).toMatchObject({ status: "recovered", quarantined: [] }); expect((await lstat(f.lock)).ino).toBe(before.ino);
});
for (const kind of ["symlink", "hardlink", "malformed"] as const) it(`rejects ${kind} locks`, async () => {
  // Given
  const f = await fixture(); await rmdir(f.lock); const target = join(f.root, "outside"); await writeFile(target, "", { mode: 0o600 });
  if (kind === "symlink") await symlink(target, f.lock);
  else if (kind === "hardlink") await link(target, f.lock);
  else await writeFile(f.lock, "unknown", { mode: 0o600 });
  // When / Then
  await expect(recoverLocalProject({ directory: f.directory }, f.dependencies)).rejects.toThrow("recover_unsafe");
  expect(await readFile(target, "utf8")).toBe("");
});
