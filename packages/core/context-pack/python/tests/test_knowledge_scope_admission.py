from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

import schift_context_pack_contract as contract

SHARED_FIXTURES = (
    Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"
)


def _load_object(name: str) -> dict[str, contract.JsonValue]:
    value = contract.parse_json_value((SHARED_FIXTURES / name).read_bytes())
    assert isinstance(value, dict)
    return value


def _scenario() -> tuple[
    contract.KnowledgeScopeDefinition,
    contract.KnowledgeScopeMount,
    contract.CandidateEnvelope,
    contract.AuthorizationDecision,
    datetime,
    contract.JsonValue,
]:
    scenario = _load_object("admission-accepted.json")
    definition_name = scenario["definitionFixture"]
    mount_name = scenario["mountFixture"]
    candidate_value = scenario["candidate"]
    trusted_value = scenario["trustedAuthorizationDecision"]
    evaluated_at = scenario["evaluatedAt"]
    assert isinstance(definition_name, str)
    assert isinstance(mount_name, str)
    assert isinstance(candidate_value, dict)
    assert isinstance(trusted_value, dict)
    assert isinstance(evaluated_at, str)
    return (
        contract.KnowledgeScopeDefinition.model_validate(_load_object(definition_name)),
        contract.KnowledgeScopeMount.model_validate(_load_object(mount_name)),
        contract.CandidateEnvelope.model_validate(candidate_value),
        contract.AuthorizationDecision.model_validate(trusted_value),
        datetime.fromisoformat(evaluated_at),
        scenario["expected"],
    )


def test_admission_matches_shared_accepted_fixture() -> None:
    # Given: the portable definition, trusted mount, and independently trusted decision.
    definition, mount, candidate, trusted, evaluated_at, expected = _scenario()

    # When: pure admission evaluates the provider Candidate.
    receipt = contract.admit_candidate(definition, mount, candidate, evaluated_at, trusted)

    # Then: Python emits the exact shared camelCase receipt.
    assert contract.candidate_admission_json_value(receipt) == expected


@pytest.mark.parametrize("case_index", range(11))
def test_admission_matches_shared_denial_reasons(case_index: int) -> None:
    # Given: one shared fail-closed mutation over the accepted scenario.
    definition, mount, candidate, trusted, evaluated_at, _ = _scenario()
    matrix = _load_object("admission-denied.json")
    cases = matrix["cases"]
    assert isinstance(cases, list)
    case = cases[case_index]
    assert isinstance(case, dict)
    overrides = case.get("candidateOverrides", {})
    omissions = case.get("omitCandidateFields", [])
    assert isinstance(overrides, dict)
    assert isinstance(omissions, list)
    candidate_value = contract.candidate_envelope_json_value(candidate)
    assert isinstance(candidate_value, dict)
    payload = {**candidate_value, **overrides}
    for field in omissions:
        assert isinstance(field, str)
        del payload[field]
    candidate = contract.CandidateEnvelope.model_validate(payload)
    if case.get("mountMutation") == "unmounted":
        mount = mount.model_copy(update={"state": "unmounted", "source_bindings": ()})
    trusted_digest = case.get("trustedDecisionDigest")
    if isinstance(trusted_digest, str):
        trusted = trusted.model_copy(update={"decision_digest": trusted_digest})
    reason = case["reasonCode"]
    assert isinstance(reason, str)

    # When: the mutation crosses the admission boundary.
    receipt = contract.admit_candidate(definition, mount, candidate, evaluated_at, trusted)

    # Then: the first deterministic denial matches the shared reason.
    assert receipt.status == "denied"
    assert receipt.reason_code == reason


def test_admission_rejects_provider_evidence_drift() -> None:
    # Given: trusted identity fields with provider-native evidence modified after normalization.
    definition, mount, candidate, trusted, evaluated_at, _ = _scenario()
    evidence = candidate.provider_evidence.model_copy(update={"operation_id": "orders.other"})
    candidate = candidate.model_copy(update={"provider_evidence": evidence})

    # When: admission verifies the declared provider operation.
    receipt = contract.admit_candidate(definition, mount, candidate, evaluated_at, trusted)

    # Then: provider evidence cannot override the declaration.
    assert receipt.status == "denied"
    assert receipt.reason_code == "provider_evidence_mismatch"


