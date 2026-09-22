from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

import schift_context_pack_contract as contract

SHARED_FIXTURES = (
    Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"
)


def _definition_payload() -> dict[str, contract.JsonValue]:
    return {
        "packId": "support.knowledge",
        "version": "1.0.0",
        "responsibility": "support.answers",
        "scope": {
            "root": "tenant",
            "descendants": ["namespace", "subject", "session"],
        },
        "capabilities": [
            {
                "operationId": "search_tickets",
                "provider": {
                    "kind": "open_connector_action",
                    "actionId": "zendesk.search",
                    "connectorRef": "connector.zendesk",
                },
                "inputSchemaRef": "schema/input.json",
                "resultSchemaRef": "schema/result.json",
                "requiredProviderScopes": ["tickets:read"],
            }
        ],
        "contextPolicy": {
            "mustConsider": [
                {
                    "id": "support.tickets",
                    "selector": {"sourceIds": ["tickets.primary"]},
                    "minEvidence": 2,
                }
            ],
            "mustNotUse": [
                {
                    "id": "support.private",
                    "selector": {"sourceIds": ["tickets.private"]},
                }
            ],
        },
        "authority": {
            "precedence": ["primary", "operational"],
            "allowed": ["read"],
            "forbidden": ["send", "approve", "mutate_source", "workflow"],
        },
        "evidence": {
            "requireCitation": True,
            "freshness": {"defaultMaxAgeSeconds": 300},
            "coverageAssertions": ["support.tickets"],
        },
    }


def _mount_payload(definition_digest: str) -> dict[str, contract.JsonValue]:
    return {
        "installationId": "installation.acme",
        "definitionDigest": definition_digest,
        "scopeAuthority": {"organizationId": "org.acme", "tenant": "tenant.acme"},
        "sourceBindings": [
            {
                "sourceId": "tickets.primary",
                "sourceClass": "records",
                "providerRef": "zendesk.search",
                "connectorRef": "connector.zendesk",
                "authority": "primary",
                "permissionMode": "live",
                "operationIds": ["search_tickets"],
            }
        ],
        "state": "mounted",
        "revision": 3,
    }


def _candidate_payload(
    definition_digest: str,
    *,
    srn: str = "srn:schift:acme:records:tickets/ticket_123",
) -> dict[str, contract.JsonValue]:
    return {
        "srn": srn,
        "sourceId": "tickets.primary",
        "sourceClass": "records",
        "providerRef": "zendesk.search",
        "installationId": "installation.acme",
        "definitionDigest": definition_digest,
        "mountRevision": 3,
        "operationId": "search_tickets",
        "scopeAuthority": {"organizationId": "org.acme", "tenant": "tenant.acme"},
        "effectiveScope": {"tenant": "tenant.acme"},
        "authorizationDecision": {
            "decisionId": "decision.allowed",
            "decisionDigest": "sha256:" + ("b" * 64),
            "status": "allowed",
        },
        "revision": "revision.1",
        "permission": "tenant.acme.support.read",
        "permissionMode": "live",
        "providerScopes": ["tickets:read"],
        "providerEvidence": {
            "kind": "open_connector_action",
            "connectorRef": "connector.zendesk",
            "actionId": "zendesk.search",
            "connectorRunId": "run.123",
            "actionCorrelationId": "zendesk.search",
            "auditPersisted": True,
        },
        "freshness": "2026-09-22T08:00:00Z",
        "payload": {"id": "ticket_123"},
        "citation": {"uri": "https://support.example/tickets/123"},
    }


