"""Deterministic portable lock for a Knowledge Scope definition."""

# Recursive JSON matching keeps a future-proof exhaustive default.
# pyright: reportUnnecessaryComparison=false

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Final, Literal, assert_never, final, override

from pydantic import Field

from schift_context_pack_contract.json_boundary import JsonValue, canonical_digest, to_json_value
from schift_context_pack_contract.knowledge_scope import KnowledgeScopeDefinition
from schift_context_pack_contract.knowledge_scope_digest import knowledge_scope_definition_digest
from schift_context_pack_contract.manifest import (
    ContractModel,
    Identifier,
    PortablePath,
    SemVer,
    Sha256Digest,
)

type KnowledgeScopeJsonFiles = Mapping[str, JsonValue]
_MAX_SAFE_INTEGER: Final = 2**53 - 1


@final
class KnowledgeScopeLockError(Exception):
    __slots__ = ("code", "path")

    def __init__(self, *, code: str, path: str) -> None:
        super().__init__()
        self.code = code
        self.path = path

    @override
    def __str__(self) -> str:
        return f"{self.code}: {self.path}"


class KnowledgeScopeLockFile(ContractModel):
    path: PortablePath
    digest: Sha256Digest


class KnowledgeScopeLock(ContractModel):
    schema_version: Literal["knowledge-scope-lock.schift.dev/v0.1"] = Field(alias="schemaVersion")
    pack_id: Identifier = Field(alias="packId")
    version: SemVer
    definition_digest: Sha256Digest = Field(alias="definitionDigest")
    files: tuple[KnowledgeScopeLockFile, ...]
    lock_digest: Sha256Digest = Field(alias="lockDigest")


def _required_paths(definition: KnowledgeScopeDefinition) -> tuple[str, ...]:
    paths = {"scope.json"}
    for capability in definition.capabilities:
        paths.add(capability.input_schema_ref)
        paths.add(capability.result_schema_ref)
    return tuple(sorted(paths))


def _validate_inventory(
    definition: KnowledgeScopeDefinition,
    files: KnowledgeScopeJsonFiles,
) -> tuple[str, ...]:
    required = _required_paths(definition)
    supplied = tuple(sorted(files))
    if supplied != required:
        raise KnowledgeScopeLockError(code="invalid_file_inventory", path=",".join(supplied))
    for path in supplied:
        parts = path.split("/")
        if path.startswith("/") or "\\" in path or any(part in {"", ".", ".."} for part in parts):
            raise KnowledgeScopeLockError(code="invalid_portable_path", path=path)
    scope = KnowledgeScopeDefinition.model_validate(files["scope.json"])
    if scope != definition:
        raise KnowledgeScopeLockError(code="definition_file_mismatch", path="scope.json")
    return supplied


def _lock_projection(lock: KnowledgeScopeLock) -> JsonValue:
    return to_json_value(lock.model_dump_json(by_alias=True, exclude={"lock_digest"}))


def _normalize_lock_value(value: JsonValue, path: str) -> JsonValue:
    match value:
        case dict() as mapping:
            return {
                key: _normalize_lock_value(child, f"{path}.{key}") for key, child in mapping.items()
            }
        case list() as items:
            return [
                _normalize_lock_value(child, f"{path}[{index}]")
                for index, child in enumerate(items)
            ]
        case bool() | str() | None:
            return value
        case int() as number:
            if abs(number) > _MAX_SAFE_INTEGER:
                raise KnowledgeScopeLockError(code="non_portable_number", path=path)
            return number
        case float() as number:
            if (
                not math.isfinite(number)
                or not number.is_integer()
                or abs(number) > _MAX_SAFE_INTEGER
            ):
                raise KnowledgeScopeLockError(code="non_portable_number", path=path)
            return int(number)
        case unreachable:
            assert_never(unreachable)


def build_knowledge_scope_lock(
    definition: KnowledgeScopeDefinition,
    files: KnowledgeScopeJsonFiles,
) -> KnowledgeScopeLock:
    """Build the canonical definition-only lock over exact parsed JSON files."""
    paths = _validate_inventory(definition, files)
    entries = tuple(
        KnowledgeScopeLockFile(
            path=path,
            digest=canonical_digest(_normalize_lock_value(files[path], path)),
        )
        for path in paths
    )
    unsigned = {
        "schemaVersion": "knowledge-scope-lock.schift.dev/v0.1",
        "packId": definition.pack_id,
        "version": definition.version,
        "definitionDigest": knowledge_scope_definition_digest(definition),
        "files": tuple(item.model_dump(by_alias=True) for item in entries),
        "lockDigest": "sha256:" + ("0" * 64),
    }
    draft = KnowledgeScopeLock.model_validate(unsigned)
    return draft.model_copy(update={"lock_digest": canonical_digest(_lock_projection(draft))})


def verify_knowledge_scope_lock(
    definition: KnowledgeScopeDefinition,
    files: KnowledgeScopeJsonFiles,
    lock: KnowledgeScopeLock,
) -> bool:
    """Return whether a lock exactly matches its definition and JSON inventory."""
    try:
        expected = build_knowledge_scope_lock(definition, files)
    except KnowledgeScopeLockError:
        return False
    return expected == lock