@pytest.mark.parametrize(
    ("evidence_update", "reason"),
    [
        ({"connector_ref": "connector.other"}, "connector_ref_mismatch"),
        ({"action_id": "zendesk.other"}, "connector_action_mismatch"),
        ({"audit_persisted": False}, "connector_audit_missing"),
    ],
)
def test_admission_rejects_open_connector_identity_drift(
    evidence_update: dict[str, contract.JsonValue], reason: str
) -> None:
    # Given: the shared Connector Candidate with one provider-native field modified.
    definition = contract.KnowledgeScopeDefinition.model_validate(
        _load_object("valid-definition.json")
    )
    mount = contract.KnowledgeScopeMount.model_validate(_load_object("valid-mount.json"))
    candidate = contract.CandidateEnvelope.model_validate(_load_object("valid-candidate.json"))
    trusted = candidate.authorization_decision
    evidence = candidate.provider_evidence.model_copy(update=evidence_update)
    candidate = candidate.model_copy(update={"provider_evidence": evidence})

    # When: admission verifies Connector identity and durable audit correlation.
    receipt = contract.admit_candidate(
        definition,
        mount,
        candidate,
        datetime.fromisoformat("2026-09-22T09:02:00Z"),
        trusted,
    )

    # Then: provider-native drift fails closed with its stable reason.
    assert receipt.status == "denied"
    assert receipt.reason_code == reason


def test_admission_accepts_per_execution_connector_correlation() -> None:
    # Given: the Connector gateway provides a per-execution correlation identity.
    definition = contract.KnowledgeScopeDefinition.model_validate(
        _load_object("valid-definition.json")
    )
    mount = contract.KnowledgeScopeMount.model_validate(_load_object("valid-mount.json"))
    candidate = contract.CandidateEnvelope.model_validate(_load_object("valid-candidate.json"))
    trusted = candidate.authorization_decision
    evidence = candidate.provider_evidence.model_copy(
        update={"action_correlation_id": "request.20260922_001"}
    )
    candidate = candidate.model_copy(update={"provider_evidence": evidence})
    required = definition.context_policy.must_consider[0]
    selector = required.selector.model_copy(update={"source_ids": ("tickets.primary",)})
    required = required.model_copy(update={"selector": selector})
    policy = definition.context_policy.model_copy(
        update={"must_consider": (required, *definition.context_policy.must_consider[1:])}
    )
    definition = definition.model_copy(update={"context_policy": policy})

    # When: admission validates provider identity while trust is supplied by the control plane.
    receipt = contract.admit_candidate(
        definition,
        mount,
        candidate,
        datetime.fromisoformat("2026-09-22T09:02:00Z"),
        trusted,
    )

    # Then: correlation need not equal the static action ID.
    assert receipt.status == "accepted"


def test_admission_denies_raw_connector_audit_false() -> None:
    # Given: raw provider evidence explicitly reports that its audit was not persisted.
    definition = contract.KnowledgeScopeDefinition.model_validate(
        _load_object("valid-definition.json")
    )
    mount = contract.KnowledgeScopeMount.model_validate(_load_object("valid-mount.json"))
    candidate_payload = _load_object("valid-candidate.json")
    evidence = candidate_payload["providerEvidence"]
    assert isinstance(evidence, dict)
    evidence["auditPersisted"] = False
    candidate = contract.CandidateEnvelope.model_validate(candidate_payload)
    required = definition.context_policy.must_consider[0]
    selector = required.selector.model_copy(update={"source_ids": ("tickets.primary",)})
    required = required.model_copy(update={"selector": selector})
    policy = definition.context_policy.model_copy(
        update={"must_consider": (required, *definition.context_policy.must_consider[1:])}
    )
    definition = definition.model_copy(update={"context_policy": policy})

    # When: the raw false value reaches admission.
    receipt = contract.admit_candidate(
        definition,
        mount,
        candidate,
        datetime.fromisoformat("2026-09-22T09:02:00Z"),
        candidate.authorization_decision,
    )

    # Then: parsing succeeds but evidence is denied with the stable audit reason.
    assert receipt.status == "denied"
    assert receipt.reason_code == "connector_audit_missing"


def test_aggregate_admission_counts_unique_accepted_srns() -> None:
    # Given: a required rule needs one item and the same accepted Candidate is repeated.
    definition, mount, candidate, trusted, evaluated_at, _ = _scenario()
    duplicate = contract.CandidateAdmissionInput(
        candidate=candidate, trustedAuthorizationDecision=trusted
    )

    # When: aggregate admission receives the duplicate evidence twice.
    receipt = contract.admit_candidates(definition, mount, (duplicate, duplicate), evaluated_at)

    # Then: the SRN contributes once and the unrelated required rule remains unsatisfied.
    assert receipt.status == "insufficient_evidence"
    assert receipt.requirements[0].observed_evidence == 1
    assert receipt.requirements[1].observed_evidence == 0
