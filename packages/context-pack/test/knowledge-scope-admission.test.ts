import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { admitKnowledgeScopeCandidate, admitKnowledgeScopeCandidates } from "../src/knowledge-scope-admission.js";
import { KnowledgeScopeMountSchema } from "../src/knowledge-scope-mount.js";
import { CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema } from "../src/knowledge-scope.js";
import type { CandidateEnvelope } from "../src/knowledge-scope.js";

const loadFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../fixtures/knowledge-scope/${name}`, import.meta.url), "utf8"));
const parseObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fixture must contain an object");
  }
  return value;
};
const omitFields = (
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> => Object.fromEntries(
  Object.entries(value).filter(([key]) => !fields.includes(key)),
);

const loadContract = async () => ({
  definition: KnowledgeScopeDefinitionSchema.parse(await loadFixture("valid-definition.json")),
  mount: KnowledgeScopeMountSchema.parse(await loadFixture("valid-mount.json")),
  base: CandidateEnvelopeSchema.parse(await loadFixture("valid-candidate.json")),
});

const recordsCandidate = (base: CandidateEnvelope): CandidateEnvelope => CandidateEnvelopeSchema.parse({
  ...base,
  srn: "srn:schift:acme:records:orders/order_123",
  sourceId: "orders.primary", providerRef: "orders.lookup", operationId: "lookup_customer_orders",
  revision: "revision.orders_1", permission: "tenant.acme.orders.read", providerScopes: ["orders:read"],
  providerEvidence: { kind: "records_operation", operationId: "orders.lookup" },
  freshness: "2026-09-22T09:01:00Z", payload: { order_id: "order_123" },
  citation: { uri: "schift://orders/order_123" },
});

const documentCandidate = (base: CandidateEnvelope): CandidateEnvelope => CandidateEnvelopeSchema.parse({
  ...base,
  srn: "srn:schift:acme:document:manuals/page_1",
  sourceId: "product.manuals", sourceClass: "document", providerRef: "index.product_manuals",
  operationId: "search_product_manuals", revision: "revision.manuals_1",
  permission: "tenant.acme.manuals.read", permissionMode: "mirrored", providerScopes: [],
  providerEvidence: { kind: "schift_search", indexRef: "index.product_manuals" },
  freshness: "2026-09-22T09:01:00Z", payload: { text: "Approved policy" },
  citation: { uri: "schift://manuals/page_1" },
});

describe("admitKnowledgeScopeCandidate", () => {
  it("accepts trusted evidence inside the mounted definition", async () => {
    // Given the shared records result normalized with server-owned identity
    const fixture = parseObject(await loadFixture("admission-accepted.json"));
    const definition = KnowledgeScopeDefinitionSchema.parse(await loadFixture(String(fixture["definitionFixture"])));
    const mount = KnowledgeScopeMountSchema.parse(await loadFixture(String(fixture["mountFixture"])));
    const candidate = CandidateEnvelopeSchema.parse(fixture["candidate"]);
    const trusted = candidate.authorizationDecision;

    // When trusted authorization is supplied independently
    const result = admitKnowledgeScopeCandidate({ definition, mount, candidate,
      evaluatedAt: new Date("2026-09-22T09:02:00Z"),
      trustedAuthorizationDecision: trusted });

    // Then the receipt names the evidence and matched requirement
    expect(result).toEqual(fixture["expected"]);
  });

  it("rejects a caller-authored authorization decision", async () => {
    // Given otherwise valid evidence and a different server decision
    const { definition, mount, base } = await loadContract();
    const candidate = recordsCandidate(base);
    const trusted = { ...candidate.authorizationDecision,
      decisionDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };

    // When admission compares candidate and trusted decisions
    const result = admitKnowledgeScopeCandidate({ definition, mount, candidate,
      evaluatedAt: new Date("2026-09-22T09:02:00Z"), trustedAuthorizationDecision: trusted });

    // Then the candidate is denied before policy matching
    expect(result).toEqual({ status: "denied", candidateSrn: candidate.srn,
      reasonCode: "authorization_decision_untrusted" });
  });

  it("rejects future freshness beyond the clock-skew allowance", async () => {
    // Given evidence dated more than sixty seconds ahead
    const { definition, mount, base } = await loadContract();
    const candidate = CandidateEnvelopeSchema.parse({ ...recordsCandidate(base), freshness: "2026-09-22T09:03:01Z" });

    // When admission evaluates freshness
    const result = admitKnowledgeScopeCandidate({ definition, mount, candidate,
      evaluatedAt: new Date("2026-09-22T09:02:00Z"),
      trustedAuthorizationDecision: candidate.authorizationDecision });

    // Then provider time cannot manufacture fresh evidence
    expect(result).toEqual({ status: "denied", candidateSrn: candidate.srn,
      reasonCode: "freshness_in_future" });
  });

  it("enforces Open Connector reference, scopes, correlation, and persisted audit", async () => {
    // Given the shared connector candidate and four isolated trust violations
    const { definition, mount, base } = await loadContract();
    const cases = [
      CandidateEnvelopeSchema.parse({ ...base, providerScopes: [] }),
      CandidateEnvelopeSchema.parse({ ...base, providerEvidence: { ...base.providerEvidence,
        connectorRef: "connector.other" } }),
      CandidateEnvelopeSchema.parse({ ...base, providerEvidence: { ...base.providerEvidence,
        auditPersisted: false } }),
    ];
    const expected = ["provider_scopes_missing", "connector_ref_mismatch", "connector_audit_missing"];

    // When each crosses admission with a policy selector added for the ticket source
    const scopedDefinition = KnowledgeScopeDefinitionSchema.parse({ ...definition,
      contextPolicy: { ...definition.contextPolicy, mayConsider: [
        ...(definition.contextPolicy.mayConsider ?? []),
        { id: "ticket_context", selector: { sourceIds: ["tickets.primary"] }, minEvidence: 1 },
      ] } });
    const results = cases.map((candidate) => admitKnowledgeScopeCandidate({ definition: scopedDefinition,
      mount, candidate, evaluatedAt: new Date("2026-09-22T09:02:00Z"),
      trustedAuthorizationDecision: candidate.authorizationDecision }));
    const accepted = admitKnowledgeScopeCandidate({ definition: scopedDefinition,
      mount, candidate: base, evaluatedAt: new Date("2026-09-22T09:02:00Z"),
      trustedAuthorizationDecision: base.authorizationDecision });

    // Then each failure has a deterministic reason
    expect(results.map((result) => result.status === "denied" ? result.reasonCode : "accepted")).toEqual(expected);
    expect(accepted.status).toBe("accepted");
  });

  it("matches the shared deterministic denial matrix", async () => {
    // Given the shared accepted fixture and portable denial mutations
    const matrix = parseObject(await loadFixture("admission-denied.json"));
    const accepted = parseObject(await loadFixture(String(matrix["acceptedFixture"])));
    const definition = KnowledgeScopeDefinitionSchema.parse(
      await loadFixture(String(accepted["definitionFixture"])),
    );
    const baseMount = KnowledgeScopeMountSchema.parse(await loadFixture(String(accepted["mountFixture"])));
    const baseCandidate = parseObject(accepted["candidate"]);
    const baseTrusted = parseObject(accepted["trustedAuthorizationDecision"]);
    const cases = matrix["cases"];
    if (!Array.isArray(cases)) throw new TypeError("denial cases must be an array");

    // When every mutation crosses the same pure admission boundary
    const results = cases.map((rawCase) => {
      const testCase = parseObject(rawCase);
      const fields = Array.isArray(testCase["omitCandidateFields"])
        ? testCase["omitCandidateFields"].filter((field): field is string => typeof field === "string")
        : [];
      const overrides = parseObject(testCase["candidateOverrides"] ?? {});
      const candidate = CandidateEnvelopeSchema.parse(omitFields({ ...baseCandidate, ...overrides }, fields));
      const mount = testCase["mountMutation"] === "unmounted"
        ? { ...baseMount, state: "unmounted" as const, sourceBindings: [] }
        : baseMount;
      const trusted = CandidateEnvelopeSchema.parse({ ...candidate, authorizationDecision: {
        ...baseTrusted,
        decisionDigest: testCase["trustedDecisionDigest"] ?? baseTrusted["decisionDigest"],
      } }).authorizationDecision;
      return admitKnowledgeScopeCandidate({ definition, mount, candidate,
        evaluatedAt: new Date(String(accepted["evaluatedAt"])), trustedAuthorizationDecision: trusted });
    });

    // Then reason codes remain cross-language stable
    expect(results.map((result) => result.status === "denied" ? result.reasonCode : "accepted"))
      .toEqual(cases.map((rawCase) => parseObject(rawCase)["reasonCode"]));
  });
});

describe("admitKnowledgeScopeCandidates", () => {
  it("requires every coverage assertion to satisfy minEvidence", async () => {
    // Given accepted records and approved document evidence
    const { definition, mount, base } = await loadContract();
    const fixture = parseObject(await loadFixture("admission-batch.json"));
    const records = recordsCandidate(base);
    const document = documentCandidate(base);

    // When both candidates are admitted as one evidence set
    const ready = admitKnowledgeScopeCandidates({ definition, mount,
      candidates: [records, document].map((candidate) => ({ candidate,
        trustedAuthorizationDecision: candidate.authorizationDecision })),
      evaluatedAt: new Date("2026-09-22T09:02:00Z") });
    const insufficient = admitKnowledgeScopeCandidates({ definition, mount,
      candidates: [{ candidate: records, trustedAuthorizationDecision: records.authorizationDecision }],
      evaluatedAt: new Date("2026-09-22T09:02:00Z") });

    // Then readiness is separate from per-candidate acceptance
    expect(ready.status).toBe("ready");
    expect(ready.requirements).toEqual(fixture["expectedReadyRequirements"]);
    expect(insufficient.status).toBe(fixture["expectedInsufficientStatus"]);
    expect(insufficient.requirements[1]?.observedEvidence).toBe(0);
  });

  it("does not count duplicate candidate identities toward minEvidence", async () => {
    // Given a policy requiring two unique order records and one record duplicated in the batch
    const { definition, mount, base } = await loadContract();
    const candidate = recordsCandidate(base);
    const strictDefinition = KnowledgeScopeDefinitionSchema.parse({ ...definition,
      contextPolicy: { ...definition.contextPolicy,
        mustConsider: definition.contextPolicy.mustConsider.map((requirement) =>
          requirement.id === "current_customer" ? { ...requirement, minEvidence: 2 } : requirement) } });

    // When the exact same candidate appears twice
    const result = admitKnowledgeScopeCandidates({ definition: strictDefinition, mount,
      candidates: [candidate, candidate].map((item) => ({ candidate: item,
        trustedAuthorizationDecision: item.authorizationDecision })),
      evaluatedAt: new Date("2026-09-22T09:02:00Z") });

    // Then observed evidence is one and coverage remains insufficient
    expect(result.status).toBe("insufficient_evidence");
    expect(result.requirements[0]?.observedEvidence).toBe(1);
  });

  it("keeps a zero-candidate batch not ready", async () => {
    // Given a valid definition with required coverage assertions
    const { definition, mount } = await loadContract();

    // When no provider evidence is admitted
    const result = admitKnowledgeScopeCandidates({ definition, mount, candidates: [],
      evaluatedAt: new Date("2026-09-22T09:02:00Z") });

    // Then every assertion remains unsatisfied and readiness fails closed
    expect(result.status).toBe("insufficient_evidence");
    expect(result.requirements.every((requirement) => !requirement.satisfied)).toBe(true);
  });
});
