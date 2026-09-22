"""Server-bound provider Candidate envelope for Schift Knowledge Scope."""

# Exhaustive wildcard arms are required by the bounded recursive JSON contract.
# pyright: reportUnnecessaryComparison=false

from __future__ import annotations

import math
from datetime import datetime
from typing import Annotated, Final, Literal, LiteralString, assert_never, final

from pydantic import AfterValidator, Field, StrictBool, StrictInt, TypeAdapter, field_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.json_boundary import (
    JsonValue,
)
from schift_context_pack_contract.manifest import (
    ContractModel,
    Identifier,
    Sha256Digest,
)

SourceClass = Literal["document", "records", "activity_stream"]
KnowledgeIdentifier = Annotated[
    str, Field(min_length=2, max_length=128, pattern=r"^[a-z0-9][a-z0-9._:-]*$")
]
ProviderScope = Annotated[str, Field(pattern=r"^[a-z][a-z0-9:_.*-]{1,127}$")]
_TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"


def _valid_timestamp(value: str) -> str:
    try:
        _ = datetime.fromisoformat(value)
    except ValueError as error:
        raise PydanticCustomError(
            "invalid_timestamp", "timestamp must be a real instant"
        ) from error
    return value


Timestamp = Annotated[str, Field(pattern=_TIMESTAMP_PATTERN), AfterValidator(_valid_timestamp)]
_MAX_JSON_DEPTH: Final = 16
_MAX_JSON_NODES: Final = 4_096
_MAX_JSON_STRING_LENGTH: Final = 65_536
_MAX_SAFE_INTEGER: Final = 2**53 - 1
_JSON_OBJECT_ADAPTER: Final[TypeAdapter[dict[str, JsonValue]]] = TypeAdapter(dict[str, JsonValue])


def _validation_error(code: LiteralString, message: LiteralString) -> PydanticCustomError:
    return PydanticCustomError(code, message)


class BoundedJsonError(ValueError):
    """Raised when JSON exceeds the portable Candidate admission ceiling."""


