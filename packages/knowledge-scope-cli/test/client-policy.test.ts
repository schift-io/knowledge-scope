import { expect, it } from "bun:test";
import { buildKnowledgeScopeLock, CandidateEnvelopeSchema, KnowledgeScopeDefinitionSchema, KnowledgeScopeMountSchema, ScopeRequirementReceiptSchema } from "@schift-io/context-pack";
import definitionFixture from "../../context-pack/fixtures/knowledge-scope/valid-definition.json";
import mountFixture from "../../context-pack/fixtures/knowledge-scope/valid-mount.json";
import acceptedFixture from "../../context-pack/fixtures/knowledge-scope/admission-accepted.json";
import files from "../../context-pack/fixtures/knowledge-scope/schema-files.json";
import { validateClientCandidates } from "../src/client-validation.js";

const fixture = async () => {
  const definition = KnowledgeScopeDefinitionSchema.parse(definitionFixture);
  const lock = await buildKnowledgeScopeLock(definition, { ...files, "scope.json": definitionFixture });
  const mount = KnowledgeScopeMountSchema.parse(mountFixture);
  const candidate = CandidateEnvelopeSchema.parse(acceptedFixture.candidate);
  const receipt = ScopeRequirementReceiptSchema.parse({ status: "ready", requirements: [], candidateReceipts: [acceptedFixture.expected] });
  return { inspection: { definition, lock, mount }, candidates: [candidate], receipt };
};

it("accepts a correctly matched binding and receipt", async () => {
  const input = await fixture(); // Given
  expect(() => validateClientCandidates(input)).not.toThrow(); // When/Then
});

for (const selector of [{ sourceIds: ["different"] }, { sourceClasses: ["document"] },
  { authorities: ["approved"] }, { origins: ["derived"] }]) {
  it(`rejects forged matched rules with selector ${JSON.stringify(selector)}`, async () => {
    const input = await fixture(); // Given
    const definition = KnowledgeScopeDefinitionSchema.parse({ ...input.inspection.definition,
      contextPolicy: { ...input.inspection.definition.contextPolicy, mustConsider: [
        { id: "current_customer", minEvidence: 1, selector },
        ...input.inspection.definition.contextPolicy.mustConsider.filter((rule) => rule.id !== "current_customer"),
      ] } });
    expect(() => validateClientCandidates({ ...input, inspection: { ...input.inspection, definition } }))
      .toThrow("response_invalid"); // When/Then
  });
}

it("rejects mustNotUse even when mustConsider matches", async () => {
  const input = await fixture(); // Given
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...input.inspection.definition,
    contextPolicy: { ...input.inspection.definition.contextPolicy, mustNotUse: [{ id: "blocked", selector: { sourceIds: ["orders.primary"] } }] } });
  expect(() => validateClientCandidates({ ...input, inspection: { ...input.inspection, definition } }))
    .toThrow("response_invalid"); // When/Then
});

it("rejects mayConsider when the binding matches mustConsider", async () => {
  const input = await fixture(); // Given
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...input.inspection.definition,
    contextPolicy: { ...input.inspection.definition.contextPolicy, mayConsider: [{ id: "optional", minEvidence: 1, selector: { sourceIds: ["orders.primary"] } }] } });
  const receipt = ScopeRequirementReceiptSchema.parse({ ...input.receipt,
    candidateReceipts: [{ ...acceptedFixture.expected, matchedPolicy: "mayConsider", matchedRuleIds: ["optional"] }] });
  expect(() => validateClientCandidates({ ...input, receipt, inspection: { ...input.inspection, definition } }))
    .toThrow("response_invalid"); // When/Then
});

it("rejects omitted matching rules", async () => {
  const input = await fixture(); // Given
  const definition = KnowledgeScopeDefinitionSchema.parse({ ...input.inspection.definition,
    contextPolicy: { ...input.inspection.definition.contextPolicy, mustConsider: [...input.inspection.definition.contextPolicy.mustConsider,
      { id: "also-required", minEvidence: 1, selector: { sourceClasses: ["records"] } }] } });
  expect(() => validateClientCandidates({ ...input, inspection: { ...input.inspection, definition } }))
    .toThrow("response_invalid"); // When/Then
});
