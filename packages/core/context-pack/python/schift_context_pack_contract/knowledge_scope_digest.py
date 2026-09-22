"""Canonical digests for Knowledge Scope models."""

from __future__ import annotations

from typing import TYPE_CHECKING

from schift_context_pack_contract.json_boundary import canonical_digest, to_json_value
from schift_context_pack_contract.knowledge_scope_candidate import (
    CandidateEnvelope,
    candidate_envelope_json_value,
)

if TYPE_CHECKING:
    from schift_context_pack_contract.knowledge_scope import (
        KnowledgeScopeDefinition,
        KnowledgeScopePack,
    )


def knowledge_scope_definition_digest(definition: KnowledgeScopeDefinition) -> str:
    """Digest only the portable Knowledge Scope definition."""
    normalized = to_json_value(
        definition.model_dump_json(by_alias=True, exclude_defaults=True, exclude_none=True)
    )
    return canonical_digest(normalized)


def knowledge_scope_digest(pack: KnowledgeScopePack) -> str:
    """Digest the normalized Knowledge Scope wire representation."""
    normalized = to_json_value(
        pack.model_dump_json(by_alias=True, exclude_defaults=True, exclude_none=True)
    )
    return canonical_digest(normalized)


def candidate_envelope_digest(candidate: CandidateEnvelope) -> str:
    """Digest the normalized provider candidate wire representation."""
    return canonical_digest(candidate_envelope_json_value(candidate))
