import type {
  CandidateAdmissionReceipt,
  AdmissionDenialReason,
  ScopeRequirementReceipt,
} from "./knowledge-scope-execution.js";
import type { KnowledgeScopeMount } from "./knowledge-scope-mount.js";
import type {
  AuthorizationDecision,
  CandidateEnvelope,
  KnowledgeScopeDefinition,
  QueryCapability,
} from "./knowledge-scope.js";

export const ADMISSION_DENIAL_REASONS = [
  "installation_not_mounted", "installation_id_mismatch", "definition_digest_mismatch",
  "mount_revision_mismatch", "authorization_decision_untrusted", "scope_authority_mismatch",
  "effective_scope_invalid", "source_binding_not_found", "source_class_mismatch",
  "provider_ref_mismatch", "operation_not_bound", "capability_not_found",
  "permission_mode_unsupported", "permission_mode_mismatch", "source_authority_not_allowed",
  "must_not_use", "context_policy_no_match", "provider_scopes_missing",
  "provider_evidence_mismatch", "connector_ref_mismatch", "connector_action_mismatch",
  "connector_run_missing", "connector_audit_missing",
  "citation_required", "freshness_required", "freshness_in_future", "source_stale",
] as const satisfies readonly AdmissionDenialReason[];

export type KnowledgeScopeAdmissionInput = Readonly<{
  definition: KnowledgeScopeDefinition;
  mount: KnowledgeScopeMount;
  candidate: CandidateEnvelope;
  evaluatedAt: Date;
  trustedAuthorizationDecision: AuthorizationDecision;
}>;
export type KnowledgeScopeBatchAdmissionInput = Readonly<{
  definition: KnowledgeScopeDefinition;
  mount: KnowledgeScopeMount;
  candidates: readonly Readonly<{
    candidate: CandidateEnvelope;
    trustedAuthorizationDecision: AuthorizationDecision;
  }>[];
  evaluatedAt: Date;
}>;

type Binding = KnowledgeScopeMount["sourceBindings"][number];
type Selector = KnowledgeScopeDefinition["contextPolicy"]["mustConsider"][number]["selector"];

const deny = (candidateSrn: string, reasonCode: AdmissionDenialReason): CandidateAdmissionReceipt => ({
  status: "denied", candidateSrn, reasonCode,
});
const sameAuthorization = (left: AuthorizationDecision, right: AuthorizationDecision): boolean =>
  left.status === right.status && left.decisionId === right.decisionId && left.decisionDigest === right.decisionDigest;
const sameAuthority = (
  candidate: CandidateEnvelope["scopeAuthority"],
  mount: KnowledgeScopeMount["scopeAuthority"],
): boolean => candidate.organizationId === mount.organizationId && candidate.tenant === mount.tenant;
const isNarrowedScope = (candidate: CandidateEnvelope): boolean => {
  const scope = candidate.effectiveScope;
  if (scope.tenant !== candidate.scopeAuthority.tenant) return false;
  if (scope.subject !== undefined && scope.namespace === undefined) return false;
  return scope.session === undefined || scope.subject !== undefined;
};
const matchesSelector = (selector: Selector, binding: Binding): boolean =>
  (selector.sourceIds === undefined || selector.sourceIds.includes(binding.sourceId)) &&
  (selector.sourceClasses === undefined || selector.sourceClasses.includes(binding.sourceClass)) &&
  (selector.authorities === undefined || selector.authorities.includes(binding.authority)) &&
  (selector.origins === undefined || (binding.origin !== undefined && selector.origins.includes(binding.origin)));
const maxAgeFor = (
  definition: KnowledgeScopeDefinition,
  rules: readonly KnowledgeScopeDefinition["contextPolicy"]["mustConsider"][number][],
  capability: QueryCapability,
): number => Math.min(
  definition.evidence.freshness.defaultMaxAgeSeconds,
  ...rules.flatMap((rule) => rule.maxAgeSeconds === undefined ? [] : [rule.maxAgeSeconds]),
  ...(capability.freshness === undefined ? [] : [capability.freshness.maxAgeSeconds]),
);

const providerEvidenceDenial = (
  capability: QueryCapability,
  binding: Binding,
  candidate: CandidateEnvelope,
): AdmissionDenialReason | undefined => {
  const evidence = candidate.providerEvidence;
  if (capability.provider.kind !== evidence.kind) return "provider_evidence_mismatch";
  switch (capability.provider.kind) {
    case "records_operation":
      return evidence.kind === "records_operation" && evidence.operationId === capability.provider.operationId
        ? undefined : "provider_evidence_mismatch";
    case "open_connector_action":
      if (evidence.kind !== "open_connector_action") return "provider_evidence_mismatch";
      if (binding.connectorRef !== capability.provider.connectorRef || evidence.connectorRef !== capability.provider.connectorRef) {
        return "connector_ref_mismatch";
      }
      if (evidence.actionId !== capability.provider.actionId) return "connector_action_mismatch";
      if (evidence.connectorRunId.length === 0) return "connector_run_missing";
      return evidence.auditPersisted ? undefined : "connector_audit_missing";
    case "schift_search":
      return evidence.kind === "schift_search" && evidence.indexRef === capability.provider.indexRef
        ? undefined : "provider_evidence_mismatch";
    case "local_documents":
      return evidence.kind === "local_documents" && evidence.indexRef === capability.provider.indexRef
        ? undefined : "provider_evidence_mismatch";
    case "web_search":
      return evidence.kind === "web_search" && evidence.provider === capability.provider.provider
        ? undefined : "provider_evidence_mismatch";
  }
};

