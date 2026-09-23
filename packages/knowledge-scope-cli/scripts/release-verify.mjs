import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReleaseInventory } from "./release-inventory.mjs";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "schift-ks-release-"));
const packages = join(workspace, "source", "packages");
const isolated = join(packages, "knowledge-scope-cli");
const output = join(workspace, "artifacts");
const consumer = join(workspace, "consumer");
const runtime = { node: process.version, platform: process.platform, architecture: process.arch };
if (![22, 24].includes(Number(process.versions.node.split(".")[0]))) {
  throw new Error(`Release verification requires supported Node 22 or 24; observed ${process.version}`);
}
// Provider credentials and caller NODE_PATH never enter build/tests or installed probes.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"].includes(key)));
environment["CI"] = "true";

function run(command, cwd, capture = false) {
  process.stderr.write(`release: ${command.join(" ")}\n`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env: environment, encoding: "utf8", timeout: 300_000,
    stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release command failed: ${command[0]} (${result.status})`);
  return result.stdout ?? "";
}

async function copySource(from, to) {
  const metadata = await lstat(from);
  if (metadata.isSymbolicLink()) throw new Error(`Symlink in release source: ${from}`);
  if (metadata.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) {
      if (["node_modules", "dist", ".git", ".DS_Store"].includes(entry)) continue;
      await copySource(join(from, entry), join(to, entry));
    }
  } else if (metadata.isFile()) await cp(from, to);
  else throw new Error(`Unsupported release source: ${from}`);
}

await mkdir(packages, { recursive: true });
await mkdir(output);
await mkdir(consumer);
await mkdir(isolated);
for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.build-context.json", "LICENSE", "README.md", "src", "test", "examples", "docs", "scripts"]) {
  await copySource(join(source, name), join(isolated, name));
}
const contextSource = join(packages, "context-pack", "src");
await mkdir(contextSource, { recursive: true });
for (const name of ["bounded-json", "canonical", "scalars", "knowledge-scope", "knowledge-scope-mount", "knowledge-scope-lock", "knowledge-scope-execution", "knowledge-scope-batch", "knowledge-scope-admission"]) {
  await copySource(join(source, "..", "context-pack", "src", `${name}.ts`), join(contextSource, `${name}.ts`));
}
const contextFixtures = join(packages, "context-pack", "fixtures", "knowledge-scope");
await mkdir(contextFixtures, { recursive: true });
for (const name of ["valid-definition", "valid-mount", "admission-accepted", "schema-files"]) {
  await copySource(
    join(source, "..", "context-pack", "fixtures", "knowledge-scope", `${name}.json`),
    join(contextFixtures, `${name}.json`),
  );
}
// A single isolated dependency tree resolves both sibling source packages without workspace links.
await cp(join(source, "package.json"), join(packages, "package.json"));
await cp(join(source, "package-lock.json"), join(packages, "package-lock.json"));
run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], packages);
const dependencyAudit = JSON.parse(run(["npm", "audit", "--omit=dev", "--workspaces=false", "--json"], packages, true));
if (dependencyAudit.metadata?.vulnerabilities?.total !== 0) {
  throw new Error("Production dependency audit did not report zero vulnerabilities");
}
run(["bun", "run", "build"], isolated);
run(["bun", "run", "typecheck"], isolated);
run(["bun", "test"], isolated);
const packed = JSON.parse(run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", output], isolated, true));
if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Expected exactly one tarball");
const artifact = packed[0];
if (typeof artifact.filename !== "string" || basename(artifact.filename) !== artifact.filename || !Array.isArray(artifact.files)) {
  throw new Error("Malformed npm pack report");
}
const inventory = artifact.files.map((entry) => entry.path);
validateReleaseInventory(inventory);
for (const path of ["dist/main.js", "dist/index.js", "dist/context-pack.js", "dist/types/index.d.ts", "dist/types/context-pack/index.d.ts", "dist/types/context-pack/knowledge-scope-batch.d.ts", "examples/batch-consumer.mjs", "examples/local-documents/support-handbook.md", "README.md", "LICENSE", "docs/PILOT.md"]) {
  if (!inventory.includes(path)) throw new Error(`Required artifact missing: ${path}`);
}
const tarball = join(output, artifact.filename);
const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
await writeFile(join(output, "SHA256SUMS"), `${sha256}  ${artifact.filename}\n`);
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball], consumer);
await cp(join(isolated, "scripts", "release-smoke.mjs"), join(consumer, "smoke.mjs"));
run([process.execPath, "smoke.mjs"], consumer);
await cp(join(isolated, "scripts", "release-local-smoke.mjs"), join(consumer, "local-smoke.mjs"));
run([process.execPath, "local-smoke.mjs"], consumer);
await cp(join(isolated, "scripts", "release-easy-smoke.mjs"), join(consumer, "easy-smoke.mjs"));
run([process.execPath, "easy-smoke.mjs"], consumer);
await cp(join(isolated, "scripts", "release-maintenance-smoke.mjs"), join(consumer, "maintenance-smoke.mjs"));
run([process.execPath, "maintenance-smoke.mjs"], consumer);
await cp(join(isolated, "scripts", "release-crash-smoke.mjs"), join(consumer, "crash-smoke.mjs"));
run([process.execPath, "crash-smoke.mjs"], consumer);
await cp(join(isolated, "scripts", "release-upgrade-smoke.mjs"), join(consumer, "upgrade-smoke.mjs"));
const candidateManifest = JSON.parse(await readFile(join(isolated, "package.json"), "utf8"));
const upgradeSmoke = JSON.parse(run([process.execPath, "upgrade-smoke.mjs", tarball, candidateManifest.version], consumer, true));
await writeFile(join(consumer, "consumer.mts"), `
import { createCliDependencies, createKnowledgeScopeClient } from "@schift-io/knowledge-scope";
import { InstallationIdSchema, CapabilityBatchExecutionRequestSchema } from "@schift-io/knowledge-scope/context-pack";
const client = createKnowledgeScopeClient({ application: createCliDependencies().embedded });
const installation = InstallationIdSchema.parse("scope-installation");
void client.inspect(installation);
void client.runBatch(CapabilityBatchExecutionRequestSchema.parse({
  installationId: installation, effectiveScope: { tenant: "release-tenant" },
  operations: [{ operationId: "search-handbook", input: { query: "evidence" } }],
}));
`);
run([process.execPath, join(packages, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.mts"], consumer);
const report = { status: "verified", runtime, artifact: tarball, sha256, files: inventory,
  dependencyAudit: dependencyAudit.metadata, installedSmoke: "passed", localFirstUseSmoke: "passed",
  easyProjectSmoke: "passed", maintenanceSmoke: "passed", crashRecoverySmoke: "passed", upgradeSmoke, isolatedSource: isolated };
await writeFile(join(output, "release-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
