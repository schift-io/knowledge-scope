"""Portable Schift Knowledge Scope definition and deprecated combined view."""

# Exhaustive provider matching intentionally retains a future-proof default.
# pyright: reportUnnecessaryComparison=false

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal, LiteralString, assert_never, final, override

from pydantic import Field, StrictBool, StrictInt, field_validator, model_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.json_boundary import JsonValue, to_json_value
from schift_context_pack_contract.knowledge_scope_candidate import (  # noqa: TC001
    KnowledgeIdentifier,
    SourceClass,
)
from schift_context_pack_contract.knowledge_scope_capabilities import (
    IdentifierTuple,
    OpenConnectorActionProvider,
    QueryCapability,
    RecordsOperationProvider,
    SchiftSearchProvider,
    WebSearchProvider,
)
from schift_context_pack_contract.knowledge_scope_mount import ScopeInstallation  # noqa: TC001
from schift_context_pack_contract.manifest import (
    Authority,
    ContractModel,
    Identifier,
    SemVer,
)

if TYPE_CHECKING:
    from schift_context_pack_contract.knowledge_scope_mount import (
        KnowledgeScopeMount,
        KnowledgeSourceBinding,
    )

Action = Literal["read", "draft"]
Origin = Literal["observed", "derived"]


def _validation_error(code: LiteralString, message: LiteralString) -> PydanticCustomError:
    return PydanticCustomError(code, message)


class KnowledgeScope(ContractModel):
    root: Literal["tenant"]
    descendants: tuple[Literal["namespace"], Literal["subject"], Literal["session"]]


class LegacyKnowledgeScope(KnowledgeScope):
    installation: Literal["required"]


class KnowledgeSelector(ContractModel):
    source_ids: tuple[KnowledgeIdentifier, ...] = Field(default=(), alias="sourceIds")
    source_classes: tuple[SourceClass, ...] = Field(default=(), alias="sourceClasses")
    authorities: tuple[Authority, ...] = ()
    origins: tuple[Origin, ...] = ()

    @model_validator(mode="after")
    def require_terms(self) -> KnowledgeSelector:
        if not any((self.source_ids, self.source_classes, self.authorities, self.origins)):
            raise _validation_error("empty_selector", "selector requires at least one term")
        terms = (self.source_ids, self.source_classes, self.authorities, self.origins)
        if any(len(values) != len(set(values)) for values in terms):
            raise _validation_error("duplicate_selector_term", "selector terms must be unique")
        return self


class KnowledgeRequirement(ContractModel):
    id: KnowledgeIdentifier
    selector: KnowledgeSelector
    min_evidence: Annotated[StrictInt, Field(ge=1)] = Field(alias="minEvidence")
    max_age_seconds: Annotated[StrictInt, Field(ge=0)] | None = Field(
        default=None, alias="maxAgeSeconds"
    )

    @field_validator("max_age_seconds", mode="before")
    @classmethod
    def reject_explicit_null_age(cls, value: JsonValue) -> JsonValue:
        if value is None:
            raise _validation_error("null_max_age", "max age must be omitted")
        return value


class KnowledgeDenyRule(ContractModel):
    id: KnowledgeIdentifier
    selector: KnowledgeSelector


class ContextPolicy(ContractModel):
    must_consider: Annotated[tuple[KnowledgeRequirement, ...], Field(min_length=1)] = Field(
        alias="mustConsider"
    )
    may_consider: tuple[KnowledgeRequirement, ...] = Field(default=(), alias="mayConsider")
    must_not_use: Annotated[tuple[KnowledgeDenyRule, ...], Field(min_length=1)] = Field(
        alias="mustNotUse"
    )

    @model_validator(mode="after")
    def require_unique_rule_ids(self) -> ContextPolicy:
        ids = tuple(rule.id for rule in self.must_consider + self.may_consider + self.must_not_use)
        if len(ids) != len(set(ids)):
            raise _validation_error("duplicate_context_rule", "context rule IDs must be unique")
        return self


class KnowledgeAuthority(ContractModel):
    precedence: Annotated[tuple[Authority, ...], Field(min_length=1)]
    allowed: Annotated[tuple[Action, ...], Field(min_length=1)]
    forbidden: tuple[
        Literal["send"], Literal["approve"], Literal["mutate_source"], Literal["workflow"]
    ]

    @model_validator(mode="after")
    def require_unique_authority(self) -> KnowledgeAuthority:
        if any(len(values) != len(set(values)) for values in (self.precedence, self.allowed)):
            raise _validation_error("duplicate_authority_term", "authority terms must be unique")
        return self


