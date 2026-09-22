import { describe, expect, it } from "bun:test";
import { buildKnowledgeScopeLock, CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import type { KnowledgeScopeApplicationPort } from "../src/api.js";
import { createRemoteKnowledgeScopeApplication, serveKnowledgeScopeApi } from "../src/api.js";
import { createKnowledgeScopeClient } from "../src/client.js";
import { parseJsonText, type JsonValue } from "../src/json.js";

const wire = (value: unknown): JsonValue => parseJsonText(JSON.stringify(value), "fixture");
const fixture = async (minEvidence = 2) => {
  const definition = KnowledgeScopeDefinitionSchema.parse({
    packId: "support", version: "0.1.0", responsibility: "support",
    scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
    capabilities: ["docs", "records", "other"].map((id) => ({ operationId: id,
      provider: { kind: "schift_search", indexRef: id }, inputSchemaRef: "input.json", resultSchemaRef: "result.json" })),
    contextPolicy: { mustConsider: [{ id: "combined", minEvidence, selector: { sourceIds: ["docs", "records"] } }],
      mustNotUse: [{ id: "private", selector: { sourceIds: ["private"] } }] },
    authority: { allowed: ["read"], forbidden: ["send", "approve", "mutate_source", "workflow"], precedence: ["primary"] },
    evidence: { requireCitation: true, coverageAssertions: ["combined"], freshness: { defaultMaxAgeSeconds: 3600 } },
  });
  const lock = await buildKnowledgeScopeLock(definition, { "scope.json": wire(definition), "input.json": {}, "result.json": {} });
  const mount = KnowledgeScopeMountSchema.parse({ installationId: "installation.batch", definitionDigest: lock.definitionDigest,
    scopeAuthority: { organizationId: "org.test", tenant: "tenant.test" }, state: "mounted", revision: 4,
    sourceBindings: ["docs", "records", "other"].map((id) => ({ sourceId: id, sourceClass: "document", providerRef: id,
      authority: "primary", permissionMode: "live", operationIds: [id] })) });
  const candidates = ["docs", "records"].map((id) => CandidateEnvelopeSchema.parse({
    srn: `srn:${id}/test`, sourceId: id, sourceClass: "document", providerRef: id,
    installationId: mount.installationId, definitionDigest: lock.definitionDigest, mountRevision: mount.revision, operationId: id,
    scopeAuthority: mount.scopeAuthority, effectiveScope: { tenant: "tenant.test" },
    authorizationDecision: { decisionId: "decision.test", decisionDigest: lock.definitionDigest, status: "allowed" },
    revision: "revision.test", permission: "read", permissionMode: "live", providerScopes: [],
    providerEvidence: { kind: "schift_search", indexRef: id }, freshness: "2026-09-22T00:00:00.000Z",
    payload: { text: id }, citation: { uri: `https://example.com/${id}` } }));
  const receipt = { status: "ready", requirements: [{ requirementId: "combined", requiredEvidence: 2, observedEvidence: 2, satisfied: true }],
    candidateReceipts: candidates.map((item) => ({ status: "accepted", candidateSrn: item.srn,
      matchedPolicy: "mustConsider", matchedRuleIds: ["combined"], authorityRank: 0 } as const)) } as const;
  const response = { status: "ready", candidates, receipt } as const;
  const request = { installationId: mount.installationId, effectiveScope: { tenant: "tenant.test" },
    operations: ["docs", "records"].map((operationId) => ({ operationId, input: { query: "help" } })) };
  const inspection = { definition, lock, mount };
  const port: KnowledgeScopeApplicationPort = { inspect: async () => wire(inspection), run: async () => wire(response),
    admit: async () => wire(receipt), mount: async () => wire(mount), unmount: async () => wire(mount) };
  return { request, response, inspection, port };
};

describe("batch SDK boundary", () => {
  it("pins inspected revision and consumes aggregate evidence over authenticated HTTP", async () => {
    const data = await fixture(); // Given
    const server = await serveKnowledgeScopeApi({ application: { ...data.port, runBatch: async (request) => {
      expect(request.expectedRevision).toBe(4);
      return wire(data.response);
    } }, apiToken: "batch-client-token", mountAuthority: data.inspection.mount.scopeAuthority, port: 0 });
    try {
      const client = createKnowledgeScopeClient({ application: createRemoteKnowledgeScopeApplication(
        `http://127.0.0.1:${server.port}`, globalThis.fetch, "batch-client-token") });
      const result = await client.runBatch(data.request); // When
      expect(result).toEqual(data.response); // Then
    } finally { server.stop(); }
  });
  it("fails explicitly when an injected application has no batch capability", async () => {
    const data = await fixture(); // Given
    const client = createKnowledgeScopeClient({ application: data.port });
    await expect(client.runBatch(data.request)).rejects.toThrow("batch_unsupported"); // When/Then
  });
  for (const field of ["installationId", "definitionDigest", "mountRevision", "effectiveScope", "scopeAuthority", "operationId"] as const) {
    it(`rejects batch evidence with mismatched ${field}`, async () => {
      const data = await fixture(); // Given
      const changes: Readonly<Record<string, JsonValue>> = { installationId: "installation.other", definitionDigest: `sha256:${"a".repeat(64)}`,
        mountRevision: 5, effectiveScope: { tenant: "tenant.test", namespace: "unexpected" },
        scopeAuthority: { organizationId: "other", tenant: "tenant.test" }, operationId: "other" };
      const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => wire({ ...data.response,
        candidates: data.response.candidates.map((candidate) => ({ ...candidate,
          ...(field === "operationId" ? { sourceId: "other", providerRef: "other" } : {}), [field]: changes[field] })) }) } });
      await expect(client.runBatch(data.request)).rejects.toThrow("identity_mismatch"); // When/Then
    });
  }
  it("rejects duplicate operation requests before dispatch", async () => {
    const data = await fixture(); // Given
    let calls = 0;
    const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => { calls++; return wire(data.response); } } });
    await expect(client.runBatch({ ...data.request, operations: [...data.request.operations, ...data.request.operations] }))
      .rejects.toThrow("request_invalid"); // When/Then
    expect(calls).toBe(0);
  });
  it("rejects unknown operations and stale expected revision before dispatch", async () => {
    const data = await fixture(); // Given
    let calls = 0;
    const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => { calls++; return wire(data.response); } } });
    for (const request of [{ ...data.request, expectedRevision: 3 },
      { ...data.request, operations: [{ operationId: "unknown", input: {} }] }]) {
      await expect(client.runBatch(request)).rejects.toThrow("identity_mismatch"); // When/Then
    }
    expect(calls).toBe(0);
  });
  it("rejects invalid aggregate receipt counts", async () => {
    const data = await fixture(); // Given
    const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => wire({ ...data.response,
      receipt: { ...data.response.receipt, requirements: [{ requirementId: "combined", requiredEvidence: 2, observedEvidence: 3, satisfied: true }] } }) } });
    await expect(client.runBatch(data.request)).rejects.toThrow("response_invalid"); // When/Then
  });
  it("rejects ready coverage when a requested operation contributed no candidates", async () => {
    const data = await fixture(1); // Given: one source suffices for policy, but both operations were requested.
    const response = { ...data.response, candidates: data.response.candidates.slice(0, 1),
      receipt: { ...data.response.receipt, requirements: [{ requirementId: "combined", requiredEvidence: 1, observedEvidence: 1, satisfied: true }],
        candidateReceipts: data.response.receipt.candidateReceipts.slice(0, 1) } };
    const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => wire(response) } });
    await expect(client.runBatch(data.request)).rejects.toThrow("response_invalid"); // When/Then
  });
  it("rejects ready coverage when any candidate was denied", async () => {
    const data = await fixture(); // Given: both operations contributed accepted evidence plus a denied candidate.
    const response = { ...data.response, receipt: { ...data.response.receipt,
      candidateReceipts: [...data.response.receipt.candidateReceipts,
        { status: "denied", candidateSrn: "srn:docs/denied", reasonCode: "must_not_use" }] } };
    const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => wire(response) } });
    await expect(client.runBatch(data.request)).rejects.toThrow("response_invalid"); // When/Then
  });
  for (const leak of [false, true]) {
    it(`${leak ? "rejects partial payloads" : "returns no payloads"} when aggregate coverage is insufficient`, async () => {
      const data = await fixture(); // Given
      const response = { status: "insufficient_evidence", candidates: leak ? data.response.candidates.slice(0, 1) : [],
        receipt: { status: "insufficient_evidence", requirements: [{ requirementId: "combined", requiredEvidence: 2, observedEvidence: 1, satisfied: false }],
          candidateReceipts: data.response.receipt.candidateReceipts.slice(0, 1) } };
      const client = createKnowledgeScopeClient({ application: { ...data.port, runBatch: async () => wire(response) } });
      if (leak) await expect(client.runBatch(data.request)).rejects.toThrow("response_invalid"); // When/Then
      else expect((await client.runBatch(data.request)).candidates).toEqual([]);
    });
  }
});
