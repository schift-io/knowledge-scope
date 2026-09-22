import { describe, expect, it } from "bun:test";
import { buildKnowledgeScopeLock, CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import type { KnowledgeScopeApplicationPort } from "../src/api.js";
import { createRemoteKnowledgeScopeApplication, serveKnowledgeScopeApi } from "../src/api.js";
import { createKnowledgeScopeClient } from "../src/client.js";
import { parseJsonText, type JsonValue } from "../src/json.js";

const wire = (value: unknown): JsonValue => parseJsonText(JSON.stringify(value), "fixture");

const fixture = async () => {
  const definition = KnowledgeScopeDefinitionSchema.parse({
    packId: "support", version: "0.1.0", responsibility: "support",
    scope: { root: "tenant", descendants: ["namespace", "subject", "session"] },
    capabilities: [{ operationId: "search.docs", provider: { kind: "schift_search", indexRef: "docs" },
      inputSchemaRef: "input.json", resultSchemaRef: "result.json" }],
    contextPolicy: { mustConsider: [{ id: "docs", minEvidence: 1, selector: { sourceIds: ["docs"] } }],
      mustNotUse: [{ id: "private", selector: { sourceIds: ["private"] } }] },
    authority: { allowed: ["read"], forbidden: ["send", "approve", "mutate_source", "workflow"], precedence: ["primary"] },
    evidence: { requireCitation: true, coverageAssertions: ["docs"], freshness: { defaultMaxAgeSeconds: 3600 } },
  });
  const lock = await buildKnowledgeScopeLock(definition, { "scope.json": wire(definition), "input.json": {}, "result.json": {} });
  const mount = KnowledgeScopeMountSchema.parse({ installationId: "installation.test", definitionDigest: lock.definitionDigest,
    scopeAuthority: { organizationId: "org.test", tenant: "tenant.test" }, state: "mounted", revision: 1,
    sourceBindings: [{ sourceId: "docs", sourceClass: "document", providerRef: "docs", authority: "primary",
      permissionMode: "live", operationIds: ["search.docs"] }] });
  const candidate = CandidateEnvelopeSchema.parse({ srn: "srn:docs/test", sourceId: "docs", sourceClass: "document", providerRef: "docs",
    installationId: mount.installationId, definitionDigest: lock.definitionDigest, mountRevision: 1, operationId: "search.docs",
    scopeAuthority: mount.scopeAuthority, effectiveScope: { tenant: "tenant.test" },
    authorizationDecision: { decisionId: "decision.test", decisionDigest: lock.definitionDigest, status: "allowed" },
    revision: "revision.test", permission: "read", permissionMode: "live", providerScopes: [],
    providerEvidence: { kind: "schift_search", indexRef: "docs" }, freshness: new Date().toISOString(),
    payload: { text: "evidence" }, citation: { uri: "https://example.com/doc" } });
  const receipt = { status: "ready", requirements: [{ requirementId: "docs", requiredEvidence: 1, observedEvidence: 1, satisfied: true }],
    candidateReceipts: [{ status: "accepted", candidateSrn: candidate.srn, matchedPolicy: "mustConsider", matchedRuleIds: ["docs"], authorityRank: 0 }] } as const;
  const request = { installationId: mount.installationId, operationId: "search.docs", effectiveScope: { tenant: "tenant.test" }, input: { query: "help" } };
  const response = { status: "ready", candidates: [candidate], receipt } as const;
  const inspection = { definition, lock, mount };
  const port: KnowledgeScopeApplicationPort = { inspect: async () => wire(inspection), run: async () => wire(response),
    admit: async () => wire(receipt), mount: async () => wire(mount), unmount: async () => wire(mount) };
  return { request, response, inspection, port, candidate, receipt };
};

describe("typed Knowledge Scope client", () => {
  it("consumes the authenticated localhost HTTP application", async () => {
    const data = await fixture(); // Given
    const server = await serveKnowledgeScopeApi({ application: data.port, apiToken: "client-test-token",
      mountAuthority: { organizationId: "org.test", tenant: "tenant.test" }, port: 0 });
    try {
      const client = createKnowledgeScopeClient({ application: createRemoteKnowledgeScopeApplication(
        `http://127.0.0.1:${server.port}`, globalThis.fetch, "client-test-token") });
      const result = await client.run(data.request); // When
      expect(result).toEqual(data.response); // Then
    } finally { server.stop(); }
  });
  it("returns cited evidence and typed inspection through the injected application", async () => {
    const data = await fixture(); // Given
    const client = createKnowledgeScopeClient({ application: data.port });
    const result = await client.run(data.request); // When
    expect(result).toEqual(data.response); // Then
    expect(await client.inspect(data.request.installationId)).toEqual(data.inspection);
    expect(await client.admit({ installationId: data.request.installationId, candidates: [data.candidate] })).toEqual(data.receipt);
  });
  for (const field of ["installationId", "operationId", "definitionDigest", "mountRevision", "effectiveScope", "scopeAuthority"] as const) {
    it(`rejects evidence with mismatched ${field}`, async () => {
      const data = await fixture(); // Given
      const changes: Readonly<Record<string, JsonValue>> = { installationId: "installation.other", operationId: "other",
        definitionDigest: `sha256:${"a".repeat(64)}`, mountRevision: 2,
        effectiveScope: { tenant: "tenant.other" }, scopeAuthority: { organizationId: "org.other", tenant: "tenant.test" } };
      const client = createKnowledgeScopeClient({ application: { ...data.port,
        run: async () => wire({ ...data.response, candidates: [{ ...data.candidate, [field]: changes[field] ?? null }] }) } });
      await expect(client.run(data.request)).rejects.toThrow("identity_mismatch"); // When/Then
    });
  }
  it("rejects an inconsistent receipt and unexpected response fields", async () => {
    const data = await fixture(); // Given
    for (const response of [{ ...data.response, receipt: { ...data.receipt, requirements: [] } },
      { ...data.response, payload: "leaked" }, { ...data.response, receipt: { ...data.receipt, candidateReceipts: [] } }]) {
      const client = createKnowledgeScopeClient({ application: { ...data.port, run: async () => wire(response) } });
      await expect(client.run(data.request)).rejects.toThrow("response_invalid"); // When/Then
    }
  });
  it("withholds payloads on insufficient evidence", async () => {
    const data = await fixture(); // Given
    const receipt = { status: "insufficient_evidence", requirements: [{ requirementId: "docs", requiredEvidence: 1, observedEvidence: 0, satisfied: false }], candidateReceipts: [] };
    const client = createKnowledgeScopeClient({ application: { ...data.port,
      run: async () => wire({ status: "insufficient_evidence", candidates: [data.candidate], receipt }) } });
    await expect(client.run(data.request)).rejects.toThrow("response_invalid"); // When/Then
    const safe = createKnowledgeScopeClient({ application: { ...data.port,
      run: async () => ({ status: "insufficient_evidence", candidates: [], receipt }) } });
    expect((await safe.run(data.request)).candidates).toEqual([]);
  });
  it("rejects inspect identity drift and malformed admit pairing", async () => {
    const data = await fixture(); // Given
    const client = createKnowledgeScopeClient({ application: { ...data.port,
      inspect: async () => wire({ ...data.inspection, mount: { ...data.inspection.mount, installationId: "other" } }) } });
    await expect(client.inspect(data.request.installationId)).rejects.toThrow("identity_mismatch"); // When/Then
    const admission = createKnowledgeScopeClient({ application: { ...data.port,
      admit: async () => ({ ...data.receipt, candidateReceipts: [] }) } });
    await expect(admission.admit({ installationId: data.request.installationId, candidates: [data.candidate] })).rejects.toThrow("response_invalid");
  });
});