def test_definition_excludes_mount_and_digest_is_definition_only() -> None:
    # Given: a portable definition and server-owned mount state.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    digest = contract.knowledge_scope_definition_digest(definition)
    mount = contract.KnowledgeScopeMount.model_validate(_mount_payload(digest))

    # When: the compatibility view is materialized at two mount revisions.
    first = contract.materialize_knowledge_scope_pack(definition, mount)
    second = contract.materialize_knowledge_scope_pack(
        definition,
        mount.model_copy(update={"revision": mount.revision + 1}),
    )

    # Then: the portable digest does not include server-owned revision state.
    assert first.installation.pack_digest == digest
    assert second.installation.pack_digest == digest
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopeDefinition.model_validate(
            {**_definition_payload(), "installation": first.installation.model_dump(by_alias=True)}
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [("packId", " support.knowledge"), ("responsibility", "support.answers ")],
)
def test_definition_rejects_identifier_whitespace(field: str, value: str) -> None:
    # Given: a portable identifier has leading or trailing whitespace.
    payload = {**_definition_payload(), field: value}

    # When / Then: Python rejects rather than silently trimming wire input.
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopeDefinition.model_validate(payload)


def test_lock_inventory_is_canonical_and_detects_tampering() -> None:
    # Given: exactly one definition and its referenced schema files.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    files: contract.KnowledgeScopeJsonFiles = {
        "scope.json": _definition_payload(),
        "schema/input.json": {"type": "object"},
        "schema/result.json": {"type": "object"},
    }

    # When: the deterministic lock is built twice.
    first = contract.build_knowledge_scope_lock(definition, files)
    second = contract.build_knowledge_scope_lock(definition, files)

    # Then: order and digests are reproducible and changed content fails verification.
    assert first == second
    assert tuple(item.path for item in first.files) == tuple(
        sorted(item.path for item in first.files)
    )
    assert contract.verify_knowledge_scope_lock(definition, files, first)
    tampered: contract.KnowledgeScopeJsonFiles = {
        **files,
        "schema/result.json": {"type": "array"},
    }
    assert not contract.verify_knowledge_scope_lock(definition, tampered, first)


def test_lock_normalizes_integral_float_json_numbers() -> None:
    # Given: equivalent schema JSON uses integer and exponent-style integral number values.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    integer_files: contract.KnowledgeScopeJsonFiles = {
        "scope.json": _definition_payload(),
        "schema/input.json": {"type": "number", "minimum": 1},
        "schema/result.json": {"type": "number", "maximum": 2},
    }
    float_files: contract.KnowledgeScopeJsonFiles = {
        "scope.json": _definition_payload(),
        "schema/input.json": {"type": "number", "minimum": 1.0},
        "schema/result.json": {"type": "number", "maximum": 2e0},
    }

    # When: both inventories are locked.
    integer_lock = contract.build_knowledge_scope_lock(definition, integer_files)
    float_lock = contract.build_knowledge_scope_lock(definition, float_files)

    # Then: ECMAScript and Python numeric spellings produce the same canonical bytes.
    assert float_lock == integer_lock


@pytest.mark.parametrize("number", [1.5, math.inf, 2**53])
def test_lock_rejects_nonportable_json_numbers(number: float) -> None:
    # Given: a schema contains a non-integral, non-finite, or unsafe integer value.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    files: contract.KnowledgeScopeJsonFiles = {
        "scope.json": _definition_payload(),
        "schema/input.json": {"type": "number", "minimum": number},
        "schema/result.json": {"type": "number"},
    }

    # When / Then: the lock refuses a number that cannot round-trip across runtimes.
    with pytest.raises(contract.KnowledgeScopeLockError):
        _ = contract.build_knowledge_scope_lock(definition, files)


def test_admission_requires_the_trusted_decision_and_rejects_future_evidence() -> None:
    # Given: a valid definition, mount, candidate, and independently trusted decision.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    digest = contract.knowledge_scope_definition_digest(definition)
    mount = contract.KnowledgeScopeMount.model_validate(_mount_payload(digest))
    candidate = contract.CandidateEnvelope.model_validate(_candidate_payload(digest))
    trusted = candidate.authorization_decision
    evaluated_at = datetime(2026, 9, 22, 8, 1, tzinfo=UTC)

    # When: the supplied trust proof differs, then evidence arrives too far in the future.
    untrusted = contract.admit_candidate(
        definition,
        mount,
        candidate,
        evaluated_at,
        trusted.model_copy(update={"decision_id": "decision.other"}),
    )
    future_candidate = candidate.model_copy(
        update={"freshness": (evaluated_at + timedelta(seconds=61)).isoformat()}
    )
    future = contract.admit_candidate(
        definition,
        mount,
        future_candidate,
        evaluated_at,
        trusted,
    )

    # Then: both provider-controlled trust escalation attempts fail closed.
    assert untrusted.status == "denied"
    assert future.status == "denied"
    assert untrusted.reason_code == "authorization_decision_untrusted"
    assert future.reason_code == "freshness_in_future"


