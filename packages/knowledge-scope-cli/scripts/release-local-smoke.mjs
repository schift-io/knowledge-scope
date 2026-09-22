import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies, createKnowledgeScopeClient } from "@schift-io/knowledge-scope";

const root = await mkdtemp(join(tmpdir(), "schift-ks-local-installed-"));
const packageRoot = join(process.cwd(), "node_modules/@schift-io/knowledge-scope");
const binary = join(packageRoot, "dist/main.js");
const source = join(root, "refund-policy.md");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"].includes(key)));
environment.SCHIFT_KS_HOME = join(root, "state");
const content = "# Refund policy\nRefunds are accepted within fourteen days.\n환불은 구매 후 14일 이내에 가능합니다.\n";
await writeFile(source, content, { mode: 0o600 });

function command(args, expectedCode = 0) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: environment, encoding: "utf8", timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedCode, result.stderr);
  return JSON.parse(expectedCode === 0 ? result.stdout : result.stderr);
}

const directory = join(root, "project");
const started = command(["quickstart", directory, "--source", source, "--query", "환불"]);
assert.equal(started.result.status, "ready");
assert.equal(typeof started.installationId, "string");
assert.equal(command(["query", started.installationId, "--query", "refund"]).status, "ready");
assert.equal(command(["query", started.installationId, "--query", "astronaut"]).status, "insufficient_evidence");
assert.equal(command(["doctor", started.installationId, "--probe", "--query", "refund"]).result.status, "ready");

globalThis.fetch = async () => { throw new Error("Local SDK must not make network requests"); };
const client = createKnowledgeScopeClient({ application: createCliDependencies({ environment }).embedded });
const request = { installationId: started.installationId, operationId: "search", effectiveScope: { tenant: "local-tenant" }, input: { query: "refund" } };
const result = await client.run(request);
assert.equal(result.status, "ready");
assert.ok(result.candidates.length > 0);
assert.match(result.candidates[0].citation.uri, /^schift:\/\/local-documents\/.+#L\d+/);
assert.match(result.candidates[0].citation.label, /refund-policy\.md:L\d+/);
assert.equal(result.candidates[0].payload.sourcePath, await realpath(source));
assert.equal(result.candidates[0].providerEvidence.kind, "local_documents");
assert.equal((await client.admit({ installationId: started.installationId, candidates: result.candidates })).status, "ready");
await assert.rejects(client.run({ ...request, effectiveScope: { tenant: "another-project" } }));
await assert.rejects(client.run({ ...request, effectiveScope: { tenant: "local-tenant", namespace: "unimplemented" } }));
const portableDefinition = await readFile(join(directory, "pack/scope.json"), "utf8");
assert.equal(portableDefinition.includes(source), false);
assert.equal(portableDefinition.includes("fourteen days"), false);

// Rewriting the original does not rewrite an already-approved snapshot.
await writeFile(source, "# Replacement\nWarranty lasts two years.\n", { mode: 0o600 });
const originalSnapshot = await client.run(request);
assert.equal(originalSnapshot.status, "ready");
assert.equal(originalSnapshot.candidates[0].revision, result.candidates[0].revision);
const refreshed = command(["quickstart", join(root, "refreshed"), "--source", source, "--query", "warranty"]);
assert.equal(refreshed.result.status, "ready");
assert.notEqual(refreshed.installationId, started.installationId);

const inspection = await client.inspect(started.installationId);
assert.equal(command(["unmount", started.installationId, "--expected-revision", String(inspection.mount.revision)]).state, "unmounted");
assert.equal((await client.admit({ installationId: started.installationId, candidates: result.candidates })).status, "insufficient_evidence");
await assert.rejects(client.run(request));

const sample = command(["quickstart", join(root, "sample"), "--source", join(packageRoot, "examples/local-documents/support-handbook.md"), "--query", "환불"]);
assert.equal(sample.result.status, "ready");
process.stdout.write(`${JSON.stringify({ status: "passed", localFirstUse: "passed", restartedSdk: "passed", snapshotIsolation: "passed", revokedMount: "passed", shippedSample: "passed" })}\n`);
