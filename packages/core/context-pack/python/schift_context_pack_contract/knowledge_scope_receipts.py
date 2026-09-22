"""Knowledge Scope Candidate and aggregate admission receipt contracts."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictInt

from schift_context_pack_contract.json_boundary import JsonValue, to_json_value
from schift_context_pack_contract.knowledge_scope_candidate import (
    AuthorizationDecision,  # noqa: TC001
    CandidateEnvelope,  # noqa: TC001
)
from schift_context_pack_contract.manifest import ContractModel

AdmissionDenialReason = Literal[
    "installation_not_mounted",
    "installation_id_mismatch",
    "definition_digest_mismatch",
    "mount_revision_mismatch",
    "authorization_decision_untrusted",
    "scope_authority_mismatch",
    "effective_scope_invalid",
    "source_binding_not_found",
    "source_class_mismatch",
    "provider_ref_mismatch",
    "operation_not_bound",
    "capability_not_found",
    "permission_mode_unsupported",
    "permission_mode_mismatch",
    "source_authority_not_allowed",
    "must_not_use",
    "context_policy_no_match",
    "provider_scopes_missing",
    "provider_evidence_mismatch",
    "connector_ref_mismatch",
    "connector_action_mismatch",
    "connector_run_missing",
    "connector_audit_missing",
    "citation_required",
    "freshness_required",
    "freshness_in_future",
    "source_stale",
]


class CandidateAdmissionAccepted(ContractModel):
    status: Literal["accepted"] = "accepted"
    candidate_srn: str = Field(alias="candidateSrn")
    matched_policy: Literal["mustConsider", "mayConsider"] = Field(alias="matchedPolicy")
    matched_rule_ids: tuple[str, ...] = Field(alias="matchedRuleIds")
    authority_rank: Annotated[StrictInt, Field(ge=0)] = Field(alias="authorityRank")


class CandidateAdmissionDenied(ContractModel):
    status: Literal["denied"] = "denied"
    candidate_srn: str = Field(alias="candidateSrn")
    reason_code: AdmissionDenialReason = Field(alias="reasonCode")


CandidateAdmissionResult = CandidateAdmissionAccepted | CandidateAdmissionDenied


class CandidateAdmissionInput(ContractModel):
    candidate: CandidateEnvelope
    trusted_authorization_decision: AuthorizationDecision = Field(
        alias="trustedAuthorizationDecision"
    )


class ScopeRequirementStatus(ContractModel):
    requirement_id: str = Field(alias="requirementId")
    required_evidence: Annotated[StrictInt, Field(ge=1)] = Field(alias="requiredEvidence")
    observed_evidence: Annotated[StrictInt, Field(ge=0)] = Field(alias="observedEvidence")
    satisfied: StrictBool


class ScopeRequirementReceipt(ContractModel):
    status: Literal["ready", "insufficient_evidence"]
    requirements: tuple[ScopeRequirementStatus, ...]
    candidate_receipts: tuple[CandidateAdmissionResult, ...] = Field(alias="candidateReceipts")


def candidate_admission_json_value(result: CandidateAdmissionResult) -> JsonValue:
    """Return one normalized camelCase Candidate receipt."""
    return to_json_value(result.model_dump_json(by_alias=True))


def scope_requirement_json_value(result: ScopeRequirementReceipt) -> JsonValue:
    """Return one normalized camelCase aggregate receipt."""
    return to_json_value(result.model_dump_json(by_alias=True))