def test_aggregate_admission_enforces_coverage_minimum() -> None:
    # Given: one required rule needs two Candidates but only one is supplied.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    digest = contract.knowledge_scope_definition_digest(definition)
    mount = contract.KnowledgeScopeMount.model_validate(_mount_payload(digest))
    candidate = contract.CandidateEnvelope.model_validate(_candidate_payload(digest))
    admission_input = contract.CandidateAdmissionInput(
        candidate=candidate,
        trustedAuthorizationDecision=candidate.authorization_decision,
    )

    # When: aggregate admission evaluates the evidence set.
    receipt = contract.admit_candidates(
        definition,
        mount,
        (admission_input,),
        datetime(2026, 9, 22, 8, 1, tzinfo=UTC),
    )

    # Then: accepted single evidence is still insufficient at Scope level.
    assert receipt.status == "insufficient_evidence"
    assert receipt.requirements[0].required_evidence == 2
    assert receipt.requirements[0].observed_evidence == 1
    assert receipt.requirements[0].satisfied is False


def test_aggregate_admission_does_not_double_count_one_candidate() -> None:
    # Given: the same accepted Candidate appears twice in one admission batch.
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    digest = contract.knowledge_scope_definition_digest(definition)
    mount = contract.KnowledgeScopeMount.model_validate(_mount_payload(digest))
    candidate = contract.CandidateEnvelope.model_validate(_candidate_payload(digest))
    item = contract.CandidateAdmissionInput(
        candidate=candidate,
        trustedAuthorizationDecision=candidate.authorization_decision,
    )

    # When: aggregate admission evaluates both duplicate entries.
    receipt = contract.admit_candidates(
        definition,
        mount,
        (item, item),
        datetime(2026, 9, 22, 8, 1, tzinfo=UTC),
    )

    # Then: evidence is counted by unique SRN, not batch cardinality.
    assert receipt.status == "insufficient_evidence"
    assert receipt.requirements[0].observed_evidence == 1


def test_coverage_requires_assertions_and_empty_batch_is_insufficient() -> None:
    # Given: coverage cannot be empty and one valid definition requires two evidence items.
    invalid = _definition_payload()
    evidence = invalid["evidence"]
    assert isinstance(evidence, dict)
    evidence["coverageAssertions"] = []
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopeDefinition.model_validate(invalid)
    definition = contract.KnowledgeScopeDefinition.model_validate(_definition_payload())
    mount = contract.KnowledgeScopeMount.model_validate(
        _mount_payload(contract.knowledge_scope_definition_digest(definition))
    )

    # When: no Candidates are submitted for aggregate admission.
    receipt = contract.admit_candidates(
        definition,
        mount,
        (),
        datetime(2026, 9, 22, 8, 1, tzinfo=UTC),
    )

    # Then: declared coverage remains visible and is not vacuously ready.
    assert receipt.status == "insufficient_evidence"
    assert receipt.requirements[0].observed_evidence == 0


