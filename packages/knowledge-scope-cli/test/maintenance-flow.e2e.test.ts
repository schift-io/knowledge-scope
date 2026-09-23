import { expect, it } from "bun:test";
import { resolve } from "node:path";

it("prunes old copies and recovers legacy locks through independent Node CLI processes", async () => {
  // Given: the same maintenance smoke scenario used against an installed release.
  const script = resolve(import.meta.dir, "../scripts/release-maintenance-smoke.mjs");
  const binary = resolve(import.meta.dir, "../dist/main.js");
  // When: Node drives preview, rejected plans, exact-plan apply, and recovery.
  const child = Bun.spawn(["node", script, binary], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  // Then: the installed-CLI assertions pass and its finally block cleans test-owned data.
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("Installed prune/recover: passed");
}, 120_000);
