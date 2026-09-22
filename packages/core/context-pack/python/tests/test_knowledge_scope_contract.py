from __future__ import annotations

import math
from pathlib import Path

import pytest
from pydantic import ValidationError

import schift_context_pack_contract as contract
from schift_context_pack_contract.json_boundary import canonical_digest, canonical_json

SHARED_FIXTURES = (
    Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"
)


def test_knowledge_scope_pack_parses_all_provider_kinds() -> None:
    # Given: the cross-runtime Knowledge Scope fixture.
    payload = (SHARED_FIXTURES / "valid-pack.json").read_bytes()

    # When: Python parses the shared wire contract.
    pack = contract.KnowledgeScopePack.model_validate_json(payload)

    # Then: all four bounded provider declarations retain their identities.
    assert pack.pack_id == "support.knowledge"
    assert tuple(capability.provider.kind for capability in pack.capabilities) == (
        "records_operation",
        "open_connector_action",
        "schift_search",
        "web_search",
    )
    assert contract.knowledge_scope_json_value(pack) == contract.parse_json_value(payload)


@pytest.mark.parametrize(
    "fixture_name",
    ["invalid-sql-capability.json", "invalid-credential-capability.json"],
)
def test_query_capability_rejects_provider_execution_material(fixture_name: str) -> None:
    # Given: a capability containing provider-native execution or credential material.
    payload = (SHARED_FIXTURES / fixture_name).read_bytes()

    # When / Then: the portable declaration rejects unknown provider fields.
    with pytest.raises(ValidationError):
        _ = contract.QueryCapability.model_validate_json(payload)


def test_knowledge_scope_pack_rejects_duplicate_operations() -> None:
    # Given: two capabilities with the same portable operation identity.
    payload = (
        (SHARED_FIXTURES / "valid-pack.json")
        .read_text()
        .replace(
            '"operationId": "search_support_tickets"',
            '"operationId": "lookup_customer_orders"',
            1,
        )
    )

    # When / Then: the Pack boundary rejects the ambiguous declaration.
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopePack.model_validate_json(payload)


def test_query_capability_requires_positive_limits_and_freshness() -> None:
    # Given: a capability whose declared ceiling is not positive.
    payload = (
        (SHARED_FIXTURES / "valid-pack.json")
        .read_text()
        .replace('"maxRows": 25', '"maxRows": 0', 1)
    )

    # When / Then: the invalid ceiling cannot enter a parsed Scope.
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopePack.model_validate_json(payload)


def test_query_capability_rejects_explicit_null_drift() -> None:
    # Given: an optional field explicitly set to null instead of being absent.
    payload = (
        (SHARED_FIXTURES / "valid-pack.json")
        .read_text()
        .replace(
            '"freshness": {\n        "maxAgeSeconds": 300\n      }',
            '"freshness": null',
            1,
        )
    )

    # When / Then: the wire boundary rejects null drift.
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopePack.model_validate_json(payload)


def test_knowledge_scope_pack_rejects_snake_case_wire_drift() -> None:
    # Given: an internal Python field name leaked onto the camelCase wire.
    payload = (
        (SHARED_FIXTURES / "valid-pack.json").read_text().replace('"packId":', '"pack_id":', 1)
    )

    # When / Then: only the shared TypeScript wire name is accepted.
    with pytest.raises(ValidationError):
        _ = contract.KnowledgeScopePack.model_validate_json(payload)


def test_query_freshness_allows_immediate_expiry() -> None:
    # Given: a capability whose evidence must be current at selection time.
    payload = (
        (SHARED_FIXTURES / "valid-pack.json")
        .read_text()
        .replace('"maxAgeSeconds": 300', '"maxAgeSeconds": 0', 1)
    )

    # When: the Pack parses the nonnegative freshness ceiling.
    pack = contract.KnowledgeScopePack.model_validate_json(payload)

    # Then: zero retains the fail-closed immediate-expiry meaning.
    assert pack.capabilities[0].freshness is not None
    assert pack.capabilities[0].freshness.max_age_seconds == 0


def test_candidate_envelope_preserves_connector_correlation() -> None:
    # Given: a normalized provider candidate carrying connector correlation.
    payload = (SHARED_FIXTURES / "valid-candidate.json").read_bytes()

    # When: Python parses the shared candidate envelope.
    candidate = contract.CandidateEnvelope.model_validate_json(payload)

    # Then: resource identity, payload, and connector run survive exact wire normalization.
    assert candidate.srn == "srn:schift:acme:records:tickets/ticket_123"
    assert candidate.effective_scope.tenant == "tenant.acme"
    normalized = contract.candidate_envelope_json_value(candidate)
    assert normalized == contract.parse_json_value(payload)
    assert isinstance(normalized, dict)
    evidence = normalized["providerEvidence"]
    assert isinstance(evidence, dict)
    assert evidence["connectorRunId"] == "connector_run.20260922_001"


