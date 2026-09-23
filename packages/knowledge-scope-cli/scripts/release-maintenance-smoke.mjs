import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.resolve("@schift-io/knowledge-scope"))), "main.js");
const workspace = await realpath(await mkdtemp(join(tmpdir(), "ks-installed-maintenance-")));
const source = join(workspace, "policy.md");
const home = join(workspace, "private-state");
const project = join(workspace, ".schift-ks");
function run(args, expectedExit = 0) {
  const output = spawnSync(process.execPath, [binary, ...args, "--json"], {
    cwd: workspace, env: { ...process.env, SCHIFT_KS_HOME: home }, encoding: "utf8", timeout: 30_000,
  });
  if (output.error) throw output.error;
  assert.equal(output.status, expectedExit, output.stderr || output.stdout);
  return JSON.parse(expectedExit === 0 ? output.stdout : output.stderr);
}
try {
  // Given: three independently captured revisions of explicitly selected notes.
  await writeFile(source, "Refund policy: 14 days.\n");
  run(["connect", source]);
  await writeFile(source, "Refund policy: 30 days.\n"); run(["refresh"]);
  await writeFile(source, "Refund policy: 60 days.\n"); run(["refresh"]);
  const stateBefore = await readFile(join(home, "state.json"), "utf8");
  const filesBefore = (await readdir(project)).sort();
  // When: preview, reject a mismatched plan, then apply exactly the reviewed plan.
  const preview = run(["prune", "--keep", "1"]);
  assert.equal(preview.status, "preview");
  assert.equal(preview.obsoleteInstallations.length, 2);
  assert.equal(await readFile(join(home, "state.json"), "utf8"), stateBefore);
  assert.deepEqual((await readdir(project)).sort(), filesBefore);
  assert.equal(run(["prune", "--keep", "1", "--apply", "--plan", "wrong"], 1).code, "prune_plan_changed");
  const applied = run(["prune", "--keep", "1", "--apply", "--plan", preview.plan]);
  // Then: only old local copies disappear, and current evidence remains usable.
  assert.equal(applied.status, "pruned");
  for (const path of [...preview.snapshotDirectories, ...preview.snapshots.map(item => item.path)]) {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  }
  assert.equal(await readFile(source, "utf8"), "Refund policy: 60 days.\n");
  assert.ok(JSON.stringify(run(["ask", "refund"]).candidates).includes("60 days"));

  // Given: a stopped child supplies a genuinely exited PID for private legacy fixtures.
  const stopped = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
  assert.equal(stopped.status, 0);
  assert.throws(() => process.kill(stopped.pid, 0), { code: "ESRCH" });
  const projectLock = join(project, ".project.lock"); const stateLock = join(home, "state.lock");
  await rmdir(projectLock); await rmdir(stateLock); // Only empty markers inside this test's mkdtemp root.
  const owner = JSON.stringify({ pid: stopped.pid, createdAt: Date.now(), nonce: "maintenance-smoke" });
  await writeFile(projectLock, "", { mode: 0o600 }); await writeFile(stateLock, owner, { mode: 0o600 });
  const stateForRecovery = await readFile(join(home, "state.json"), "utf8");
  // When: preview recovery and require the explicit quiescence acknowledgement.
  const recovery = run(["recover"]);
  assert.equal(recovery.status, "recovery_preview");
  assert.equal(await readFile(projectLock, "utf8"), "");
  assert.equal(await readFile(stateLock, "utf8"), owner);
  assert.equal(run(["recover", "--apply", "--plan", recovery.plan], 1).code, "argument_invalid");
  const recovered = run(["recover", "--apply", "--plan", recovery.plan, "--quiesced"]);
  // Then: quarantine preserves the legacy markers without deleting state or current evidence.
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.quarantined.length, 2);
  for (const item of recovered.quarantined) {
    assert.equal(await readFile(item.quarantine, "utf8"), item.original === projectLock ? "" : owner);
    assert.ok((await lstat(item.original)).isDirectory());
  }
  assert.equal(await readFile(join(home, "state.json"), "utf8"), stateForRecovery);
  assert.ok(JSON.stringify(run(["ask", "refund"]).candidates).includes("60 days"));
  process.stdout.write("Installed prune/recover: passed; current evidence and source retained.\n");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
