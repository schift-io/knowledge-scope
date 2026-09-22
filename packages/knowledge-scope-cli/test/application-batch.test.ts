import { afterEach, expect, it, spyOn } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeScopeLock, KnowledgeScopeDefinitionSchema } from "../src/context-pack.js";
import { KnowledgeScopeApplication, type ProviderExecutionContext } from "../src/application.js";
import { KnowledgeScopeAuthorization, type AuthorizationSubject } from "../src/authorization.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import { productError } from "../src/errors.js";
import { parseJsonText, type JsonValue } from "../src/json.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const setup = async (
  execute: (context: ProviderExecutionContext) => Promise<readonly unknown[]>,
  requireRecords = true,
  createAuthorization = (home: string) => new KnowledgeScopeAuthorization({ home }),
) => {
  const home = await mkdtemp(join(tmpdir(), "ks-batch-"));
  homes.push(home);
  await chmod(home, 0o700);
  const definition = KnowledgeScopeDefinitionSchema.parse({
    packId: "support", version: "1.0.0", responsibility: "support.answers",
    scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
    capabilities: ["docs", "records"].map((kind) => ({
      operationId: `search.${kind}`, provider: { kind: "records_operation", operationId: `search.${kind}` },
      inputSchemaRef: "schemas/input.json", resultSchemaRef: "schemas/result.json",
    })),
    contextPolicy: { mustConsider: ["docs", "records"].map((kind) => ({
      id: kind, selector: { sourceIds: [kind] }, minEvidence: 1,
    })), mustNotUse: [{ id: "private", selector: { sourceIds: ["private"] } }] },
    authority: { precedence: ["primary"], allowed: ["read"], forbidden: ["send", "approve", "mutate_source", "workflow"] },
    evidence: { requireCitation: true, freshness: { defaultMaxAgeSeconds: 3600 }, coverageAssertions: requireRecords ? ["docs", "records"] : ["docs"] },
  });
  const files: Readonly<Record<string, JsonValue>> = {
    "scope.json": parseJsonText(JSON.stringify(definition), "value_schema_mismatch"),
    "schemas/input.json": { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false },
    "schemas/result.json": { type: "object" },
  };
  const application = new KnowledgeScopeApplication({
    store: new KnowledgeScopeStateStore({ home }), authorization: createAuthorization(home),
    provider: { execute }, now: () => new Date("2026-09-22T06:00:01Z"),
  });
  const mount = await application.mount({
    portable: { directory: home, definition, files, lock: await buildKnowledgeScopeLock(definition, files) },
    scopeAuthority: { organizationId: "org.acme", tenant: "acme" },
    sourceBindings: ["docs", "records"].map((kind) => ({
      sourceId: kind, sourceClass: kind === "docs" ? "document" : "records",
      providerRef: `search.${kind}`, authority: "primary", permissionMode: "live", operationIds: [`search.${kind}`],
    })),
  });
  const request = { installationId: mount.installationId, effectiveScope: { tenant: "acme" }, expectedRevision: 1,
    operations: ["docs", "records"].map((kind) => ({ operationId: `search.${kind}`, input: { query: "reset" } })) };
  return { application, request };
};

const result = (context: ProviderExecutionContext, index = 0) => ({
  resultId: `result-${index}`, revision: "rev-1", freshness: "2026-09-22T06:00:00Z",
  payload: { text: context.request.operationId }, citation: { uri: "https://example.com/evidence" },
  providerScopes: [], providerEvidence: { kind: "records_operation", operationId: context.request.operationId },
});

it("combines documents and records when neither operation alone satisfies coverage", async () => {
  // Given
  const { application, request } = await setup(async (context) => [result(context)]);
  for (const operation of request.operations) {
    expect((await application.run({ ...operation, installationId: request.installationId, effectiveScope: request.effectiveScope })).status)
      .toBe("insufficient_evidence");
  }
  // When
  const batch = await application.runBatch(request);
  // Then
  expect(batch.status).toBe("ready");
  expect(batch.candidates.map((candidate) => candidate.operationId)).toEqual(["search.docs", "search.records"]);
});

it("validates the last operation before the first provider dispatch", async () => {
  // Given
  let calls = 0;
  const { application, request } = await setup(async (context) => { calls += 1; return [result(context)]; });
  // When / Then
  await expect(application.runBatch({ ...request, operations: [request.operations[0], { operationId: "search.records", input: {} }] }))
    .rejects.toThrow("value_schema_mismatch");
  expect(calls).toBe(0);
});

it("rejects scope widening before dispatching any operation", async () => {
  // Given
  let calls = 0;
  const { application, request } = await setup(async (context) => { calls += 1; return [result(context)]; });
  // When / Then
  await expect(application.runBatch({ ...request, effectiveScope: { tenant: "other" } })).rejects.toThrow("scope_invalid");
  expect(calls).toBe(0);
});