def test_candidate_rejects_calendar_invalid_freshness() -> None:
    # Given: a Candidate whose timestamp shape is valid but calendar instant is impossible.
    payload = (
        (SHARED_FIXTURES / "valid-candidate.json")
        .read_text()
        .replace("2026-09-22T09:00:00Z", "2026-99-99T09:00:00Z")
    )

    # When / Then: Python matches the TypeScript datetime boundary.
    with pytest.raises(ValidationError):
        _ = contract.CandidateEnvelope.model_validate_json(payload)


@pytest.mark.parametrize("missing_field", ["actionId", "connectorRef"])
def test_open_connector_provider_requires_action_and_connector_references(
    missing_field: str,
) -> None:
    # Given: an Open Connector capability missing one required identity.
    payload = (SHARED_FIXTURES / "invalid-credential-capability.json").read_text()
    field_line = {
        "actionId": '    "actionId": "zendesk.search_tickets",\n',
        "connectorRef": '    "connectorRef": "connector.zendesk.primary",\n',
    }[missing_field]
    payload = payload.replace(field_line, "", 1)
    payload = payload.replace(',\n    "credential": "secret://zendesk/api-token"', "", 1)

    # When / Then: the provider cannot be declared without both identities.
    with pytest.raises(ValidationError):
        _ = contract.QueryCapability.model_validate_json(payload)


def test_knowledge_scope_and_candidate_digests_match_typescript() -> None:
    # Given: shared fixtures and digests produced by the TypeScript contract.
    pack = contract.KnowledgeScopePack.model_validate_json(
        (SHARED_FIXTURES / "valid-pack.json").read_bytes()
    )
    candidate = contract.CandidateEnvelope.model_validate_json(
        (SHARED_FIXTURES / "valid-candidate.json").read_bytes()
    )
    definition = contract.KnowledgeScopeDefinition.model_validate_json(
        (SHARED_FIXTURES / "valid-definition.json").read_bytes()
    )
    expected = contract.parse_json_value((SHARED_FIXTURES / "conformance-digest.json").read_bytes())
    assert isinstance(expected, dict)

    # When: Python canonicalizes the parsed wire models.
    pack_digest = contract.knowledge_scope_digest(pack)
    candidate_digest = contract.candidate_envelope_digest(candidate)
    definition_digest = contract.knowledge_scope_definition_digest(definition)

    # Then: both digests exactly match the cross-runtime fixture.
    assert pack_digest == expected["valid-pack.json"]
    assert candidate_digest == expected["valid-candidate.json"]
    assert definition_digest == expected["valid-definition.json"]


def _bound_candidate_payload() -> dict[str, contract.JsonValue]:
    value = contract.parse_json_value((SHARED_FIXTURES / "valid-candidate.json").read_bytes())
    assert isinstance(value, dict)
    return {**value, "payload": None}


def test_candidate_envelope_requires_server_bound_authorization_and_keeps_null_payload() -> None:
    # Given
    payload = _bound_candidate_payload()

    # When
    candidate = contract.CandidateEnvelope.model_validate(payload)

    # Then
    normalized = contract.candidate_envelope_json_value(candidate)
    assert normalized == payload
    assert isinstance(normalized, dict)
    assert "payload" in normalized
    assert normalized["payload"] is None


@pytest.mark.parametrize("scheme", ["javascript://alert", "file:///etc/passwd", "http://x"])
def test_candidate_citation_rejects_unsafe_scheme(scheme: str) -> None:
    # Given
    payload = {**_bound_candidate_payload(), "citation": {"uri": scheme}}

    # When / Then
    with pytest.raises(ValidationError):
        _ = contract.CandidateEnvelope.model_validate(payload)


@pytest.mark.parametrize(
    "payload",
    [
        {"number": math.inf},
        {"number": 2**53},
        {"number": 1e20},
        {"text": "x" * 65_537},
        {"items": list(range(4_097))},
    ],
)
def test_candidate_payload_rejects_unbounded_json(payload: contract.JsonValue) -> None:
    # Given
    candidate = {**_bound_candidate_payload(), "payload": payload}

    # When / Then
    with pytest.raises(ValidationError):
        _ = contract.CandidateEnvelope.model_validate(candidate)


def test_candidate_payload_accepts_finite_fractional_number() -> None:
    # Given: a finite fractional provider score is valid portable JSON.
    candidate = {**_bound_candidate_payload(), "payload": {"score": 0.98}}

    # When: the Candidate boundary validates the payload.
    parsed = contract.CandidateEnvelope.model_validate(candidate)

    # Then: safe fractional evidence remains available to consumers.
    assert parsed.payload == {"score": 0.98}


