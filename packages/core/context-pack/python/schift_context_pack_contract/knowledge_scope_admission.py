"""Pure Candidate and aggregate admission for one mounted Knowledge Scope."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Final, Literal

from schift_context_pack_contract.knowledge_scope_policy import (
    matches_selector,
    matching_requirements,
    provider_denial,
)
from schift_context_pack_contract.knowledge_scope_receipts import (
    AdmissionDenialReason,
    CandidateAdmissionAccepted,
    CandidateAdmissionDenied,
    CandidateAdmissionInput,
    CandidateAdmissionResult,
    ScopeRequirementReceipt,
    ScopeRequirementStatus,
)

if TYPE_CHECKING:
    from schift_context_pack_contract.knowledge_scope import (
        KnowledgeRequirement,
        KnowledgeScopeDefinition,
    )
    from schift_context_pack_contract.knowledge_scope_candidate import (
        AuthorizationDecision,
        CandidateEnvelope,
    )
    from schift_context_pack_contract.knowledge_scope_capabilities import QueryCapability
    from schift_context_pack_contract.knowledge_scope_mount import (
        KnowledgeScopeMount,
        KnowledgeSourceBinding,
    )

_MAX_FUTURE_SKEW_SECONDS: Final = 60


@dataclass(frozen=True, slots=True)
class _AdmissionFacts:
    definition: KnowledgeScopeDefinition
    mount: KnowledgeScopeMount
    candidate: CandidateEnvelope
    evaluated_at: datetime
    trusted_decision: AuthorizationDecision
    binding: KnowledgeSourceBinding | None
    capability: QueryCapability | None
    must_matches: tuple[KnowledgeRequirement, ...]
    may_matches: tuple[KnowledgeRequirement, ...]


def _facts(
    definition: KnowledgeScopeDefinition,
    mount: KnowledgeScopeMount,
    admission: CandidateAdmissionInput,
    evaluated_at: datetime,
) -> _AdmissionFacts:
    candidate = admission.candidate
    binding = next(
        (item for item in mount.source_bindings if item.source_id == candidate.source_id), None
    )
    capability = next(
        (item for item in definition.capabilities if item.operation_id == candidate.operation_id),
        None,
    )
    must = (
        matching_requirements(definition.context_policy.must_consider, binding) if binding else ()
    )
    may = matching_requirements(definition.context_policy.may_consider, binding) if binding else ()
    return _AdmissionFacts(
        definition,
        mount,
        candidate,
        evaluated_at,
        admission.trusted_authorization_decision,
        binding,
        capability,
        must,
        may,
    )


def _effective_scope_is_valid(candidate: CandidateEnvelope) -> bool:
    scope = candidate.effective_scope
    if scope.tenant != candidate.scope_authority.tenant:
        return False
    descendants = (scope.namespace, scope.subject, scope.session)
    gap = False
    for descendant in descendants:
        if descendant is None:
            gap = True
        elif gap:
            return False
    return True


def _identity_denial(facts: _AdmissionFacts) -> AdmissionDenialReason | None:
    candidate = facts.candidate
    mount = facts.mount
    checks: tuple[tuple[bool, AdmissionDenialReason], ...] = (
        (mount.state == "mounted", "installation_not_mounted"),
        (candidate.installation_id == mount.installation_id, "installation_id_mismatch"),
        (candidate.definition_digest == mount.definition_digest, "definition_digest_mismatch"),
        (candidate.mount_revision == mount.revision, "mount_revision_mismatch"),
        (
            candidate.authorization_decision == facts.trusted_decision,
            "authorization_decision_untrusted",
        ),
        (candidate.scope_authority == mount.scope_authority, "scope_authority_mismatch"),
        (_effective_scope_is_valid(candidate), "effective_scope_invalid"),
    )
    return next((reason for valid, reason in checks if not valid), None)


def _binding_denial(facts: _AdmissionFacts) -> AdmissionDenialReason | None:
    binding = facts.binding
    if binding is None:
        return "source_binding_not_found"
    candidate = facts.candidate
    checks: tuple[tuple[bool, AdmissionDenialReason], ...] = (
        (candidate.source_class == binding.source_class, "source_class_mismatch"),
        (candidate.provider_ref == binding.provider_ref, "provider_ref_mismatch"),
        (candidate.operation_id in binding.operation_ids, "operation_not_bound"),
        (binding.permission_mode != "unsupported", "permission_mode_unsupported"),
        (candidate.permission_mode == binding.permission_mode, "permission_mode_mismatch"),
    )
    return next((reason for valid, reason in checks if not valid), None)


def _policy_denial(facts: _AdmissionFacts) -> AdmissionDenialReason | None:
    binding = facts.binding
    if binding is None:
        return None
    if binding.authority not in facts.definition.authority.precedence:
        return "source_authority_not_allowed"
    if any(
        matches_selector(rule.selector, binding)
        for rule in facts.definition.context_policy.must_not_use
    ):
        return "must_not_use"
    return None if facts.must_matches or facts.may_matches else "context_policy_no_match"


def _evidence_denial(facts: _AdmissionFacts) -> AdmissionDenialReason | None:
    candidate = facts.candidate
    if facts.definition.evidence.require_citation and candidate.citation is None:
        return "citation_required"
    if candidate.freshness is None:
        return "freshness_required"
    freshness = datetime.fromisoformat(candidate.freshness)
    future_seconds = (freshness - facts.evaluated_at).total_seconds()
    if future_seconds > _MAX_FUTURE_SKEW_SECONDS:
        return "freshness_in_future"
    if facts.capability is None:
        return None
    matched = facts.must_matches or facts.may_matches
    ceilings = [facts.definition.evidence.freshness.default_max_age_seconds]
    if facts.capability.freshness is not None:
        ceilings.append(facts.capability.freshness.max_age_seconds)
    ceilings.extend(rule.max_age_seconds for rule in matched if rule.max_age_seconds is not None)
    return (
        "source_stale" if (facts.evaluated_at - freshness).total_seconds() > min(ceilings) else None
    )


def _admit(facts: _AdmissionFacts) -> CandidateAdmissionResult:
    for denial in (_identity_denial(facts), _binding_denial(facts)):
        if denial is not None:
            return CandidateAdmissionDenied(candidateSrn=facts.candidate.srn, reasonCode=denial)
    if facts.capability is None:
        return CandidateAdmissionDenied(
            candidateSrn=facts.candidate.srn, reasonCode="capability_not_found"
        )
    binding = facts.binding
    if binding is None:
        return CandidateAdmissionDenied(
            candidateSrn=facts.candidate.srn, reasonCode="source_binding_not_found"
        )
    native_denial = provider_denial(facts.capability, binding, facts.candidate)
    if native_denial is None and not set(facts.capability.required_provider_scopes).issubset(
        facts.candidate.provider_scopes
    ):
        native_denial = "provider_scopes_missing"
    for denial in (native_denial, _policy_denial(facts), _evidence_denial(facts)):
        if denial is not None:
            return CandidateAdmissionDenied(candidateSrn=facts.candidate.srn, reasonCode=denial)
    matched = facts.must_matches or facts.may_matches
    return CandidateAdmissionAccepted(
        candidateSrn=facts.candidate.srn,
        matchedPolicy="mustConsider" if facts.must_matches else "mayConsider",
        matchedRuleIds=tuple(rule.id for rule in matched),
        authorityRank=facts.definition.authority.precedence.index(binding.authority),
    )


def admit_candidate(
    definition: KnowledgeScopeDefinition,
    mount: KnowledgeScopeMount,
    candidate: CandidateEnvelope,
    evaluated_at: datetime,
    trusted_authorization_decision: AuthorizationDecision,
) -> CandidateAdmissionResult:
    """Return the first deterministic denial or accepted Candidate receipt."""
    admission = CandidateAdmissionInput(
        candidate=candidate, trustedAuthorizationDecision=trusted_authorization_decision
    )
    return _admit(_facts(definition, mount, admission, evaluated_at))


def admit_candidates(
    definition: KnowledgeScopeDefinition,
    mount: KnowledgeScopeMount,
    candidates: tuple[CandidateAdmissionInput, ...],
    evaluated_at: datetime,
) -> ScopeRequirementReceipt:
    """Admit a Candidate set and enforce every declared coverage minimum."""
    receipts = tuple(_admit(_facts(definition, mount, item, evaluated_at)) for item in candidates)
    requirements = tuple(
        ScopeRequirementStatus(
            requirementId=requirement.id,
            requiredEvidence=requirement.min_evidence,
            observedEvidence=len(
                {
                    receipt.candidate_srn
                    for receipt in receipts
                    if receipt.status == "accepted" and requirement.id in receipt.matched_rule_ids
                }
            ),
            satisfied=len(
                {
                    receipt.candidate_srn
                    for receipt in receipts
                    if receipt.status == "accepted" and requirement.id in receipt.matched_rule_ids
                }
            )
            >= requirement.min_evidence,
        )
        for requirement_id in definition.evidence.coverage_assertions
        for requirement in definition.context_policy.must_consider
        if requirement.id == requirement_id
    )
    status: Literal["ready", "insufficient_evidence"] = (
        "ready" if all(item.satisfied for item in requirements) else "insufficient_evidence"
    )
    return ScopeRequirementReceipt(
        status=status, requirements=requirements, candidateReceipts=receipts
    )
