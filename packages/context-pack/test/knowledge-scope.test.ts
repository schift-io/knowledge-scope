import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { canonicalJson, digestCanonicalJson } from "../src/canonical.js";
import { CapabilityExecutionRequestSchema, ProviderResultSchema } from "../src/knowledge-scope-execution.js";
import { KnowledgeScopeMountSchema, KnowledgeScopePackSchema, materializeKnowledgeScopePack } from "../src/knowledge-scope-mount.js";
import { CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema, QueryCapabilitySchema } from "../src/knowledge-scope.js";

const loadFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../fixtures/knowledge-scope/${name}`, import.meta.url), "utf8"));
const parseObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fixture must contain an object");
  }
  return value;
};

describe("KnowledgeScopeDefinitionSchema", () => {
  it("parses portable policy without installation state", async () => {
    // Given the shared portable definition
    const raw = await loadFixture("valid-definition.json");

    // When it crosses the authoring boundary
    const definition = KnowledgeScopeDefinitionSchema.parse(raw);
    const digests = parseObject(await loadFixture("conformance-digest.json"));

    // Then all provider declarations remain portable and canonical
    expect(definition.capabilities.map((item) => item.provider.kind)).toEqual([
      "records_operation", "open_connector_action", "schift_search", "web_search",
    ]);
    expect(canonicalJson(definition)).toBe(canonicalJson(raw));
    expect(await digestCanonicalJson(definition)).toBe(digests["valid-definition.json"]);
  });

  it("rejects installation state and unsafe provider syntax", async () => {
    // Given a valid definition, SQL capability, and credential-bearing capability
    const definition = KnowledgeScopeDefinitionSchema.parse(await loadFixture("valid-definition.json"));

    // When local state and provider-native secrets cross portable boundaries
    const withInstallation = KnowledgeScopeDefinitionSchema.safeParse({ ...definition, installation: {} });
    const sql = QueryCapabilitySchema.safeParse(await loadFixture("invalid-sql-capability.json"));
    const credential = QueryCapabilitySchema.safeParse(await loadFixture("invalid-credential-capability.json"));

    // Then all three are rejected
    expect(withInstallation.success).toBe(false);
    expect(sql.success).toBe(false);
    expect(credential.success).toBe(false);
  });

  it("rejects an empty coverage assertion set", async () => {
    // Given a valid definition with all required evidence assertions removed
    const definition = KnowledgeScopeDefinitionSchema.parse(await loadFixture("valid-definition.json"));

    // When it crosses the portable definition boundary
    const result = KnowledgeScopeDefinitionSchema.safeParse({ ...definition,
      evidence: { ...definition.evidence, coverageAssertions: [] } });

    // Then aggregate readiness cannot become vacuously true
    expect(result.success).toBe(false);
  });
});

describe("KnowledgeScopeMountSchema", () => {
  it("materializes the deprecated combined view without changing definition identity", async () => {
    // Given separate portable and server-owned objects
    const definition = KnowledgeScopeDefinitionSchema.parse(await loadFixture("valid-definition.json"));
    const mount = KnowledgeScopeMountSchema.parse(await loadFixture("valid-mount.json"));

    // When a legacy consumer explicitly requests a combined view
    const legacy = materializeKnowledgeScopePack(definition, mount);

    // Then only the compatibility parser sees installation state
    expect(KnowledgeScopePackSchema.parse(legacy).installation.packDigest).toBe(mount.definitionDigest);
    expect(legacy.scope.installation).toBe("required");
  });

  it("rejects mounted state without a source binding", async () => {
    // Given an otherwise valid mount
    const mount = KnowledgeScopeMountSchema.parse(await loadFixture("valid-mount.json"));

    // When all bindings disappear
    const result = KnowledgeScopeMountSchema.safeParse({ ...mount, sourceBindings: [] });

    // Then the server-owned mount fails closed
    expect(result.success).toBe(false);
  });

  it("rejects provider references that drift from declared capabilities", async () => {
    // Given a valid definition and a mount whose records binding points elsewhere
    const definition = KnowledgeScopeDefinitionSchema.parse(await loadFixture("valid-definition.json"));
    const mount = KnowledgeScopeMountSchema.parse(await loadFixture("valid-mount.json"));
    const sourceBindings = mount.sourceBindings.map((binding) => binding.sourceId === "orders.primary"
      ? { ...binding, providerRef: "orders.other" }
      : binding);

    // When the server attempts to materialize that mount
    const materialize = () => materializeKnowledgeScopePack(definition, { ...mount, sourceBindings });

    // Then provider mapping drift is rejected before execution
    expect(materialize).toThrow();
  });
});

describe("execution and provider boundaries", () => {
  it("requires a bounded operation request and excludes provider-owned trust", async () => {
    // Given an execution request and an untrusted provider result
    const request = await loadFixture("valid-execution-request.json");
    const providerResult = {
      resultId: "ticket_123", srn: "srn:schift:acme:records:tickets/ticket_123",
      revision: "revision.1", freshness: "2026-09-22T09:00:00Z",
      payload: { ticket_id: "ticket_123" }, citation: { uri: "schift://tickets/ticket_123" },
      providerScopes: ["tickets:read"],
      providerEvidence: { kind: "open_connector_action", connectorRef: "connector.zendesk.primary",
        actionId: "zendesk.search_tickets", connectorRunId: "run.1",
        actionCorrelationId: "ks-496c3d22b80c27492bbefeed6c74e555", auditPersisted: true },
    };

    // When both cross their strict boundaries
    const parsedRequest = CapabilityExecutionRequestSchema.safeParse(request);
    const parsedResult = ProviderResultSchema.safeParse(providerResult);
    const malformedSrn = ProviderResultSchema.safeParse({ ...providerResult, srn: "ticket_123" });
    const forgedPermission = ProviderResultSchema.safeParse({ ...providerResult,
      permission: "tenant.acme.support.read", permissionMode: "live" });
    const fractionalProvider = ProviderResultSchema.safeParse({ ...providerResult,
      payload: { score: 0.98 } });
    const unsafeProviders = [9_007_199_254_740_993, 1e20].map((count) =>
      ProviderResultSchema.safeParse({ ...providerResult, payload: { count } }));
    const forgedResult = ProviderResultSchema.safeParse({ ...providerResult,
      installationId: "installation.acme_support" });

    // Then operation data is accepted but provider-authored trusted identity is rejected
    expect(parsedRequest.success).toBe(true);
    expect(parsedResult.success).toBe(true);
    expect(malformedSrn.success).toBe(false);
    expect(forgedPermission.success).toBe(false);
    expect(fractionalProvider.success).toBe(true);
    expect(unsafeProviders.every((result) => !result.success)).toBe(true);
    expect(forgedResult.success).toBe(false);
  });
});

describe("CandidateEnvelopeSchema", () => {
  it("parses strict v2 candidate evidence and retains canonical null payload", async () => {
    // Given a normalized trusted candidate
    const raw = await loadFixture("valid-candidate.json");

    // When it crosses admission
    const candidate = CandidateEnvelopeSchema.parse(raw);
    const digests = parseObject(await loadFixture("conformance-digest.json"));
    const nullable = CandidateEnvelopeSchema.parse({ ...candidate, payload: null });

    // Then provider correlation is present and null remains a value
    expect(candidate.providerEvidence.kind).toBe("open_connector_action");
    expect(nullable.payload).toBeNull();
    expect(await digestCanonicalJson(candidate)).toBe(digests["valid-candidate.json"]);
  });

  it("rejects v1 candidates without mount and provider evidence", async () => {
    // Given a valid v2 candidate with its new trust bindings removed
    const candidate = CandidateEnvelopeSchema.parse(await loadFixture("valid-candidate.json"));
    const { definitionDigest: _digest, mountRevision: _revision,
      providerEvidence: _providerEvidence, ...legacy } = candidate;

    // When the legacy shape crosses the strict boundary
    const result = CandidateEnvelopeSchema.safeParse(legacy);

    // Then it is rejected
    expect(result.success).toBe(false);
  });

  it("keeps finite floating-point values valid in Candidate payloads", async () => {
    // Given a valid candidate carrying provider score and threshold floats
    const candidate = CandidateEnvelopeSchema.parse(await loadFixture("valid-candidate.json"));

    // When floating-point provider payload is parsed
    const result = CandidateEnvelopeSchema.safeParse({ ...candidate,
      payload: { score: 0.98, binarySum: 0.30000000000000004, probability: 1e-7 } });
    const unsafe = [9_007_199_254_740_993, 1e20].map((count) =>
      CandidateEnvelopeSchema.safeParse({ ...candidate, payload: { count } }));

    // Then lock-only safe-integer constraints do not leak into Candidate evidence
    expect(result.success).toBe(true);
    expect(unsafe.every((entry) => !entry.success)).toBe(true);
  });
});
