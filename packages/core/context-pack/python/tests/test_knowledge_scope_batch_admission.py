from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

import schift_context_pack_contract as contract

FIXTURES = Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"


def _object(name: str) -> dict[str, contract.JsonValue]:
    value = contract.parse_json_value((FIXTURES / name).read_bytes())
    assert isinstance(value, dict)
    return value


def _evidence() -> tuple[contract.CandidateAdmissionInput, contract.CandidateAdmissionInput]:
    records = _object("admission-accepted.json")["candidate"]
    assert isinstance(records, dict)
    document: dict[str, contract.JsonValue] = {
        **records,
        "srn": "srn:schift:acme:document:manuals/reset",
        "sourceId": "product.manuals",
        "sourceClass": "document",
        "providerRef": "index.product_manuals",
        "operationId": "search_product_manuals",
        "permissionMode": "mirrored",
        "permission": "tenant.acme.manuals.read",
        "providerScopes": [],
        "providerEvidence": {"kind": "schift_search", "indexRef": "index.product_manuals"},
        "payload": {"text": "Use the reset link."},
        "citation": {"uri": "schift://manuals/reset"},
    }
    record_candidate = contract.CandidateEnvelope.model_validate(records)
    document_candidate = contract.CandidateEnvelope.model_validate(document)
    return (
        contract.CandidateAdmissionInput(
            candidate=record_candidate,
            trustedAuthorizationDecision=record_candidate.authorization_decision,
        ),
        contract.CandidateAdmissionInput(
            candidate=document_candidate,
            trustedAuthorizationDecision=document_candidate.authorization_decision,
        ),
    )


@pytest.mark.parametrize("indices", [(0,), (1,), (0, 1)])
def test_combined_document_and_records_evidence_satisfies_shared_policy(
    indices: tuple[int, ...],
) -> None:
    # Given: two independently admitted operations supply separate required source classes.
    definition = contract.KnowledgeScopeDefinition.model_validate(_object("valid-definition.json"))
    mount = contract.KnowledgeScopeMount.model_validate(_object("valid-mount.json"))
    evidence = _evidence()
    scenario = _object("admission-batch.json")
    evaluated_at = scenario["evaluatedAt"]
    assert isinstance(evaluated_at, str)

    # When: aggregate admission evaluates one or both operations under the same mount.
    receipt = contract.admit_candidates(
        definition,
        mount,
        tuple(evidence[index] for index in indices),
        datetime.fromisoformat(evaluated_at),
    )

    # Then: only the combined evidence satisfies every required source class.
    assert receipt.status == ("ready" if len(indices) == 2 else "insufficient_evidence")
    if len(indices) == 2:
        serialized = contract.scope_requirement_json_value(receipt)
        assert isinstance(serialized, dict)
        assert serialized["requirements"] == scenario["expectedReadyRequirements"]


def test_combined_evidence_is_denied_after_mount_revision_changes() -> None:
    # Given: both operations returned evidence from the previous mount revision.
    definition = contract.KnowledgeScopeDefinition.model_validate(_object("valid-definition.json"))
    mount = contract.KnowledgeScopeMount.model_validate(_object("valid-mount.json"))
    changed_mount = mount.model_copy(update={"revision": 2})

    # When: admission uses the current mount revision.
    receipt = contract.admit_candidates(
        definition, changed_mount, _evidence(), datetime.fromisoformat("2026-09-22T09:02:00Z")
    )

    # Then: no old operation contributes to coverage.
    assert receipt.status == "insufficient_evidence"
    assert all(requirement.observed_evidence == 0 for requirement in receipt.requirements)
    assert all(item.status == "denied" for item in receipt.candidate_receipts)
