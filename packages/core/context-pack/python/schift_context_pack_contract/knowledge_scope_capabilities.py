"""Portable Knowledge Scope query capability declarations."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal, LiteralString

from pydantic import Field, StrictInt, field_validator, model_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.knowledge_scope_candidate import KnowledgeIdentifier
from schift_context_pack_contract.manifest import ContractModel, PortablePath

if TYPE_CHECKING:
    from schift_context_pack_contract.json_boundary import JsonValue

ProviderScope = Annotated[str, Field(pattern=r"^[a-z][a-z0-9:_.*-]{1,127}$")]
IdentifierTuple = tuple[KnowledgeIdentifier, ...]
LimitValue = Annotated[StrictInt, Field(ge=1)]


def _validation_error(code: LiteralString, message: LiteralString) -> PydanticCustomError:
    return PydanticCustomError(code, message)


class RecordsOperationProvider(ContractModel):
    kind: Literal["records_operation"]
    operation_id: KnowledgeIdentifier = Field(alias="operationId")


class OpenConnectorActionProvider(ContractModel):
    kind: Literal["open_connector_action"]
    action_id: KnowledgeIdentifier = Field(alias="actionId")
    connector_ref: KnowledgeIdentifier = Field(alias="connectorRef")


class SchiftSearchProvider(ContractModel):
    kind: Literal["schift_search"]
    index_ref: KnowledgeIdentifier = Field(alias="indexRef")


class LocalDocumentsProvider(ContractModel):
    kind: Literal["local_documents"]
    index_ref: KnowledgeIdentifier = Field(alias="indexRef")


class WebSearchProvider(ContractModel):
    kind: Literal["web_search"]
    provider: Literal["customer", "schift"]


QueryProvider = Annotated[
    RecordsOperationProvider
    | OpenConnectorActionProvider
    | SchiftSearchProvider
    | LocalDocumentsProvider
    | WebSearchProvider,
    Field(discriminator="kind"),
]


class QueryLimits(ContractModel):
    max_rows: LimitValue | None = Field(default=None, alias="maxRows")
    max_result_bytes: LimitValue | None = Field(default=None, alias="maxResultBytes")

    @model_validator(mode="after")
    def require_limit(self) -> QueryLimits:
        if self.max_rows is None and self.max_result_bytes is None:
            raise _validation_error("empty_limits", "limits require at least one ceiling")
        return self


class QueryFreshness(ContractModel):
    max_age_seconds: Annotated[StrictInt, Field(ge=0)] = Field(alias="maxAgeSeconds")


class QueryCapability(ContractModel):
    operation_id: KnowledgeIdentifier = Field(alias="operationId")
    provider: QueryProvider
    input_schema_ref: PortablePath = Field(alias="inputSchemaRef")
    result_schema_ref: PortablePath = Field(alias="resultSchemaRef")
    allowed_filters: IdentifierTuple = Field(default=(), alias="allowedFilters")
    limits: QueryLimits | None = None
    freshness: QueryFreshness | None = None
    required_provider_scopes: tuple[ProviderScope, ...] = Field(
        default=(), alias="requiredProviderScopes"
    )

    @field_validator("limits", "freshness", mode="before")
    @classmethod
    def reject_explicit_null_policy(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise _validation_error("null_capability_policy", "policy must be omitted")
        return value

    @model_validator(mode="after")
    def require_unique_lists(self) -> QueryCapability:
        if len(self.allowed_filters) != len(set(self.allowed_filters)):
            raise _validation_error("duplicate_allowed_filter", "allowed filters must be unique")
        if len(self.required_provider_scopes) != len(set(self.required_provider_scopes)):
            raise _validation_error("duplicate_provider_scope", "provider scopes must be unique")
        return self
