"""Portable multi-operation request under one Knowledge Scope mount."""

from __future__ import annotations

from typing import Annotated

from pydantic import Field, StrictInt, field_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.json_boundary import JsonValue  # noqa: TC001
from schift_context_pack_contract.knowledge_scope_candidate import (
    EffectiveScope,  # noqa: TC001
    KnowledgeIdentifier,  # noqa: TC001
)
from schift_context_pack_contract.knowledge_scope_execution import CapabilityExecutionRequest
from schift_context_pack_contract.manifest import ContractModel, Identifier


class CapabilityBatchOperation(ContractModel):
    operation_id: KnowledgeIdentifier = Field(alias="operationId")
    input: JsonValue
    filters: dict[str, JsonValue] | None = None

    @field_validator("input")
    @classmethod
    def require_bounded_input(cls, value: JsonValue) -> JsonValue:
        return CapabilityExecutionRequest.require_bounded_input(value)

    @field_validator("filters", mode="before")
    @classmethod
    def require_bounded_filters(cls, value: JsonValue) -> JsonValue:
        return CapabilityExecutionRequest.require_bounded_filters(value)


class CapabilityBatchExecutionRequest(ContractModel):
    installation_id: Identifier = Field(alias="installationId")
    effective_scope: EffectiveScope = Field(alias="effectiveScope")
    expected_revision: Annotated[StrictInt, Field(ge=1, le=2**53 - 1)] | None = Field(
        default=None, alias="expectedRevision"
    )
    operations: Annotated[tuple[CapabilityBatchOperation, ...], Field(min_length=1, max_length=8)]

    @field_validator("expected_revision", mode="before")
    @classmethod
    def require_portable_revision(cls, value: JsonValue) -> int:
        return CapabilityExecutionRequest.require_portable_revision(value)

    @field_validator("operations")
    @classmethod
    def require_unique_operations(
        cls, value: tuple[CapabilityBatchOperation, ...]
    ) -> tuple[CapabilityBatchOperation, ...]:
        if len(value) != len({operation.operation_id for operation in value}):
            raise PydanticCustomError("duplicate_batch_operation", "operation IDs must be unique")
        return value
