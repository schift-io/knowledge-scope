import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const [candidate, expectedVersion] = process.argv.slice(2);
assert.ok(candidate && isAbsolute(candidate), "Pass the exact candidate tarball absolute path");
assert.ok(expectedVersion && expectedVersion !== "0.2.0", "Upgrade requires a new candidate version");
const root = await mkdtemp(join(tmpdir(), "schift-ks-upgrade-"));
const consumer = join(root, "consumer");
const project = join(root, "customer-project");
const source = join(project, "정책 자료");
await mkdir(consumer);
await mkdir(source, { recursive: true });
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
const customerManifest = '{"name":"customer-application","private":true}\n';
await writeFile(join(project, "package.json"), customerManifest);
const document = join(source, "refund.md");
const original = "# Refund policy\nRefunds are allowed within fourteen days.\n환불은 14일 이내 가능합니다.\n";
await writeFile(document, original);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"].includes(key)));
environment.SCHIFT_KS_HOME = join(root, "state");
const packageRoot = join(consumer, "node_modules/@schift-io/knowledge-scope");
const binary = join(packageRoot, "dist/main.js");

function execute(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env: environment, encoding: "utf8", timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command[0]} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const cli = (args) => JSON.parse(execute([process.execPath, binary, ...args], project));
const install = (artifact) => execute([
  "npm", "install", "--registry=https://registry.npmjs.org", "--ignore-scripts",
  "--no-audit", "--no-fund", "--save-exact", artifact,
], consumer);
const manifest = async () => JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const evidence = (result, text) => {
  assert.equal(result.status, "ready");
  assert.ok(result.candidates.length > 0);
  assert.ok(JSON.stringify(result.candidates).includes(text));
};

// Given: a real published installation and customer files created before the upgrade.
install("@schift-io/knowledge-scope@0.2.0");
assert.equal((await manifest()).version, "0.2.0");
const legacy = cli(["quickstart", join(project, "legacy-pack"), "--source", source, "--query", "refund"]);
evidence(legacy.result, "fourteen");
const before = cli(["inspect", legacy.installationId]);
const stateBefore = await readFile(join(environment.SCHIFT_KS_HOME, "state.json"), "utf8");
const baselineLock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
const baselineIntegrity = baselineLock.packages["node_modules/@schift-io/knowledge-scope"].integrity;
assert.match(baselineIntegrity, /^sha512-/);

// When: only the installed package is replaced with the exact release candidate.
install(candidate);
assert.equal((await manifest()).version, expectedVersion);

// Then: old state is unchanged by installation and old queries remain valid.
assert.equal(await readFile(join(environment.SCHIFT_KS_HOME, "state.json"), "utf8"), stateBefore);
assert.deepEqual(cli(["inspect", legacy.installationId]), before);
evidence(cli(["query", legacy.installationId, "--query", "refund"]), "fourteen");
assert.equal(await readFile(document, "utf8"), original);

// New easy-project commands coexist with legacy installations in the same state.
const connected = cli(["connect", source, "--json"]);
assert.equal(typeof connected.installationId, "string");
evidence(cli(["ask", "환불", "--json"]), "14일");
const updated = "# Refund policy\nRefunds are allowed within thirty days.\n환불은 30일 이내 가능합니다.\n";
await writeFile(document, updated);
cli(["refresh", "--json"]);
evidence(cli(["ask", "환불", "--json"]), "30일");
evidence(cli(["query", legacy.installationId, "--query", "refund"]), "fourteen");
assert.deepEqual(cli(["inspect", legacy.installationId]), before);
assert.equal(await readFile(document, "utf8"), updated);
assert.equal(await readFile(join(project, "package.json"), "utf8"), customerManifest);
process.stdout.write(`${JSON.stringify({
  status: "passed", fromVersion: "0.2.0", toVersion: expectedVersion, baselineIntegrity,
  node: process.version, platform: process.platform, architecture: process.arch,
  legacyQueries: "passed", easyProject: "passed", customerFilesPreserved: "passed",
})}\n`);
