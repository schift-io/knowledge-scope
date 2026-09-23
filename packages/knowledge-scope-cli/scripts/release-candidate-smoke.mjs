import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const [tarball, version] = process.argv.slice(2);
assert.ok(tarball && isAbsolute(tarball), "Pass the exact candidate tarball absolute path");
assert.ok(version, "Pass the expected candidate version");
assert.ok([22, 24].includes(Number(process.versions.node.split(".")[0])), "Supported Node 22 or 24 required");
const consumer = await mkdtemp(join(tmpdir(), "schift-ks-candidate-"));
const scripts = dirname(fileURLToPath(import.meta.url));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"].includes(key)));
environment.PATH = `${dirname(process.execPath)}${delimiter}${environment.PATH ?? ""}`;

function run(command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: consumer, env: environment, encoding: "utf8", timeout: 300_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball]);
const installed = JSON.parse(await readFile(join(consumer, "node_modules/@schift-io/knowledge-scope/package.json"), "utf8"));
assert.equal(installed.version, version);
const checks = {};
for (const name of ["release-smoke.mjs", "release-local-smoke.mjs", "release-easy-smoke.mjs", "release-maintenance-smoke.mjs", "release-crash-smoke.mjs", "release-upgrade-smoke.mjs"]) {
  await cp(join(scripts, name), join(consumer, name));
  checks[name] = run([process.execPath, name, ...(name === "release-upgrade-smoke.mjs" ? [tarball, version] : [])]).trim();
}
const audit = JSON.parse(run(["npm", "audit", "--omit=dev", "--workspaces=false", "--json"]));
assert.equal(audit.metadata.vulnerabilities.total, 0);
process.stdout.write(`${JSON.stringify({
  status: "passed", version, node: process.version, platform: process.platform, architecture: process.arch,
  sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
  checks, dependencyAudit: audit.metadata,
}, null, 2)}\n`);
