"""Trusted control-plane request contract for Knowledge Scope capability execution."""

# Keep the exhaustive JSON boundary arm as the shared contract types evolve.
# pyright: reportUnnecessaryComparison=false

from __future__ import annotations

from typing import Annotated, assert_never

from pydantic import Field, StrictInt, field_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.json_boundary import JsonValue  # noqa: TC001
from schift_context_pack_contract.knowledge_scope_candidate import (
    CandidateCitation,
    EffectiveScope,
    KnowledgeIdentifier,
    ProviderEvidence,
    ProviderScope,
    Timestamp,
    validate_bounded_json,
)
from schift_context_pack_contract.manifest import ContractModel, Identifier


class ProviderResult(ContractModel):
    result_id: KnowledgeIdentifier = Field(alias="resultId")
    srn: Annotated[str, Field(pattern=r"^srn:[a-z0-9][a-z0-9:._/-]+$")] | None = None
    revision: KnowledgeIdentifier
    freshness: Timestamp | None = None
    payload: JsonValue
    citation: CandidateCitation | None = None
    provider_scopes: tuple[ProviderScope, ...] = Field(alias="providerScopes")
    provider_evidence: ProviderEvidence = Field(alias="providerEvidence")

    @field_validator("payload")
    @classmethod
    def require_bounded_payload(cls, value: JsonValue) -> JsonValue:
        try:
            return validate_bounded_json(value)
        except ValueError as error:
            raise PydanticCustomError(
                "unbounded_provider_payload", "provider payload exceeds JSON limits"
            ) from error

    @field_validator("provider_scopes")
    @classmethod
    def require_unique_scopes(cls, value: tuple[ProviderScope, ...]) -> tuple[ProviderScope, ...]:
        if len(value) != len(set(value)):
            raise PydanticCustomError("duplicate_provider_scope", "provider scopes must be unique")
        return value

    @field_validator("srn", "freshness", "citation", mode="before")
    @classmethod
    def reject_explicit_null_metadata(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise PydanticCustomError("null_provider_metadata", "metadata must be omitted")
        return value


class CapabilityExecutionRequest(ContractModel):
    installation_id: Identifier = Field(alias="installationId")
    operation_id: KnowledgeIdentifier = Field(alias="operationId")
    effective_scope: EffectiveScope = Field(alias="effectiveScope")
    input: JsonValue
    filters: dict[str, JsonValue] | None = None
    expected_revision: Annotated[StrictInt, Field(ge=1, le=2**53 - 1)] | None = Field(
        default=None, alias="expectedRevision"
    )

    @field_validator("expected_revision", mode="before")
    @classmethod
    def require_portable_revision(cls, value: JsonValue) -> int:
        match value:
            case bool():
                raise PydanticCustomError(
                    "invalid_execution_revision", "revision must be an integer"
                )
            case int() as revision:
                return revision
            case float() as revision if revision.is_integer():
                return int(revision)
            case float() | str() | list() | dict() | None:
                raise PydanticCustomError(
                    "invalid_execution_revision", "revision must be a finite integer or omitted"
                )
            case unreachable:
                assert_never(unreachable)

    @field_validator("input")
    @classmethod
    def require_bounded_input(cls, value: JsonValue) -> JsonValue:
        try:
            return validate_bounded_json(value)
        except ValueError as error:
            raise PydanticCustomError(
                "unbounded_execution_input", "execution input exceeds JSON limits"
            ) from error

    @field_validator("filters", mode="before")
    @classmethod
    def require_bounded_filters(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise PydanticCustomError("null_execution_filters", "filters must be omitted")
        try:
            _ = validate_bounded_json(value)
        except ValueError as error:
            raise PydanticCustomError(
                "unbounded_execution_filters", "execution filters exceed JSON limits"
            ) from error
        return value
