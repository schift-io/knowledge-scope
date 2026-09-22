"""Server-owned Knowledge Scope mount contract and legacy materialization state."""

from __future__ import annotations

from typing import Annotated, Literal, LiteralString

from pydantic import Field, StrictInt, field_validator, model_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.knowledge_scope_candidate import (
    KnowledgeIdentifier,
    KnowledgeScopeAuthority,
    SourceClass,
)
from schift_context_pack_contract.manifest import (
    Authority,
    ContractModel,
    Identifier,
    Sha256Digest,
)

Origin = Literal["observed", "derived"]
PermissionMode = Literal["live", "mirrored", "static", "unsupported"]
IdentifierTuple = tuple[KnowledgeIdentifier, ...]


def _validation_error(code: LiteralString, message: LiteralString) -> PydanticCustomError:
    return PydanticCustomError(code, message)


class KnowledgeSourceBinding(ContractModel):
    source_id: Identifier = Field(alias="sourceId")
    source_class: SourceClass = Field(alias="sourceClass")
    provider_ref: KnowledgeIdentifier = Field(alias="providerRef")
    connector_ref: KnowledgeIdentifier | None = Field(default=None, alias="connectorRef")
    permission_mode: PermissionMode = Field(alias="permissionMode")
    operation_ids: IdentifierTuple = Field(alias="operationIds")
    authority: Authority
    origin: Origin | None = None

    @field_validator("connector_ref", "origin", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: str | None) -> str:
        if value is None:
            raise _validation_error("null_binding_metadata", "binding metadata must be omitted")
        return value

    @model_validator(mode="after")
    def require_unique_operations(self) -> KnowledgeSourceBinding:
        if len(self.operation_ids) != len(set(self.operation_ids)):
            raise _validation_error("duplicate_bound_operation", "bound operations must be unique")
        return self


class KnowledgeScopeMount(ContractModel):
    installation_id: Identifier = Field(alias="installationId")
    definition_digest: Sha256Digest = Field(alias="definitionDigest")
    scope_authority: KnowledgeScopeAuthority = Field(alias="scopeAuthority")
    source_bindings: tuple[KnowledgeSourceBinding, ...] = Field(alias="sourceBindings")
    state: Literal["mounted", "unmounted"]
    revision: Annotated[StrictInt, Field(ge=1)]

    @model_validator(mode="after")
    def require_coherent_mount(self) -> KnowledgeScopeMount:
        source_ids = tuple(binding.source_id for binding in self.source_bindings)
        if len(source_ids) != len(set(source_ids)):
            raise _validation_error("duplicate_source_binding", "source bindings must be unique")
        if self.state == "mounted" and not self.source_bindings:
            raise _validation_error("empty_mounted_scope", "mounted Scope requires a binding")
        if self.state == "unmounted" and self.source_bindings:
            raise _validation_error(
                "bound_unmounted_scope", "unmounted Scope cannot retain bindings"
            )
        return self


class ScopeInstallation(ContractModel):
    """Deprecated combined-wire installation view."""

    mode: Literal["server_enforced"]
    state: Literal["mounted", "unmounted"]
    installation_id: Identifier = Field(alias="installationId")
    pack_digest: Sha256Digest = Field(alias="packDigest")
    scope_authority: KnowledgeScopeAuthority = Field(alias="scopeAuthority")
    source_bindings: tuple[KnowledgeSourceBinding, ...] = Field(alias="sourceBindings")

    @model_validator(mode="after")
    def require_coherent_installation(self) -> ScopeInstallation:
        mount_payload = {
            "installationId": self.installation_id,
            "definitionDigest": self.pack_digest,
            "scopeAuthority": self.scope_authority,
            "sourceBindings": self.source_bindings,
            "state": self.state,
            "revision": 1,
        }
        _ = KnowledgeScopeMount.model_validate(mount_payload)
        return self
