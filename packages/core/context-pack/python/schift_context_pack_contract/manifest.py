"""Strict portable Context Pack v0.1 manifest."""

from __future__ import annotations

from typing import Annotated, ClassVar, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_core import PydanticCustomError

from schift_context_pack_contract.errors import InvalidManifestError
from schift_context_pack_contract.json_boundary import (
    JsonValue,
    canonical_digest,
    inspect_portable_value,
    parse_json_value,
    to_json_value,
)

SCHEMA_VERSION = "context.schift.dev/v0.1"
Identifier = Annotated[str, Field(min_length=2, max_length=128, pattern=r"^[a-z0-9][a-z0-9._-]*$")]
SemVer = Annotated[
    str,
    Field(
        pattern=r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
    ),
]
Sha256Digest = Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]


def _portable_path(value: str) -> str:
    if value.startswith("/") or "://" in value or ".." in value.split("/") or "\\" in value:
        raise PydanticCustomError("portable_path", "must be a relative portable path")
    return value


PortablePath = Annotated[str, Field(min_length=1, max_length=512), AfterValidator(_portable_path)]
ExtensionName = Annotated[str, Field(pattern=r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$")]
Authority = Literal["primary", "operational", "approved", "observed", "derived"]


class ContractModel(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(
        extra="forbid", frozen=True, str_strip_whitespace=False
    )


class PackIdentity(ContractModel):
    id: Identifier
    version: SemVer
    kind: Literal["customer_context"]
    description: str | None = None


class PortableScope(ContractModel):
    level: Literal[
        "organization",
        "customer",
        "tenant",
        "product",
        "project",
        "course",
        "character",
        "user",
        "student",
        "session",
    ]
    parent: Annotated[str, Field(pattern=r"^[a-z]+:[a-z0-9._-]+$")] | None = None
    isolation: Literal["required"]


class DocumentSource(ContractModel):
    id: Identifier
    class_: Literal["document"] = Field(alias="class")
    authority: Authority


class RdbReadOperation(ContractModel):
    id: Identifier
    parameters_schema: PortablePath
    result_schema: PortablePath


class RdbSource(ContractModel):
    id: Identifier
    class_: Literal["rdb"] = Field(alias="class")
    authority: Authority
    read_operations: Annotated[tuple[RdbReadOperation, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def require_unique_operations(self) -> RdbSource:
        ids = tuple(operation.id for operation in self.read_operations)
        if len(ids) != len(set(ids)):
            raise PydanticCustomError(
                "duplicate_read_operation",
                "RDB read operation IDs must be unique",
            )
        return self


class EventSource(ContractModel):
    id: Identifier
    class_: Literal["event"] = Field(alias="class")
    authority: Authority
    retention_class: Literal["session", "durable", "derived"]


SourceDeclaration = Annotated[
    DocumentSource | RdbSource | EventSource, Field(discriminator="class_")
]


class PolicyReferences(ContractModel):
    authority: PortablePath
    retrieval: PortablePath
    permission: PortablePath
    retention: PortablePath


class EvalReferences(ContractModel):
    questions: PortablePath
    expected_evidence: PortablePath


class RuntimeRequirements(ContractModel):
    capabilities: Annotated[
        tuple[
            Literal[
                "scoped_search", "context_with_citations", "named_record_queries", "event_append"
            ],
            ...,
        ],
        Field(min_length=1),
    ]


class PortableFileChecksum(ContractModel):
    path: PortablePath
    sha256: Sha256Digest


class ContextPackManifest(ContractModel):
    schema_version: Literal["context.schift.dev/v0.1"]
    pack: PackIdentity
    scope: PortableScope
    sources: tuple[SourceDeclaration, ...]
    policies: PolicyReferences
    eval: EvalReferences
    runtime: RuntimeRequirements
    extensions: dict[ExtensionName, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_unique_sources(self) -> ContextPackManifest:
        ids = tuple(source.id for source in self.sources)
        if len(ids) != len(set(ids)):
            raise PydanticCustomError("duplicate_source", "source IDs must be unique")
        return self


def validation_issues(error: ValidationError) -> tuple[str, ...]:
    """Format Pydantic issues deterministically."""
    return tuple(
        f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in error.errors()
    )


def parse_manifest_json(payload: str | bytes) -> ContextPackManifest:
    """Parse an untrusted portable manifest."""
    value = parse_json_value(payload)
    inspect_portable_value(value)
    try:
        return ContextPackManifest.model_validate(value)
    except ValidationError as error:
        raise InvalidManifestError(issues=validation_issues(error)) from error


def manifest_json_value(manifest: ContextPackManifest) -> JsonValue:
    """Return an alias-preserving JSON value for canonicalization."""
    return to_json_value(manifest.model_dump_json(by_alias=True, exclude_none=True))


def manifest_digest(manifest: ContextPackManifest) -> str:
    """Digest a manifest independently of input key ordering."""
    return canonical_digest(manifest_json_value(manifest))
