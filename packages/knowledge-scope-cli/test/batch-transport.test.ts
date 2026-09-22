import { expect, it } from "bun:test";
import { createKnowledgeScopeApi, createRemoteKnowledgeScopeApplication, serveKnowledgeScopeApi, type KnowledgeScopeApplicationPort } from "../src/api.js";
import { runKnowledgeScopeCli, type CliDependencies } from "../src/cli.js";
import { parseJsonText } from "../src/json.js";
import { CapabilityBatchExecutionRequestSchema } from "../src/context-pack.js";

const body = { effectiveScope: { tenant: "acme" }, operations: [{ operationId: "search-documents", input: {} }] };
const request = (value: unknown): Request => new Request("http://127.0.0.1/v1/knowledge-scopes/mounts/test-installation:run-batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

const legacy = (): KnowledgeScopeApplicationPort => ({
  mount: async () => ({}), inspect: async () => ({}), run: async () => { throw new Error("single fallback forbidden"); },
  admit: async () => ({}), unmount: async () => ({}),
});

it("dispatches one batch through authenticated localhost HTTP", async () => {
  // Given
  const server = await serveKnowledgeScopeApi({ application: { ...legacy(), runBatch: async (batch) => parseJsonText(JSON.stringify({ batch }), "batch output") },
    mountAuthority: {}, apiToken: "batch-test-token", port: 0 });
  try {
    const remote = createRemoteKnowledgeScopeApplication(`http://127.0.0.1:${server.port}`, globalThis.fetch, "batch-test-token");
    // When
    const result = await remote.runBatch?.(CapabilityBatchExecutionRequestSchema.parse({ installationId: "test-installation", ...body, expectedRevision: 2 }));
    // Then
    expect(result).toEqual({ batch: { installationId: "test-installation", ...body, expectedRevision: 2 } });
  } finally { server.stop(); }
});

for (const invalid of [
  { ...body, installationId: "spoofed" }, { ...body, unexpected: true },
  { ...body, operations: [] }, { ...body, operations: [...body.operations, ...body.operations] },
  { ...body, operations: [{ operationId: "search-documents", input: {}, extra: true }] },
  { ...body, expectedRevision: "2" }, { ...body, expectedRevision: null },
  { ...body, operations: Array.from({ length: 9 }, (_, index) => ({ operationId: `search-${index}`, input: {} })) },
]) {
  it(`rejects malformed batch before dispatch: ${JSON.stringify(invalid)}`, async () => {
    // Given
    let calls = 0;
    const api = createKnowledgeScopeApi({ application: { ...legacy(), runBatch: async () => { calls += 1; return {}; } }, mountAuthority: {} });
    // When
    const response = await api.fetch(request(invalid));
    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "request_invalid", status: "error" });
    expect(calls).toBe(0);
  });
}

const dependencies = (application: KnowledgeScopeApplicationPort, input: unknown): CliDependencies => ({
  authoring: { validate: async () => ({}), lock: async () => ({}), mountPayload: async () => ({ definition: {}, files: {}, lock: {}, scopeAuthority: {}, sourceBindings: [] }) },
  embedded: application, remote: () => application, serve: async () => ({ host: "127.0.0.1", port: 8787 }),
  readJson: async () => parseJsonText(JSON.stringify(input), "test input"),
});

it("CLI passes one validated batch and preserves remote selection", async () => {
  // Given
  const output: string[] = [];
  const application = { ...legacy(), runBatch: async (batch: import("../src/api.js").RunBatchApplicationRequest) => parseJsonText(JSON.stringify({ batch }), "batch output") };
  // When
  const code = await runKnowledgeScopeCli(["run-batch", "test-installation", "--input", "input.json", "--api-url", "http://127.0.0.1:8787"],
    dependencies(application, body), { stdout: (line) => output.push(line), stderr: (line) => output.push(line) });
  // Then
  expect(code).toBe(0);
  expect(JSON.parse(output[0] ?? "null")).toEqual({ batch: { installationId: "test-installation", ...body } });
});

it("CLI returns a stable error when the injected port lacks batch support", async () => {
  // Given
  const errors: string[] = [];
  // When
  const code = await runKnowledgeScopeCli(["run-batch", "test-installation", "--input", "input.json"], dependencies(legacy(), body),
    { stdout: () => { throw new Error("partial output forbidden"); }, stderr: (line) => errors.push(line) });
  // Then
  expect(code).toBe(1);
  expect(JSON.parse(errors[0] ?? "null")).toEqual({ code: "batch_unsupported", status: "error" });
});

it("CLI rejects unknown batch input fields rather than silently dropping them", async () => {
  // Given
  const errors: string[] = [];
  // When
  const code = await runKnowledgeScopeCli(["run-batch", "test-installation", "--input", "input.json"], dependencies(legacy(), { ...body, authority: "admin" }),
    { stdout: () => { throw new Error("partial output forbidden"); }, stderr: (line) => errors.push(line) });
  // Then
  expect(code).toBe(1);
  expect(JSON.parse(errors[0] ?? "null")).toEqual({ code: "input_invalid", status: "error" });
});
it("returns a stable unsupported response for legacy injected application ports", async () => {
  // Given
  const api = createKnowledgeScopeApi({ application: legacy(), mountAuthority: {} });
  // When
  const response = await api.fetch(request(body));
  // Then
  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({ code: "batch_unsupported", status: "error" });
});
