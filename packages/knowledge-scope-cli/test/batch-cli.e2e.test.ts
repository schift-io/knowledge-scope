import { expect, it } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KnowledgeScopeDefinitionSchema } from "../src/context-pack.js";
import { requireObject, startProviderServer, SENTINEL_TOKEN } from "./fixtures/cli-e2e-harness.js";
import { parseJsonText } from "../src/json.js";

const setup = async () => {
  const server = startProviderServer();
  const root = await mkdtemp(join(tmpdir(), "ks-batch-cli-"));
  const portable = join(root, "portable");
  await cp(join(import.meta.dir, "fixtures/full-scope"), portable, { recursive: true });
  const bindings = join(root, "bindings.json");
  await cp(join(portable, "bindings.json"), bindings);
  await rm(join(portable, "bindings.json"));
  const path = join(portable, "scope.json");
  const definition = KnowledgeScopeDefinitionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  await writeFile(path, JSON.stringify({ ...definition, contextPolicy: { ...definition.contextPolicy,
    mustConsider: definition.contextPolicy.mustConsider.map((requirement) => ({ ...requirement, minEvidence: 2 })) } }));
  const environment = {
    ...process.env, SCHIFT_KS_HOME: join(root, "home"),
    SCHIFT_KS_OPEN_CONNECTOR_READ_ACTIONS: JSON.stringify([{ connectorRef: "helpdesk", connectorAlias: "helpdesk", actionId: "support-search" }]),
    SCHIFT_KS_OPEN_CONNECTOR_SCOPES: "tickets:read", SCHIFT_KS_OPEN_CONNECTOR_TOKEN: SENTINEL_TOKEN,
    SCHIFT_KS_OPEN_CONNECTOR_URL: server.baseUrl, SCHIFT_KS_SEARCH_URL: server.baseUrl,
    SCHIFT_KS_SEARCH_TOKEN: SENTINEL_TOKEN, SCHIFT_KS_SEARCH_ORGANIZATION_ID: "acme-org", SCHIFT_KS_SEARCH_SCOPES: "search:read",
  };
  const cli = async (args: readonly string[]) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), ...args], { env: environment, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const locked = await cli(["lock", portable]);
  expect(locked.code).toBe(0);
  const mounted = await cli(["mount", portable, "--bindings", bindings]);
  expect(mounted.code).toBe(0);
  const installationId = requireObject(parseJsonText(mounted.stdout, "mount"))["installationId"];
  if (typeof installationId !== "string") throw new TypeError("Missing installation ID");
  return { root, cli, installationId, server, cleanup: async () => { server.stop(); await rm(root, { recursive: true, force: true }); } };
};

it("CLI combines real HTTP provider evidence, persists across processes, and denies after unmount", async () => {
  // Given: each provider alone cannot satisfy the two-evidence requirement.
  const workspace = await setup();
  try {
    const single = join(workspace.root, "single.json");
    await writeFile(single, JSON.stringify({ effectiveScope: { tenant: "acme" }, input: { query: "refund" } }));
    for (const operation of ["fetch-support", "search-handbook"]) {
      const individual = await workspace.cli(["run", workspace.installationId, operation, "--input", single]);
      expect(individual.code).toBe(0);
      expect(requireObject(parseJsonText(individual.stdout, "single"))["status"]).toBe("insufficient_evidence");
    }
    const input = join(workspace.root, "batch.json");
    await writeFile(input, JSON.stringify({ effectiveScope: { tenant: "acme" }, expectedRevision: 1,
      operations: ["fetch-support", "search-handbook"].map((operationId) => ({ operationId, input: { query: "refund" } })) }));
    // When: every invocation starts a fresh CLI process over the persisted state.
    const result = await workspace.cli(["run-batch", workspace.installationId, "--input", input]);
    // Then
    expect(result.code).toBe(0);
    const output = requireObject(parseJsonText(result.stdout, "batch"));
    expect(output["status"]).toBe("ready");
    expect(output["candidates"]).toHaveLength(2);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL_TOKEN);
    expect((await workspace.cli(["unmount", workspace.installationId, "--expected-revision", "1"])).code).toBe(0);
    const denied = await workspace.cli(["run-batch", workspace.installationId, "--input", input]);
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe("");
  } finally { await workspace.cleanup(); }
}, 30_000);

it("CLI validates the second operation before any real HTTP provider dispatch", async () => {
  // Given
  const workspace = await setup();
  try {
    const input = join(workspace.root, "bad-batch.json");
    await writeFile(input, JSON.stringify({ effectiveScope: { tenant: "acme" }, operations: [
      { operationId: "fetch-support", input: { query: "refund" } }, { operationId: "search-handbook", input: { wrong: true } },
    ] }));
    // When
    const result = await workspace.cli(["run-batch", workspace.installationId, "--input", input]);
    // Then
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(workspace.server.requests).toHaveLength(0);
  } finally { await workspace.cleanup(); }
}, 30_000);
