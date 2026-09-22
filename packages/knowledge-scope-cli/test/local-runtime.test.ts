import { expect, it } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDependencies } from "../src/main.js";
import { localQuickstart } from "../src/local-quickstart.js";
import { createKnowledgeScopeClient } from "../src/client.js";
import { createRemoteKnowledgeScopeApplication, serveKnowledgeScopeApi } from "../src/api.js";
import { KnowledgeScopeApplication } from "../src/application.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import { KnowledgeScopeAuthorization } from "../src/authorization.js";
import { LocalDocumentStore } from "../src/local-documents/index.js";
import { runKnowledgeScopeCli } from "../src/cli.js";
import { requireObject } from "./fixtures/cli-e2e-harness.js";

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-local-runtime-"));
  const source = join(root, "policy.md");
  const home = join(root, "state");
  await writeFile(source, "# Refunds\nRefunds are available within fourteen days.\n");
  const dependencies = createCliDependencies({ home, environment: {} });
  const output = requireObject(await localQuickstart({ directory: join(root, "project"), source, tenant: "local-tenant", query: "refunds" }, dependencies));
  const installationId = output["installationId"];
  if (typeof installationId !== "string") throw new TypeError("Missing installation");
  const request = { installationId, operationId: "search", effectiveScope: { tenant: "local-tenant" }, input: { query: "refunds" } };
  return { home, dependencies, request };
};

it("withholds local evidence after its captured freshness expires", async () => {
  // Given
  const { home, dependencies, request } = await setup();
  const original = await createKnowledgeScopeClient({ application: dependencies.embedded }).run(request);
  const capturedAt = original.candidates[0]?.freshness;
  if (capturedAt === undefined) throw new TypeError("Missing freshness");
  const application = new KnowledgeScopeApplication({
    store: new KnowledgeScopeStateStore({ home }), authorization: new KnowledgeScopeAuthorization({ home }),
    provider: new LocalDocumentStore({ home }), now: () => new Date(Date.parse(capturedAt) + 86_401_000),
  });
  // When
  const stale = await application.run(request);
  // Then
  expect(stale).toMatchObject({ status: "insufficient_evidence", candidates: [] });
});

it("uses the local evidence through authenticated HTTP and returns actionable scope errors", async () => {
  // Given
  const { dependencies, request } = await setup();
  const apiToken = "synthetic-local-runtime-test";
  const server = await serveKnowledgeScopeApi({ application: dependencies.embedded, mountAuthority: { organizationId: "local-organization", tenant: "local-tenant" }, apiToken, port: 0 });
  const url = `http://${server.host}:${server.port}`;
  const remote = createRemoteKnowledgeScopeApplication(url, globalThis.fetch, apiToken);
  try {
    // When
    const result = await createKnowledgeScopeClient({ application: remote }).run(request);
    const denied = await globalThis.fetch(`${url}/v1/knowledge-scopes/mounts/${request.installationId}/capabilities/search:run`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ effectiveScope: { tenant: "local-tenant", namespace: "unsupported" }, input: request.input }),
    });
    // Then
    expect(result.status).toBe("ready");
    expect(result.candidates[0]?.providerEvidence.kind).toBe("local_documents");
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ status: "error", code: "local_scope_invalid" });
  } finally { server.stop(); }
});

it("returns a redacted local error on repeat query when snapshot permissions become unsafe", async () => {
  // Given
  const { home, dependencies, request } = await setup();
  await chmod(join(home, "local-documents"), 0o755);
  const output: string[] = []; const errors: string[] = [];
  try {
    // When
    const exitCode = await runKnowledgeScopeCli(["query", request.installationId, "--query", "refunds"], dependencies, {
      stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    });
    // Then
    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([JSON.stringify({ code: "local_snapshot_invalid", status: "error" })]);
  } finally { await chmod(join(home, "local-documents"), 0o700); }
});
