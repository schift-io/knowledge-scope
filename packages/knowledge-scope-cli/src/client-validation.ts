import type { CandidateEnvelope, ScopeRequirementReceipt } from "@schift-io/context-pack";
import type { KnowledgeScopeInspection } from "./application.js";
import { KnowledgeScopeClientError } from "./client-error.js";
import { canonicalJson } from "./json.js";
import { MAX_CANDIDATES } from "./limits.js";

type Binding = KnowledgeScopeInspection["mount"]["sourceBindings"][number];
type Selector = KnowledgeScopeInspection["definition"]["contextPolicy"]["mustConsider"][number]["selector"];
const matchesSelector = (selector: Selector, binding: Binding): boolean =>
  (selector.sourceIds === undefined || selector.sourceIds.includes(binding.sourceId)) &&
  (selector.sourceClasses === undefined || selector.sourceClasses.includes(binding.sourceClass)) &&
  (selector.authorities === undefined || selector.authorities.includes(binding.authority)) &&
  (selector.origins === undefined || (binding.origin !== undefined && selector.origins.includes(binding.origin)));

export const validateClientReceipt = (receipt: ScopeRequirementReceipt, inspection: KnowledgeScopeInspection): void => {
  const assertions = new Set(inspection.definition.evidence.coverageAssertions);
  const required = inspection.definition.contextPolicy.mustConsider.filter((rule) => assertions.has(rule.id));
  if (receipt.candidateReceipts.length > MAX_CANDIDATES || receipt.requirements.length !== required.length ||
    new Set(receipt.requirements.map((item) => item.requirementId)).size !== required.length) {
    throw new KnowledgeScopeClientError("response_invalid");
  }
  for (const requirement of receipt.requirements) {
    const rule = required.find((item) => item.id === requirement.requirementId);
    const observed = new Set(receipt.candidateReceipts.filter((item) => item.status === "accepted" &&
      item.matchedRuleIds.includes(requirement.requirementId)).map((item) => item.candidateSrn)).size;
    if (rule === undefined || requirement.requiredEvidence !== rule.minEvidence || requirement.observedEvidence !== observed ||
      requirement.satisfied !== (observed >= requirement.requiredEvidence)) throw new KnowledgeScopeClientError("response_invalid");
  }
  const ready = receipt.requirements.every((item) => item.satisfied);
  if ((receipt.status === "ready") !== ready) throw new KnowledgeScopeClientError("response_invalid");
};

export const validateClientCandidates = (input: Readonly<{
  inspection: KnowledgeScopeInspection; candidates: readonly CandidateEnvelope[]; receipt: ScopeRequirementReceipt;
}>): void => {
  const { inspection, candidates, receipt } = input;
  // An insufficient run intentionally withholds all payloads, even partially accepted evidence.
  if (receipt.status === "insufficient_evidence" && candidates.length === 0) return;
  const accepted = receipt.candidateReceipts.filter((item) => item.status === "accepted");
  if (accepted.length !== candidates.length) throw new KnowledgeScopeClientError("response_invalid");
  for (const [index, candidate] of candidates.entries()) {
    const binding = inspection.mount.sourceBindings.find((item) => item.sourceId === candidate.sourceId);
    if (inspection.mount.state !== "mounted" || candidate.installationId !== inspection.mount.installationId ||
      candidate.definitionDigest !== inspection.mount.definitionDigest || candidate.mountRevision !== inspection.mount.revision ||
      canonicalJson(candidate.scopeAuthority) !== canonicalJson(inspection.mount.scopeAuthority) ||
      candidate.effectiveScope.tenant !== inspection.mount.scopeAuthority.tenant || binding === undefined ||
      binding.sourceClass !== candidate.sourceClass || binding.providerRef !== candidate.providerRef ||
      binding.permissionMode !== candidate.permissionMode || !binding.operationIds.includes(candidate.operationId)) {
      throw new KnowledgeScopeClientError("identity_mismatch");
    }
    if (accepted[index]?.candidateSrn !== candidate.srn ||
      (inspection.definition.evidence.requireCitation && candidate.citation === undefined)) {
      throw new KnowledgeScopeClientError("response_invalid");
    }
    const acceptedReceipt = accepted[index];
    if (acceptedReceipt === undefined) throw new KnowledgeScopeClientError("response_invalid");
    const policy = inspection.definition.contextPolicy;
    const required = policy.mustConsider.filter((rule) => matchesSelector(rule.selector, binding));
    const rules = required.length > 0 ? required : (policy.mayConsider ?? []).filter((rule) => matchesSelector(rule.selector, binding));
    const authorityRank = inspection.definition.authority.precedence.indexOf(binding.authority);
    if (authorityRank < 0 || policy.mustNotUse.some((rule) => matchesSelector(rule.selector, binding)) ||
      acceptedReceipt.matchedPolicy !== (required.length > 0 ? "mustConsider" : "mayConsider") ||
      acceptedReceipt.matchedRuleIds.length === 0 || acceptedReceipt.matchedRuleIds.length !== rules.length ||
      new Set(acceptedReceipt.matchedRuleIds).size !== acceptedReceipt.matchedRuleIds.length ||
      acceptedReceipt.authorityRank !== authorityRank ||
      acceptedReceipt.matchedRuleIds.some((id) => !rules.some((rule) => rule.id === id))) {
      throw new KnowledgeScopeClientError("response_invalid");
    }
  }
};
