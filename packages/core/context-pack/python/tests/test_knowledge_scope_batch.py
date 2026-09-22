from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from schift_context_pack_contract.json_boundary import JsonValue, canonical_json, parse_json_value
from schift_context_pack_contract.knowledge_scope_batch import CapabilityBatchExecutionRequest

FIXTURES = Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"


def test_batch_preserves_required_null_input_when_optional_fields_are_absent() -> None:
    # Given: a wire request with null input and omitted optional fields.
    raw = (
        '{"installationId":"install.test","effectiveScope":{"tenant":"acme"},'
        '"operations":[{"operationId":"search.docs","input":null}]}'
    )

    # When: the strict boundary parses the request.
    request = CapabilityBatchExecutionRequest.model_validate_json(raw)

    # Then: serializing provided fields preserves the same wire contract.
    assert canonical_json(
        parse_json_value(request.model_dump_json(by_alias=True, exclude_unset=True))
    ) == canonical_json(parse_json_value(raw))


@pytest.mark.parametrize("count", [0, 9])
def test_batch_rejects_operation_count_outside_limits(count: int) -> None:
    # Given: too few or too many otherwise valid operations.
    raw: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
        "operations": [{"operationId": f"search.{index}", "input": {}} for index in range(count)],
    }

    # When/Then: the batch boundary rejects the whole request.
    with pytest.raises(ValidationError):
        _ = CapabilityBatchExecutionRequest.model_validate(raw)


def test_batch_rejects_duplicate_operation_identity() -> None:
    # Given: the same operation appears twice with different inputs.
    raw: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
        "operations": [
            {"operationId": "search.docs", "input": "first"},
            {"operationId": "search.docs", "input": "second"},
        ],
    }

    # When/Then: identities cannot be duplicated within a batch.
    with pytest.raises(ValidationError, match="unique"):
        _ = CapabilityBatchExecutionRequest.model_validate(raw)


def test_batch_matches_shared_camelcase_wire_fixture() -> None:
    # Given: the exact portable request consumed by the TypeScript tests.
    raw = (FIXTURES / "batch-request-valid.json").read_bytes()

    # When: Python parses and serializes only the provided fields.
    request = CapabilityBatchExecutionRequest.model_validate_json(raw)
    normalized = parse_json_value(request.model_dump_json(by_alias=True, exclude_unset=True))

    # Then: canonical bytes match, including the required null input.
    assert canonical_json(normalized) == canonical_json(parse_json_value(raw))


def test_batch_rejects_every_shared_invalid_wire_fixture() -> None:
    # Given: the same invalid wire cases used by the TypeScript boundary.
    cases = parse_json_value((FIXTURES / "batch-request-invalid.json").read_bytes())
    assert isinstance(cases, list)

    for case in cases:
        assert isinstance(case, dict)
        # When/Then: every case fails without normalizing away the invalid fields.
        with pytest.raises(ValidationError):
            _ = CapabilityBatchExecutionRequest.model_validate(case["request"])


@pytest.mark.parametrize("revision", [True, "1", 0, -1, 1.5, 2**53, None])
def test_batch_rejects_nonportable_revision(revision: JsonValue) -> None:
    # Given: a revision that cannot represent a positive portable integer.
    raw: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
        "expectedRevision": revision,
        "operations": [{"operationId": "search.docs", "input": {}}],
    }

    # When/Then: the boundary rejects invalid and explicit null revisions.
    with pytest.raises(ValidationError):
        _ = CapabilityBatchExecutionRequest.model_validate(raw)


@pytest.mark.parametrize("field", ["input", "filters"])
def test_batch_rejects_unbounded_operation_json(field: str) -> None:
    # Given: an otherwise valid operation containing excessive UTF-8 data.
    operation: dict[str, JsonValue] = {"operationId": "search.docs", "input": {}}
    operation[field] = {"text": "한" * 22_000}
    raw: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
        "operations": [operation],
    }

    # When/Then: the existing bounded-JSON policy applies to each operation.
    with pytest.raises(ValidationError):
        _ = CapabilityBatchExecutionRequest.model_validate(raw)


def test_batch_accepts_eight_distinct_operations() -> None:
    # Given: the maximum supported operation count.
    raw: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
        "expectedRevision": 2**53 - 1,
        "operations": [{"operationId": f"search.{index}", "input": {}} for index in range(8)],
    }

    # When: the boundary parses a request at both count and revision ceilings.
    request = CapabilityBatchExecutionRequest.model_validate(raw)

    # Then: all operation identities remain distinct.
    assert len(request.operations) == 8