def test_candidate_payload_rejects_excessive_nesting() -> None:
    # Given
    nested: contract.JsonValue = "leaf"
    for _ in range(17):
        nested = [nested]

    # When / Then
    with pytest.raises(ValidationError):
        _ = contract.CandidateEnvelope.model_validate(
            {**_bound_candidate_payload(), "payload": nested}
        )


def test_canonical_json_orders_keys_by_utf16_code_units() -> None:
    # Given: the shared BMP/private-use and supplementary-plane key fixture.
    value = contract.parse_json_value(
        (SHARED_FIXTURES / "canonical-unicode-order.json").read_bytes()
    )
    expected = contract.parse_json_value((SHARED_FIXTURES / "conformance-digest.json").read_bytes())
    assert isinstance(expected, dict)

    # When: Python canonicalizes the mapping.
    encoded = canonical_json(value)

    # Then: order and digest match JavaScript's UTF-16 code-unit comparison.
    assert encoded == '{"\U00010000":"astral-plane","\ue000":"bmp-private-use"}'
    assert canonical_digest(value) == expected["canonical-unicode-order.json"]


@pytest.mark.parametrize(
    ("number", "expected"),
    [
        (1.0, "1"),
        (-0.0, "0"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (-1e21, "-1e+21"),
        (1.2345678901234567, "1.2345678901234567"),
    ],
)
def test_canonical_json_matches_ecmascript_number_serialization(
    number: float,
    expected: str,
) -> None:
    # Given: a finite float around ECMAScript's fixed/scientific thresholds.
    # When: Python emits canonical JSON.
    encoded = canonical_json(number)

    # Then: the number matches JSON.stringify's shortest representation.
    assert encoded == expected


def test_shared_canonical_number_fixture_matches_typescript() -> None:
    # Given: the shared ECMAScript number edge-case fixture and digest ledger.
    value = contract.parse_json_value(
        (SHARED_FIXTURES / "canonical-number-parity.json").read_bytes()
    )
    expected = contract.parse_json_value((SHARED_FIXTURES / "conformance-digest.json").read_bytes())
    assert isinstance(expected, dict)

    # When: Python serializes and digests every number edge together.
    encoded = canonical_json(value)

    # Then: bytes and digest exactly match the TypeScript fixture contract.
    assert encoded == (
        '{"binarySum":0.30000000000000004,"integralFloat":1,'
        '"largeDecimalThreshold":100000000000000000000,"largeScientific":1e+21,'
        '"negativeZero":0,"shortestRoundTrip":1.2345678901234567,'
        '"smallDecimalThreshold":0.000001,"smallScientific":1e-7}'
    )
    assert canonical_digest(value) == expected["canonical-number-parity.json"]


@pytest.mark.parametrize(
    "payload",
    [{"text": "é" * 32_768}, {"é" * 32_768: "value"}],
)
def test_candidate_payload_accepts_utf8_string_byte_ceiling(
    payload: contract.JsonValue,
) -> None:
    # Given: a value or key occupies exactly 65,536 UTF-8 bytes.
    candidate = {**_bound_candidate_payload(), "payload": payload}

    # When: Candidate parsing measures the portable byte ceiling.
    parsed = contract.CandidateEnvelope.model_validate(candidate)

    # Then: the inclusive limit is accepted.
    assert parsed.payload == payload


@pytest.mark.parametrize(
    "payload",
    [{"text": "é" * 32_769}, {"é" * 32_769: "value"}],
)
def test_candidate_payload_rejects_utf8_string_over_byte_ceiling(
    payload: contract.JsonValue,
) -> None:
    # Given: a value or key exceeds 65,536 UTF-8 bytes by two bytes.
    candidate = {**_bound_candidate_payload(), "payload": payload}

    # When / Then: the Candidate boundary rejects it.
    with pytest.raises(ValidationError):
        _ = contract.CandidateEnvelope.model_validate(candidate)


def test_knowledge_scope_allows_no_query_capabilities() -> None:
    # Given
    payload = (SHARED_FIXTURES / "valid-pack.json").read_text()
    start = payload.index('  "capabilities": [')
    end = payload.index('  "contextPolicy":', start)
    without_capabilities = payload[:start] + '  "capabilities": [],\n' + payload[end:]
    without_bindings = without_capabilities.replace(
        '    "state": "mounted",', '    "state": "unmounted",'
    )
    binding_start = without_bindings.index('    "sourceBindings": [')
    binding_end = without_bindings.index("\n    ]", binding_start) + len("\n    ]")
    without_bindings = (
        without_bindings[:binding_start]
        + '    "sourceBindings": []'
        + without_bindings[binding_end:]
    )

    # When
    pack = contract.KnowledgeScopePack.model_validate_json(without_bindings)

    # Then
    assert pack.capabilities == ()
