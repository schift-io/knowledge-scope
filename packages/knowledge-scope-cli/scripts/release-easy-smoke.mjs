import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = join(dirname(fileURLToPath(import.meta.resolve("@schift-io/knowledge-scope"))), "main.js");
const workspace = await mkdtemp(join(tmpdir(), "ks-installed-easy-"));
const source = join(workspace, "고객 자료");
await mkdir(source);
await writeFile(join(source, "policy.md"), "환불은 구매 후 14일 이내 가능합니다.\n배송은 3일 걸립니다.\n");
const manifest = '{"name":"customer-application","private":true}\n';
await writeFile(join(workspace, "package.json"), manifest);

function run(args, expectedExit = 0) {
  const output = spawnSync(process.execPath, [binary, ...args], {
    cwd: workspace,
    env: { ...process.env, SCHIFT_KS_HOME: join(workspace, "private-state") },
    encoding: "utf8", timeout: 30_000,
  });
  if (output.error) throw output.error;
  assert.equal(output.status, expectedExit, output.stderr);
  return output.stdout;
}

const first = JSON.parse(run(["connect", source, "--json"]));
assert.equal(typeof first.installationId, "string");
const reused = JSON.parse(run(["connect", source, "--json"]));
assert.equal(reused.installationId, first.installationId);
const result = JSON.parse(run(["ask", "환불", "--json"]));
assert.equal(result.status, "ready");
assert.ok(JSON.stringify(result.candidates).includes("14일"));
assert.ok(JSON.stringify(result.candidates).includes("schift://local-documents/"));
assert.ok(run(["ask", "배송"]).includes("policy.md"));
const unsupported = JSON.parse(run(["ask", "우주비행사", "--json"]));
assert.equal(unsupported.status, "insufficient_evidence");
assert.deepEqual(unsupported.candidates, []);

await writeFile(join(source, "policy.md"), "환불은 구매 후 30일 이내 가능합니다.\n");
const refreshed = JSON.parse(run(["refresh", "--json"]));
assert.notEqual(refreshed.installationId, first.installationId);
const current = JSON.parse(run(["ask", "환불", "--json"]));
assert.ok(JSON.stringify(current.candidates).includes("30일"));
assert.ok(!JSON.stringify(current.candidates).includes("14일"));

await writeFile(join(source, "policy.md"), "");
run(["refresh", "--json"], 1);
const retained = JSON.parse(run(["ask", "환불", "--json"]));
assert.ok(JSON.stringify(retained.candidates).includes("30일"));
assert.equal(await readFile(join(workspace, "package.json"), "utf8"), manifest);
process.stdout.write("Installed connect/ask/refresh: passed; application dependencies unchanged.\n");
