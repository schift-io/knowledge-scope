import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies, createKnowledgeScopeClient } from "@schift-io/knowledge-scope";
import { KnowledgeScopeDefinitionSchema } from "@schift-io/knowledge-scope/context-pack";

const root = await mkdtemp(join(tmpdir(), "schift-ks-installed-"));
const binary = join(process.cwd(), "node_modules/@schift-io/knowledge-scope/dist/main.js");
const token = "synthetic-release-token-do-not-log";
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/v1/actions/support-search") {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-oo-connector-alias"], "release-account");
    assert.match(request.headers["idempotency-key"], /^ks-/);
    response.end(JSON.stringify({ success: true, message: "ok", data: [{
      resultId: "order-001", revision: "revision-001", freshness: new Date().toISOString(),
      payload: { text: "Synthetic order is shipped" }, citation: { uri: "https://example.test/orders/001" },
    }], meta: { actionId: "support-search", executionId: "release-run", auditPersisted: true } }));
    return;
  }
  assert.equal(request.headers["x-org-id"], "release-organization");
  const bucket = request.url?.split("/")[3];
  if (request.url?.endsWith("/search/status")) {
    response.end(JSON.stringify({ status: "ready", operational_status: "ready", bucket_id: bucket, last_indexed_at: new Date().toISOString() }));
  } else if (request.url?.endsWith("/retrieve")) {
    response.end(JSON.stringify({ status: "ready", operational_status: "ready", bucket_id: bucket, query: "release evidence", results: [{
      chunk_id: "synthetic-chunk", document_id: "synthetic-document", source_id: "synthetic-source",
      text: "Synthetic release evidence", score: 0.98, metadata: { source_url: "https://example.test/release-evidence" },
    }] }));
  } else { response.statusCode = 404; response.end("{}"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing local provider port");
const environment = {
  ...process.env,
  SCHIFT_KS_HOME: join(root, "home"),
  SCHIFT_KS_SEARCH_URL: `http://127.0.0.1:${address.port}`,
  SCHIFT_KS_SEARCH_TOKEN: token,
  SCHIFT_KS_SEARCH_ORGANIZATION_ID: "release-organization",
  SCHIFT_KS_OPEN_CONNECTOR_URL: `http://127.0.0.1:${address.port}`,
  SCHIFT_KS_OPEN_CONNECTOR_TOKEN: token,
  SCHIFT_KS_OPEN_CONNECTOR_SCOPES: "tickets:read",
  SCHIFT_KS_OPEN_CONNECTOR_ALIAS: "release-account",
  SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS: JSON.stringify([
    { connectorRef: "helpdesk", connectorAlias: "release-account", actionId: "support-search" },
  ]),
};

async function execute(args, expectedCode = 0) {
  const child = spawn(process.execPath, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, expectedCode, stderr);
  assert.equal(`${stdout}${stderr}`.includes(token), false);
  return JSON.parse(expectedCode === 0 ? stdout : stderr);
}
const cli = (args, expectedCode = 0) => execute([binary, ...args], expectedCode);

try {
  assert.equal((await cli(["--help"])).bin, "schift-ks");
  const directory = join(root, "project");
  const started = await cli(["quickstart", directory, "--index", "release-index", "--tenant", "release-tenant", "--query", "release evidence"]);
  assert.equal(started.status, "completed");
  assert.equal(started.result.status, "ready");
  const definition = KnowledgeScopeDefinitionSchema.parse(JSON.parse(await readFile(join(directory, "pack/scope.json"), "utf8")));
  assert.equal(definition.packId, "search-project");
  const client = createKnowledgeScopeClient({ application: createCliDependencies({ environment }).embedded });
  const inspection = await client.inspect(started.installationId);
  const result = await client.run({ installationId: started.installationId, operationId: started.operationId,
    effectiveScope: { tenant: "release-tenant" }, input: { query: "release evidence" } });
  assert.equal(result.status, "ready");
  assert.ok(result.candidates.length > 0);
  assert.equal(result.candidates[0].citation.uri, "https://example.test/release-evidence");
  assert.equal((await client.admit({ installationId: started.installationId, candidates: result.candidates })).status, "ready");
  const installedExamples = join(process.cwd(), "node_modules/@schift-io/knowledge-scope/examples");
  assert.equal((await execute([join(installedExamples, "consumer.mjs"), started.installationId, "release-tenant", "release evidence"])).status, "ready");
  await execute([join(installedExamples, "evaluation/run.mjs")]);
  await cli(["doctor", started.installationId]);
  const candidatePath = join(root, "candidates.json");
  await writeFile(candidatePath, JSON.stringify(result.candidates));
  assert.equal((await cli(["unmount", started.installationId, "--expected-revision", String(inspection.mount.revision)])).state, "unmounted");
  assert.equal((await cli(["admit", started.installationId, "--candidate", candidatePath])).status, "insufficient_evidence");
  assert.equal((await cli(["run", started.installationId, "search", "--input", join(directory, "input.json")], 1)).code, "installation_not_mounted");
  assert.equal((await readFile(join(root, "home/state.json"), "utf8")).includes(token), false);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ["/v2/buckets/release-index/search/status", "/v2/buckets/release-index/retrieve"]).flat());

  const batchDirectory = join(root, "batch-pack");
  await cp(join(installedExamples, "support-scope"), batchDirectory, { recursive: true });
  const batchDefinition = JSON.parse(await readFile(join(batchDirectory, "scope.json"), "utf8"));
  batchDefinition.capabilities = batchDefinition.capabilities.filter((capability) => capability.operationId !== "list-orders");
  batchDefinition.contextPolicy.mustConsider = [
    { id: "document-evidence", minEvidence: 1, selector: { sourceClasses: ["document"] } },
    { id: "record-evidence", minEvidence: 1, selector: { sourceClasses: ["records"] } },
  ];
  batchDefinition.evidence.coverageAssertions = ["document-evidence", "record-evidence"];
  await writeFile(join(batchDirectory, "scope.json"), JSON.stringify(batchDefinition));
  const bindings = JSON.parse(await readFile(join(installedExamples, "mount-bindings.json"), "utf8"));
  bindings.scopeAuthority = { organizationId: "release-organization", tenant: "release-tenant" };
  bindings.sourceBindings = bindings.sourceBindings.filter((binding) => binding.sourceId !== "source-orders");
  bindings.sourceBindings.find((binding) => binding.sourceId === "source-helpdesk").sourceClass = "records";
  const bindingPath = join(root, "batch-bindings.json");
  await writeFile(bindingPath, JSON.stringify(bindings));
  await cli(["lock", batchDirectory]);
  const mounted = await cli(["mount", batchDirectory, "--bindings", bindingPath]);
  const batchRequest = { installationId: mounted.installationId,
    effectiveScope: { tenant: "release-tenant" }, expectedRevision: mounted.revision,
    operations: [
      { operationId: "search-handbook", input: { query: "release evidence" } },
      { operationId: "fetch-support", input: { query: "order-001" } },
    ] };
  for (const operation of batchRequest.operations) {
    const single = await client.run({ installationId: mounted.installationId,
      effectiveScope: batchRequest.effectiveScope, ...operation });
    assert.equal(single.status, "insufficient_evidence");
    assert.equal(single.candidates.length, 0);
  }
  const batchResult = await client.runBatch(batchRequest);
  assert.equal(batchResult.status, "ready");
  assert.equal(batchResult.candidates.length, 2);
  const batchInput = join(root, "batch-input.json");
  const { installationId, ...batchBody } = batchRequest;
  await writeFile(batchInput, JSON.stringify(batchBody));
  assert.equal((await cli(["run-batch", installationId, "--input", batchInput])).status, "ready");
  assert.equal((await execute([join(installedExamples, "batch-consumer.mjs"), installationId, batchInput])).status, "ready");
  const restarted = createKnowledgeScopeClient({ application: createCliDependencies({ environment }).embedded });
  assert.equal((await restarted.admit({ installationId, candidates: batchResult.candidates })).status, "ready");
  await cli(["unmount", installationId, "--expected-revision", String(mounted.revision)]);
  assert.equal((await restarted.admit({ installationId, candidates: batchResult.candidates })).status, "insufficient_evidence");
  assert.equal((await cli(["run-batch", installationId, "--input", batchInput], 1)).code, "installation_not_mounted");
  assert.equal((await readFile(join(root, "home/state.json"), "utf8")).includes(token), false);
  process.stdout.write("Installed artifact CLI, SDK, subpath, Search and combined document/record lifecycle passed\n");
} finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