@final
class _JsonBudget:
    """Mutable admission counter for one bounded JSON traversal."""

    __slots__ = ("nodes",)

    def __init__(self) -> None:
        self.nodes = 0

    def visit(self, child: JsonValue, depth: int) -> None:
        self._admit(depth)
        match child:
            case dict() as mapping:
                for key, item in mapping.items():
                    self._validate_text(key)
                    self.visit(item, depth + 1)
            case list() as items:
                for item in items:
                    self.visit(item, depth + 1)
            case str() as text:
                self._validate_text(text)
            case bool() | None:
                return
            case float() as number:
                self._validate_float(number)
            case int() as number:
                self._validate_integer(number)
            case unreachable:
                assert_never(unreachable)

    def _admit(self, depth: int) -> None:
        self.nodes += 1
        if self.nodes > _MAX_JSON_NODES:
            raise BoundedJsonError("JSON exceeds the 4096-node ceiling")
        if depth > _MAX_JSON_DEPTH:
            raise BoundedJsonError("JSON exceeds the depth-16 ceiling")

    @staticmethod
    def _validate_text(text: str) -> None:
        try:
            byte_length = len(text.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise BoundedJsonError("JSON text must be valid UTF-8") from error
        if byte_length > _MAX_JSON_STRING_LENGTH:
            raise BoundedJsonError("JSON text exceeds the 65536-byte ceiling")

    @staticmethod
    def _validate_float(number: float) -> None:
        if not math.isfinite(number) or (number.is_integer() and abs(number) > _MAX_SAFE_INTEGER):
            raise BoundedJsonError("JSON number is not portable")

    @staticmethod
    def _validate_integer(number: int) -> None:
        if abs(number) > _MAX_SAFE_INTEGER:
            raise BoundedJsonError("JSON integer exceeds the safe range")


def validate_bounded_json(value: JsonValue) -> JsonValue:
    """Reject non-finite or resource-exhausting JSON before canonicalization."""
    _JsonBudget().visit(value, 0)
    return value


class KnowledgeScopeAuthority(ContractModel):
    organization_id: KnowledgeIdentifier = Field(alias="organizationId")
    tenant: KnowledgeIdentifier


class EffectiveScope(ContractModel):
    tenant: KnowledgeIdentifier
    namespace: KnowledgeIdentifier | None = None
    subject: KnowledgeIdentifier | None = None
    session: KnowledgeIdentifier | None = None

    @field_validator("namespace", "subject", "session", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise _validation_error("null_effective_scope", "scope value must be omitted, not null")
        return value


class CandidateCitation(ContractModel):
    uri: Annotated[str, Field(pattern=r"^(?:https|schift)://\S+$")]
    label: Annotated[str, Field(min_length=1)] | None = None

    @field_validator("label", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise _validation_error("null_citation_label", "label must be omitted, not null")
        return value


class AuthorizationDecision(ContractModel):
    decision_id: KnowledgeIdentifier = Field(alias="decisionId")
    decision_digest: Sha256Digest = Field(alias="decisionDigest")
    status: Literal["allowed"]


class RecordsOperationEvidence(ContractModel):
    kind: Literal["records_operation"]
    operation_id: KnowledgeIdentifier = Field(alias="operationId")


class OpenConnectorActionEvidence(ContractModel):
    kind: Literal["open_connector_action"]
    connector_ref: KnowledgeIdentifier = Field(alias="connectorRef")
    action_id: KnowledgeIdentifier = Field(alias="actionId")
    connector_run_id: KnowledgeIdentifier = Field(alias="connectorRunId")
    action_correlation_id: KnowledgeIdentifier = Field(alias="actionCorrelationId")
    audit_persisted: StrictBool = Field(alias="auditPersisted")


class SchiftSearchEvidence(ContractModel):
    kind: Literal["schift_search"]
    index_ref: KnowledgeIdentifier = Field(alias="indexRef")


class WebSearchEvidence(ContractModel):
    kind: Literal["web_search"]
    provider: Literal["customer", "schift"]


ProviderEvidence = Annotated[
    RecordsOperationEvidence
    | OpenConnectorActionEvidence
    | SchiftSearchEvidence
    | WebSearchEvidence,
    Field(discriminator="kind"),
]


class CandidateEnvelope(ContractModel):
    srn: Annotated[str, Field(pattern=r"^srn:[a-z0-9][a-z0-9:._/-]+$")]
    source_id: Identifier = Field(alias="sourceId")
    source_class: SourceClass = Field(alias="sourceClass")
    provider_ref: KnowledgeIdentifier = Field(alias="providerRef")
    installation_id: Identifier = Field(alias="installationId")
    definition_digest: Sha256Digest = Field(alias="definitionDigest")
    mount_revision: Annotated[StrictInt, Field(ge=1)] = Field(alias="mountRevision")
    operation_id: KnowledgeIdentifier = Field(alias="operationId")
    scope_authority: KnowledgeScopeAuthority = Field(alias="scopeAuthority")
    effective_scope: EffectiveScope = Field(alias="effectiveScope")
    authorization_decision: AuthorizationDecision = Field(alias="authorizationDecision")
    revision: KnowledgeIdentifier
    permission: Annotated[str, Field(min_length=1)]
    permission_mode: Literal["live", "mirrored", "static"] = Field(alias="permissionMode")
    provider_scopes: tuple[ProviderScope, ...] = Field(alias="providerScopes")
    provider_evidence: ProviderEvidence = Field(alias="providerEvidence")
    freshness: Timestamp | None = None
    payload: JsonValue
    citation: CandidateCitation | None = None

    @field_validator("payload")
    @classmethod
    def enforce_bounded_payload(cls, value: JsonValue) -> JsonValue:
        try:
            return validate_bounded_json(value)
        except BoundedJsonError as error:
            raise PydanticCustomError(
                "unbounded_candidate_payload", "Candidate payload exceeds JSON admission limits"
            ) from error

    @field_validator("provider_scopes")
    @classmethod
    def require_unique_provider_scopes(
        cls, value: tuple[ProviderScope, ...]
    ) -> tuple[ProviderScope, ...]:
        if len(value) != len(set(value)):
            raise _validation_error("duplicate_provider_scope", "provider scopes must be unique")
        return value

    @field_validator("freshness", "citation", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise _validation_error("null_candidate_metadata", "metadata must be omitted, not null")
        return value


def candidate_envelope_json_value(candidate: CandidateEnvelope) -> JsonValue:
    """Return the normalized Candidate while preserving required payload null."""
    normalized = _JSON_OBJECT_ADAPTER.validate_json(
        candidate.model_dump_json(by_alias=True, exclude_defaults=True, exclude_none=True)
    )
    normalized["payload"] = candidate.payload
    return normalized