def test_shared_v2_definition_mount_lock_request_and_candidate_match_typescript() -> None:
    # Given: the shared fixtures authored by the TypeScript contract lane.
    definition = contract.KnowledgeScopeDefinition.model_validate_json(
        (SHARED_FIXTURES / "valid-definition.json").read_bytes()
    )
    mount = contract.KnowledgeScopeMount.model_validate_json(
        (SHARED_FIXTURES / "valid-mount.json").read_bytes()
    )
    candidate = contract.CandidateEnvelope.model_validate_json(
        (SHARED_FIXTURES / "valid-candidate.json").read_bytes()
    )
    request = contract.CapabilityExecutionRequest.model_validate_json(
        (SHARED_FIXTURES / "valid-execution-request.json").read_bytes()
    )
    schemas = contract.parse_json_value((SHARED_FIXTURES / "schema-files.json").read_bytes())
    assert isinstance(schemas, dict)
    files: contract.KnowledgeScopeJsonFiles = {
        "scope.json": contract.parse_json_value(
            (SHARED_FIXTURES / "valid-definition.json").read_bytes()
        ),
        **schemas,
    }

    # When: Python digests and locks the identical parsed JSON.
    lock = contract.build_knowledge_scope_lock(definition, files)
    expected = contract.parse_json_value((SHARED_FIXTURES / "conformance-digest.json").read_bytes())
    assert isinstance(expected, dict)

    # Then: all v2 surfaces and canonical digests preserve wire parity.
    assert mount.definition_digest == expected["valid-definition.json"]
    assert contract.knowledge_scope_definition_digest(definition) == mount.definition_digest
    assert contract.candidate_envelope_digest(candidate) == expected["valid-candidate.json"]
    assert request.expected_revision == mount.revision
    assert contract.verify_knowledge_scope_lock(definition, files, lock)


def test_provider_result_preserves_optional_canonical_srn() -> None:
    # Given: Schift Search returns its canonical resource identity with untrusted evidence.
    payload: dict[str, contract.JsonValue] = {
        "resultId": "result.123",
        "srn": "srn:schift:acme:document:manuals/product_123",
        "revision": "revision.123",
        "freshness": "2026-09-22T09:00:00Z",
        "payload": {"text": "manual"},
        "citation": {"uri": "schift://manuals/product_123"},
        "providerScopes": [],
        "providerEvidence": {"kind": "schift_search", "indexRef": "index.product_manuals"},
    }

    # When: the provider boundary parses the strict result.
    result = contract.ProviderResult.model_validate(payload)

    # Then: normalization can preserve the canonical SRN without trusting other Scope fields.
    assert result.srn == payload["srn"]


def test_provider_result_rejects_provider_authored_permission() -> None:
    # Given: an otherwise valid provider row tries to author a trusted permission field.
    payload: dict[str, contract.JsonValue] = {
        "resultId": "result.123",
        "revision": "revision.123",
        "payload": {"text": "manual"},
        "providerScopes": [],
        "providerEvidence": {"kind": "schift_search", "indexRef": "index.product_manuals"},
        "permission": "tenant.acme.manuals.read",
    }

    # When / Then: permission can only be derived by the control plane after normalization.
    with pytest.raises(ValidationError):
        _ = contract.ProviderResult.model_validate(payload)


@pytest.mark.parametrize(
    ("operation_id", "provider_ref", "connector_ref"),
    [
        ("lookup_customer_orders", "orders.other", None),
        ("search_support_tickets", "zendesk.other", "connector.zendesk.primary"),
        ("search_support_tickets", "zendesk.search_tickets", "connector.other"),
        ("search_product_manuals", "index.other", None),
        ("search_public_incidents", "schift", None),
    ],
)
def test_materialization_rejects_incoherent_provider_binding(
    operation_id: str,
    provider_ref: str,
    connector_ref: str | None,
) -> None:
    # Given: a mount binds a declared operation to a different provider-native identity.
    definition = contract.KnowledgeScopeDefinition.model_validate_json(
        (SHARED_FIXTURES / "valid-definition.json").read_bytes()
    )
    mount = contract.KnowledgeScopeMount.model_validate_json(
        (SHARED_FIXTURES / "valid-mount.json").read_bytes()
    )
    binding_payload: dict[str, contract.JsonValue] = {
        "sourceId": "test.source",
        "sourceClass": "records",
        "providerRef": provider_ref,
        "authority": "primary",
        "permissionMode": "live",
        "operationIds": [operation_id],
    }
    if connector_ref is not None:
        binding_payload["connectorRef"] = connector_ref
    binding = contract.KnowledgeSourceBinding.model_validate(binding_payload)
    mount = mount.model_copy(update={"source_bindings": (binding,)})

    # When / Then: an incoherent mount cannot become an admission view.
    with pytest.raises(contract.KnowledgeScopeMaterializationError):
        _ = contract.materialize_knowledge_scope_pack(definition, mount)