export const admitKnowledgeScopeCandidate = (
  input: KnowledgeScopeAdmissionInput,
): CandidateAdmissionReceipt => {
  const { definition, mount, candidate } = input;
  const reject = (reason: AdmissionDenialReason) => deny(candidate.srn, reason);
  if (mount.state !== "mounted") return reject("installation_not_mounted");
  if (candidate.installationId !== mount.installationId) return reject("installation_id_mismatch");
  if (candidate.definitionDigest !== mount.definitionDigest) return reject("definition_digest_mismatch");
  if (candidate.mountRevision !== mount.revision) return reject("mount_revision_mismatch");
  if (!sameAuthorization(candidate.authorizationDecision, input.trustedAuthorizationDecision)) {
    return reject("authorization_decision_untrusted");
  }
  if (!sameAuthority(candidate.scopeAuthority, mount.scopeAuthority)) return reject("scope_authority_mismatch");
  if (!isNarrowedScope(candidate)) return reject("effective_scope_invalid");

  const binding = mount.sourceBindings.find((source) => source.sourceId === candidate.sourceId);
  if (binding === undefined) return reject("source_binding_not_found");
  if (binding.sourceClass !== candidate.sourceClass) return reject("source_class_mismatch");
  if (binding.providerRef !== candidate.providerRef) return reject("provider_ref_mismatch");
  if (!binding.operationIds.includes(candidate.operationId)) return reject("operation_not_bound");
  if (binding.permissionMode === "unsupported") return reject("permission_mode_unsupported");
  if (binding.permissionMode !== candidate.permissionMode) return reject("permission_mode_mismatch");

  const capability = definition.capabilities.find((item) => item.operationId === candidate.operationId);
  if (capability === undefined) return reject("capability_not_found");
  const providerDenial = providerEvidenceDenial(capability, binding, candidate);
  if (providerDenial !== undefined) return reject(providerDenial);
  if (!(capability.requiredProviderScopes ?? []).every((scope) => candidate.providerScopes.includes(scope))) {
    return reject("provider_scopes_missing");
  }
  const authorityRank = definition.authority.precedence.indexOf(binding.authority);
  if (authorityRank < 0) return reject("source_authority_not_allowed");
  if (definition.contextPolicy.mustNotUse.some((rule) => matchesSelector(rule.selector, binding))) {
    return reject("must_not_use");
  }
  const required = definition.contextPolicy.mustConsider.filter((rule) => matchesSelector(rule.selector, binding));
  const optional = (definition.contextPolicy.mayConsider ?? []).filter((rule) => matchesSelector(rule.selector, binding));
  const matchedRules = required.length > 0 ? required : optional;
  if (matchedRules.length === 0) return reject("context_policy_no_match");
  if (definition.evidence.requireCitation && candidate.citation === undefined) return reject("citation_required");
  if (candidate.freshness === undefined) return reject("freshness_required");
  const ageMilliseconds = input.evaluatedAt.getTime() - Date.parse(candidate.freshness);
  if (ageMilliseconds < -60_000) return reject("freshness_in_future");
  if (ageMilliseconds > maxAgeFor(definition, matchedRules, capability) * 1_000) return reject("source_stale");
  return { status: "accepted", candidateSrn: candidate.srn,
    matchedPolicy: required.length > 0 ? "mustConsider" : "mayConsider",
    matchedRuleIds: matchedRules.map((rule) => rule.id), authorityRank };
};

export const admitKnowledgeScopeCandidates = (
  input: KnowledgeScopeBatchAdmissionInput,
): ScopeRequirementReceipt => {
  const candidateReceipts = input.candidates.map((entry) => admitKnowledgeScopeCandidate({
    definition: input.definition, mount: input.mount, candidate: entry.candidate,
    evaluatedAt: input.evaluatedAt, trustedAuthorizationDecision: entry.trustedAuthorizationDecision,
  }));
  const asserted = new Set(input.definition.evidence.coverageAssertions);
  const requirements = input.definition.contextPolicy.mustConsider
    .filter((requirement) => asserted.has(requirement.id))
    .map((requirement) => {
      const observedEvidence = new Set(candidateReceipts.filter((receipt) =>
        receipt.status === "accepted" && receipt.matchedRuleIds.includes(requirement.id))
        .map((receipt) => receipt.candidateSrn)).size;
      return { requirementId: requirement.id, requiredEvidence: requirement.minEvidence,
        observedEvidence, satisfied: observedEvidence >= requirement.minEvidence };
    });
  return { status: requirements.every((requirement) => requirement.satisfied) ? "ready" : "insufficient_evidence",
    requirements, candidateReceipts };
};

export type AdmissionResult = CandidateAdmissionReceipt;