it("releases no partial result when a later provider fails", async () => {
  // Given
  const { application, request } = await setup(async (context) => {
    if (context.request.operationId === "search.records") throw productError("provider_result_invalid");
    return [result(context)];
  });
  // When / Then
  await expect(application.runBatch(request)).rejects.toThrow("provider_result_invalid");
});

it.each(["empty", "stale"])("releases no partial result when the last provider is %s", async (mode) => {
  // Given
  const { application, request } = await setup(async (context) => {
    if (context.request.operationId !== "search.records") return [result(context)];
    return mode === "empty" ? [] : [{ ...result(context), freshness: "2020-01-01T00:00:00Z" }];
  });
  // When
  const batch = await application.runBatch(request);
  // Then
  expect(batch.status).toBe("insufficient_evidence");
  expect(batch.candidates).toEqual([]);
});

it.each(["empty", "stale"])("fails a %s requested operation even when required coverage is ready", async (mode) => {
  // Given
  const { application, request } = await setup(async (context) => {
    if (context.request.operationId !== "search.records") return [result(context)];
    return mode === "empty" ? [] : [{ ...result(context), freshness: "2020-01-01T00:00:00Z" }];
  }, false);
  // When / Then
  await expect(application.runBatch(request)).rejects.toThrow(mode === "empty" ? "batch_incomplete" : "candidate_invalid");
});

it("denies old evidence when unmounted during provider execution", async () => {
  // Given
  let unmount: () => Promise<unknown> = async () => undefined;
  const { application, request } = await setup(async (context) => {
    if (context.request.operationId === "search.records") await unmount();
    return [result(context)];
  });
  unmount = () => application.unmount(request.installationId, 1);
  // When
  const batch = await application.runBatch(request);
  // Then
  expect(batch.status).toBe("insufficient_evidence");
  expect(batch.candidates).toEqual([]);
});

it("denies old evidence when unmounted during final authorization", async () => {
  // Given: real HMAC work, with deterministic unmount on the first final admission issue.
  let unmount: () => Promise<unknown> = async () => undefined;
  class UnmountDuringAdmission extends KnowledgeScopeAuthorization {
    private calls = 0;
    public override async issue(subject: AuthorizationSubject) {
      this.calls += 1;
      const finalAdmission = this.calls === 3;
      const decision = await super.issue(subject);
      if (finalAdmission) await unmount();
      return decision;
    }
  }
  const { application, request } = await setup(
    async (context) => [result(context)], true, (home) => new UnmountDuringAdmission({ home }),
  );
  unmount = () => application.unmount(request.installationId, 1);
  // When
  const batch = await application.runBatch(request);
  // Then
  expect(batch.status).toBe("insufficient_evidence");
  expect(batch.candidates).toEqual([]);
  expect(batch.receipt.candidateReceipts).toEqual([
    expect.objectContaining({ status: "denied", reasonCode: "installation_not_mounted" }),
    expect.objectContaining({ status: "denied", reasonCode: "installation_not_mounted" }),
  ]);
});

it("does not open another digest wait after final authorization", async () => {
  // Given: an unmount completes inside any digest that follows the final HMACs.
  let issues = 0;
  let unmount: () => Promise<unknown> = async () => undefined;
  class CountedAuthorization extends KnowledgeScopeAuthorization {
    public override async issue(subject: AuthorizationSubject) {
      const decision = await super.issue(subject);
      issues += 1;
      return decision;
    }
  }
  const { application, request } = await setup(
    async (context) => [result(context)], true, (home) => new CountedAuthorization({ home }),
  );
  unmount = () => application.unmount(request.installationId, 1);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let postAuthorizationDigests = 0;
  const digestSpy = spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    const value = await digest(algorithm, data);
    if (issues === 4 && postAuthorizationDigests++ === 0) await unmount();
    return value;
  });
  try {
    // When
    await application.runBatch(request);
    // Then: final state is read only after all async integrity work has ended.
    expect(postAuthorizationDigests).toBe(0);
  } finally {
    digestSpy.mockRestore();
  }
});

it.each(["rows", "bytes"])("enforces the cumulative %s limit across operations", async (mode) => {
  // Given
  const { application, request } = await setup(async (context) => Array.from({ length: mode === "bytes" ? 40 : 51 }, (_, i) => ({
    ...result(context, i), payload: mode === "bytes" ? { a: "x".repeat(60_000), b: "x".repeat(60_000) } : {},
  })));
  // When / Then
  await expect(application.runBatch(request)).rejects.toThrow("result_limits_exceeded");
});
