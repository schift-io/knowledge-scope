from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Final

import pytest
from pydantic import TypeAdapter, ValidationError

from schift_context_pack_contract.json_boundary import JsonValue, parse_json_value
from schift_context_pack_contract.knowledge_scope import (
    KnowledgeScopeDefinition,
    materialize_knowledge_scope_pack,
)
from schift_context_pack_contract.knowledge_scope_admission import admit_candidate
from schift_context_pack_contract.knowledge_scope_candidate import CandidateEnvelope
from schift_context_pack_contract.knowledge_scope_capabilities import QueryProvider
from schift_context_pack_contract.knowledge_scope_digest import knowledge_scope_definition_digest
from schift_context_pack_contract.knowledge_scope_mount import KnowledgeScopeMount

FIXTURES = Path(__file__).resolve().parents[5] / "packages/context-pack/fixtures/knowledge-scope"
PROVIDER_ADAPTER: Final[TypeAdapter[QueryProvider]] = TypeAdapter(QueryProvider)


def _fixture(name: str) -> dict[str, JsonValue]:
    value = parse_json_value((FIXTURES / name).read_bytes())
    assert isinstance(value, dict)
    return value


def test_local_provider_keeps_opaque_identity() -> None:
    # Given a deployment-independent index identifier.
    value = {"kind": "local_documents", "indexRef": "index.manuals"}
    # When the provider crosses the portable schema boundary.
    provider = PROVIDER_ADAPTER.validate_python(value)
    # Then it normalizes to the same wire identity as TypeScript.
    assert provider.model_dump(by_alias=True) == value


@pytest.mark.parametrize(
    "index_ref", ["/data/docs", "../docs", "file:///data/docs", "C:\\docs", "", "a"]
)
def test_local_provider_rejects_paths(index_ref: str) -> None:
    # Given a non-portable path or malformed identifier.
    value = {"kind": "local_documents", "indexRef": index_ref}
    # When parsed, then the declaration is rejected.
    with pytest.raises(ValidationError):
        _ = PROVIDER_ADAPTER.validate_python(value)


def test_local_provider_rejects_embedded_configuration() -> None:
    # Given source configuration embedded in the portable declaration.
    value = {"kind": "local_documents", "indexRef": "index.manuals", "path": "/data/docs"}
    # When parsed, then the extra field is rejected.
    with pytest.raises(ValidationError):
        _ = PROVIDER_ADAPTER.validate_python(value)


@pytest.mark.parametrize(
    ("kind", "index_ref", "accepted"),
    [
        ("local_documents", "index.manuals", True),
        ("local_documents", "index.other", False),
        ("schift_search", "index.manuals", False),
    ],
)
def test_local_admission_checks_native_identity(
    kind: str, index_ref: str, *, accepted: bool
) -> None:
    # Given the shared document binding with a local provider declaration.
    value = _fixture("valid-definition.json")
    capabilities = value["capabilities"]
    assert isinstance(capabilities, list)
    for capability in capabilities:
        assert isinstance(capability, dict)
        if capability["operationId"] == "search_product_manuals":
            capability["provider"] = {"kind": "local_documents", "indexRef": "index.manuals"}
    definition = KnowledgeScopeDefinition.model_validate(value)
    mount = KnowledgeScopeMount.model_validate(_fixture("valid-mount.json"))
    candidate = CandidateEnvelope.model_validate(
        {
            **_fixture("valid-candidate.json"),
            "srn": "srn:schift:acme:document:manuals/page_1",
            "sourceId": "product.manuals",
            "sourceClass": "document",
            "providerRef": "index.product_manuals",
            "operationId": "search_product_manuals",
            "permissionMode": "mirrored",
            "providerScopes": [],
            "providerEvidence": {"kind": kind, "indexRef": index_ref},
            "freshness": "2026-09-22T09:01:00Z",
        }
    )
    # When provider-native evidence is checked against the declared local index.
    receipt = admit_candidate(
        definition,
        mount,
        candidate,
        datetime.fromisoformat("2026-09-22T09:02:00Z"),
        candidate.authorization_decision,
    )
    # Then another index cannot impersonate the declared corpus.
    assert receipt.status == ("accepted" if accepted else "denied")
    if receipt.status == "denied":
        assert receipt.reason_code == "provider_evidence_mismatch"


def test_local_definition_digest_matches_typescript() -> None:
    # Given the same local declaration mutation used by TypeScript.
    value = _fixture("valid-definition.json")
    capabilities = value["capabilities"]
    assert isinstance(capabilities, list)
    for capability in capabilities:
        assert isinstance(capability, dict)
        if capability["operationId"] == "search_product_manuals":
            capability["provider"] = {"kind": "local_documents", "indexRef": "index.manuals"}
    definition = KnowledgeScopeDefinition.model_validate(value)
    # When the normalized definition is digested.
    digest = knowledge_scope_definition_digest(definition)
    # Then both runtimes sign the same portable definition.
    assert digest == "sha256:4fa8fd40c5c1a6b3cb83e2c7234d6a365eba5363fc5d79a72829310fd7817c7f"


def test_local_binding_materializes() -> None:
    # Given the existing index reference declared as a local provider.
    value = _fixture("valid-definition.json")
    capabilities = value["capabilities"]
    assert isinstance(capabilities, list)
    for capability in capabilities:
        assert isinstance(capability, dict)
        provider = capability["provider"]
        assert isinstance(provider, dict)
        if provider["kind"] == "schift_search":
            provider["kind"] = "local_documents"
    definition = KnowledgeScopeDefinition.model_validate(value)
    mount = KnowledgeScopeMount.model_validate(_fixture("valid-mount.json"))
    # When the compatibility view materializes this binding.
    pack = materialize_knowledge_scope_pack(definition, mount)
    # Then provider identity remains local and opaque.
    assert any(capability.provider.kind == "local_documents" for capability in pack.capabilities)
