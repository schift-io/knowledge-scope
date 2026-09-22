import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { admitKnowledgeScopeCandidate } from "../src/knowledge-scope-admission.js";
import { ProviderResultSchema } from "../src/knowledge-scope-execution.js";
import { KnowledgeScopeMountSchema, materializeKnowledgeScopePack } from "../src/knowledge-scope-mount.js";
import { digestKnowledgeScopeDefinition } from "../src/knowledge-scope-lock.js";
import { CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema, QueryProviderSchema } from "../src/knowledge-scope.js";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../fixtures/knowledge-scope/${name}`, import.meta.url), "utf8"));

it("parses opaque local document provider identity", () => {
  // Given an index identifier without a machine path
  const provider = { kind: "local_documents", indexRef: "index.manuals" };
  // When the portable declaration crosses the schema boundary
  const parsed = QueryProviderSchema.parse(provider);
  // Then its identity is retained without configuration or data
  expect(parsed).toEqual(provider);
});

it.each(["/tmp/docs", "../docs", "file:///tmp/docs", "C:\\docs", "", "a"])(
  "rejects non-opaque local index identity %s", (indexRef) => {
    // Given a path, empty value, or invalid identifier
    const provider = { kind: "local_documents", indexRef };
    // When the declaration is parsed
    const result = QueryProviderSchema.safeParse(provider);
    // Then it cannot enter the portable definition
    expect(result.success).toBe(false);
  },
);

it("rejects raw paths and data alongside local identity", () => {
  // Given deployment-local data accidentally embedded in the provider
  const provider = { kind: "local_documents", indexRef: "index.manuals", path: "/tmp/docs", text: "private" };
  // When the declaration crosses the strict boundary
  const result = QueryProviderSchema.safeParse(provider);
  // Then unknown configuration is rejected
  expect(result.success).toBe(false);
});

it.each([
  { kind: "local_documents", indexRef: "index.manuals", accepted: true },
  { kind: "local_documents", indexRef: "index.other", accepted: false },
  { kind: "schift_search", indexRef: "index.manuals", accepted: false },
])("checks native local evidence identity %j", async ({ kind, indexRef, accepted }) => {
  // Given the shared document binding and a local-document capability
  const base = KnowledgeScopeDefinitionSchema.parse(await fixture("valid-definition.json"));
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...base, capabilities: base.capabilities.map((capability) =>
    capability.operationId === "search_product_manuals"
      ? { ...capability, provider: { kind: "local_documents", indexRef: "index.manuals" } } : capability) });
  const mount = KnowledgeScopeMountSchema.parse(await fixture("valid-mount.json"));
  const original = CandidateEnvelopeSchema.parse(await fixture("valid-candidate.json"));
  const result = ProviderResultSchema.parse({ resultId: "document.one", revision: "revision.one",
    freshness: "2026-09-22T09:01:00Z", payload: { text: "Approved policy" },
    citation: { uri: "schift://manuals/page_1" }, providerScopes: [],
    providerEvidence: { kind, indexRef } });
  const candidate = CandidateEnvelopeSchema.parse({ ...original,
    payload: result.payload, freshness: result.freshness, citation: result.citation,
    providerScopes: result.providerScopes, providerEvidence: result.providerEvidence,
    srn: "srn:schift:acme:document:manuals/page_1", sourceId: "product.manuals",
    sourceClass: "document", providerRef: "index.product_manuals", operationId: "search_product_manuals",
    permissionMode: "mirrored" });
  // When admission checks the provider-native evidence against the definition
  const receipt = admitKnowledgeScopeCandidate({ definition, mount, candidate,
    evaluatedAt: new Date("2026-09-22T09:02:00Z"), trustedAuthorizationDecision: candidate.authorizationDecision });
  // Then a different index cannot impersonate the declared local corpus
  expect(receipt.status).toBe(accepted ? "accepted" : "denied");
  if (receipt.status === "denied") expect(receipt.reasonCode).toBe("provider_evidence_mismatch");
});

it("pins the local definition digest shared with Python", async () => {
  // Given the same fixture mutation used by the Python contract.
  const base = KnowledgeScopeDefinitionSchema.parse(await fixture("valid-definition.json"));
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...base, capabilities: base.capabilities.map((capability) =>
    capability.operationId === "search_product_manuals"
      ? { ...capability, provider: { kind: "local_documents", indexRef: "index.manuals" } } : capability) });
  // When the normalized definition is digested.
  const digest = await digestKnowledgeScopeDefinition(definition);
  // Then both runtimes sign the same portable definition.
  expect(digest).toBe("sha256:4fa8fd40c5c1a6b3cb83e2c7234d6a365eba5363fc5d79a72829310fd7817c7f");
});

it("materializes an opaque local provider binding", async () => {
  // Given the existing index reference bound to a local provider instead of remote search.
  const base = KnowledgeScopeDefinitionSchema.parse(await fixture("valid-definition.json"));
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...base, capabilities: base.capabilities.map((capability) =>
    capability.provider.kind === "schift_search"
      ? { ...capability, provider: { ...capability.provider, kind: "local_documents" } } : capability) });
  const mount = KnowledgeScopeMountSchema.parse(await fixture("valid-mount.json"));
  // When the compatibility view materializes the same binding.
  const pack = materializeKnowledgeScopePack(definition, mount);
  // Then provider identity remains local and opaque.
  expect(pack.capabilities.some((capability) => capability.provider.kind === "local_documents")).toBe(true);
});