class KnowledgeFreshness(ContractModel):
    default_max_age_seconds: Annotated[StrictInt, Field(ge=0)] = Field(alias="defaultMaxAgeSeconds")


class KnowledgeEvidence(ContractModel):
    require_citation: StrictBool = Field(alias="requireCitation")
    freshness: KnowledgeFreshness
    coverage_assertions: Annotated[IdentifierTuple, Field(min_length=1)] = Field(
        alias="coverageAssertions"
    )


class _DefinitionBase(ContractModel):
    pack_id: Identifier = Field(alias="packId")
    version: SemVer
    responsibility: KnowledgeIdentifier
    capabilities: tuple[QueryCapability, ...]
    context_policy: ContextPolicy = Field(alias="contextPolicy")
    authority: KnowledgeAuthority
    evidence: KnowledgeEvidence

    @model_validator(mode="after")
    def require_coherent_definition(self) -> _DefinitionBase:
        operations = tuple(item.operation_id for item in self.capabilities)
        if len(operations) != len(set(operations)):
            raise _validation_error("duplicate_query_capability", "operation IDs must be unique")
        required = {item.id for item in self.context_policy.must_consider}
        coverage = self.evidence.coverage_assertions
        if len(coverage) != len(set(coverage)):
            raise _validation_error("duplicate_coverage", "coverage assertions must be unique")
        if not set(coverage).issubset(required):
            raise _validation_error(
                "unknown_coverage_assertion", "coverage must name required rules"
            )
        return self


class KnowledgeScopeDefinition(_DefinitionBase):
    scope: KnowledgeScope


class KnowledgeScopePack(_DefinitionBase):
    """Deprecated materialized view of portable definition plus mount."""

    scope: LegacyKnowledgeScope
    installation: ScopeInstallation

    @model_validator(mode="after")
    def require_known_bound_operations(self) -> KnowledgeScopePack:
        known = {item.operation_id for item in self.capabilities}
        if any(
            operation not in known
            for binding in self.installation.source_bindings
            for operation in binding.operation_ids
        ):
            raise _validation_error("unknown_bound_operation", "binding names unknown capability")
        return self


@final
class KnowledgeScopeMaterializationError(Exception):
    """Definition and mount name incompatible provider identities."""

    __slots__ = ("operation_id", "source_id")

    def __init__(self, *, source_id: str, operation_id: str) -> None:
        super().__init__()
        self.source_id = source_id
        self.operation_id = operation_id

    @override
    def __str__(self) -> str:
        return f"binding {self.source_id} is incoherent with {self.operation_id}"


def _binding_is_coherent(
    capability: QueryCapability,
    binding: KnowledgeSourceBinding,
) -> bool:
    match capability.provider:
        case RecordsOperationProvider(operation_id=provider_ref):
            return binding.provider_ref == provider_ref
        case OpenConnectorActionProvider(action_id=provider_ref, connector_ref=connector_ref):
            return binding.provider_ref == provider_ref and binding.connector_ref == connector_ref
        case SchiftSearchProvider(index_ref=provider_ref):
            return binding.provider_ref == provider_ref
        case WebSearchProvider(provider=provider_ref):
            return binding.provider_ref == provider_ref
        case unreachable:
            assert_never(unreachable)


def materialize_knowledge_scope_pack(
    definition: KnowledgeScopeDefinition, mount: KnowledgeScopeMount
) -> KnowledgeScopePack:
    """Materialize the deprecated combined view without changing its wire."""
    capabilities = {item.operation_id: item for item in definition.capabilities}
    for binding in mount.source_bindings:
        for operation_id in binding.operation_ids:
            capability = capabilities.get(operation_id)
            if capability is None or not _binding_is_coherent(capability, binding):
                raise KnowledgeScopeMaterializationError(
                    source_id=binding.source_id, operation_id=operation_id
                )
    payload = definition.model_dump(by_alias=True, exclude_defaults=True, exclude_none=True)
    payload["scope"] = {**definition.scope.model_dump(by_alias=True), "installation": "required"}
    payload["installation"] = {
        "mode": "server_enforced",
        "state": mount.state,
        "installationId": mount.installation_id,
        "packDigest": mount.definition_digest,
        "scopeAuthority": mount.scope_authority,
        "sourceBindings": mount.source_bindings,
    }
    return KnowledgeScopePack.model_validate(payload)


def knowledge_scope_json_value(pack: KnowledgeScopePack) -> JsonValue:
    """Return the deprecated combined camelCase wire value."""
    return to_json_value(
        pack.model_dump_json(by_alias=True, exclude_defaults=True, exclude_none=True)
    )
