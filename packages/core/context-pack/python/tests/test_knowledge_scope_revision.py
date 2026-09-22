from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from pydantic import ValidationError

from schift_context_pack_contract.knowledge_scope_batch import CapabilityBatchExecutionRequest
from schift_context_pack_contract.knowledge_scope_execution import CapabilityExecutionRequest

if TYPE_CHECKING:
    from schift_context_pack_contract.json_boundary import JsonValue

REQUEST_CLASSES = (CapabilityExecutionRequest, CapabilityBatchExecutionRequest)


def _request(
    model: type[CapabilityExecutionRequest | CapabilityBatchExecutionRequest],
) -> dict[str, JsonValue]:
    common: dict[str, JsonValue] = {
        "installationId": "install.test",
        "effectiveScope": {"tenant": "acme"},
    }
    if model is CapabilityExecutionRequest:
        return {**common, "operationId": "search.docs", "input": None}
    return {**common, "operations": [{"operationId": "search.docs", "input": None}]}


@pytest.mark.parametrize("model", REQUEST_CLASSES)
@pytest.mark.parametrize("revision", [1, 1.0, 2**53 - 1, float(2**53 - 1)])
def test_request_accepts_portable_integral_json_number(
    model: type[CapabilityExecutionRequest | CapabilityBatchExecutionRequest],
    revision: float,
) -> None:
    # Given: JSON numeric values with identical mathematical integer meaning.
    raw = {**_request(model), "expectedRevision": revision}
    # When: either request boundary parses the number.
    request = model.model_validate(raw)
    # Then: Python matches JavaScript's integer domain and normalizes to int.
    assert request.expected_revision == int(revision)
    assert type(request.expected_revision) is int


@pytest.mark.parametrize("model", REQUEST_CLASSES)
@pytest.mark.parametrize(
    "revision", [None, True, "1", 0, -1, 1.5, 2**53, 1e20, float("inf"), float("nan")]
)
def test_request_rejects_nonportable_revision(
    model: type[CapabilityExecutionRequest | CapabilityBatchExecutionRequest],
    revision: JsonValue,
) -> None:
    # Given: a noninteger, unsafe integer, coerced primitive or explicit null.
    raw = {**_request(model), "expectedRevision": revision}
    # When/Then: both request surfaces reject it at the boundary.
    with pytest.raises(ValidationError):
        _ = model.model_validate(raw)


@pytest.mark.parametrize("model", REQUEST_CLASSES)
def test_request_allows_omitted_revision(
    model: type[CapabilityExecutionRequest | CapabilityBatchExecutionRequest],
) -> None:
    # Given: a request without an explicit optimistic revision constraint.
    raw = _request(model)
    # When: either request boundary parses the request.
    request = model.model_validate(raw)
    # Then: no constraint is invented.
    assert request.expected_revision is None
