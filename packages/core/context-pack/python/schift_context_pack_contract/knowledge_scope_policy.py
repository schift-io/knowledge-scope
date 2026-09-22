"""Pure policy matching helpers for Knowledge Scope admission."""

# Exhaustive defaults intentionally remain for future provider variants.
# pyright: reportUnnecessaryComparison=false, reportUnreachable=false

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, assert_never

from schift_context_pack_contract.knowledge_scope_candidate import (
    CandidateEnvelope,
    LocalDocumentsEvidence,
    OpenConnectorActionEvidence,
    ProviderEvidence,
    RecordsOperationEvidence,
    SchiftSearchEvidence,
    WebSearchEvidence,
)
from schift_context_pack_contract.knowledge_scope_capabilities import (
    LocalDocumentsProvider,
    OpenConnectorActionProvider,
    QueryCapability,
    RecordsOperationProvider,
    SchiftSearchProvider,
    WebSearchProvider,
)

if TYPE_CHECKING:
    from schift_context_pack_contract.knowledge_scope import (
        KnowledgeRequirement,
        KnowledgeSelector,
    )
    from schift_context_pack_contract.knowledge_scope_mount import KnowledgeSourceBinding

ProviderDenial = Literal[
    "provider_ref_mismatch",
    "connector_action_mismatch",
    "provider_scopes_missing",
    "provider_evidence_mismatch",
    "connector_ref_mismatch",
    "connector_run_missing",
    "connector_audit_missing",
]


def matches_selector(selector: KnowledgeSelector, binding: KnowledgeSourceBinding) -> bool:
    """Return whether a trusted binding satisfies a portable selector."""
    checks = (
        not selector.source_ids or binding.source_id in selector.source_ids,
        not selector.source_classes or binding.source_class in selector.source_classes,
        not selector.authorities or binding.authority in selector.authorities,
        not selector.origins or binding.origin in selector.origins,
    )
    return all(checks)


def matching_requirements(
    requirements: tuple[KnowledgeRequirement, ...], binding: KnowledgeSourceBinding
) -> tuple[KnowledgeRequirement, ...]:
    """Return requirements matched by one server-owned binding."""
    return tuple(rule for rule in requirements if matches_selector(rule.selector, binding))


def _records_denial(
    provider: RecordsOperationProvider, evidence: ProviderEvidence
) -> ProviderDenial | None:
    match evidence:
        case RecordsOperationEvidence(operation_id=operation_id):
            return None if operation_id == provider.operation_id else "provider_evidence_mismatch"
        case (
            OpenConnectorActionEvidence()
            | SchiftSearchEvidence()
            | LocalDocumentsEvidence()
            | WebSearchEvidence()
        ):
            return "provider_evidence_mismatch"
        case unreachable:
            assert_never(unreachable)


def _connector_denial(
    provider: OpenConnectorActionProvider,
    evidence: ProviderEvidence,
    binding: KnowledgeSourceBinding,
) -> ProviderDenial | None:
    match evidence:
        case OpenConnectorActionEvidence() as connector:
            if (
                binding.connector_ref != provider.connector_ref
                or connector.connector_ref != provider.connector_ref
            ):
                return "connector_ref_mismatch"
            if connector.action_id != provider.action_id:
                return "connector_action_mismatch"
            if not connector.connector_run_id:
                return "connector_run_missing"
            return None if connector.audit_persisted else "connector_audit_missing"
        case (
            RecordsOperationEvidence()
            | SchiftSearchEvidence()
            | LocalDocumentsEvidence()
            | WebSearchEvidence()
        ):
            return "provider_evidence_mismatch"
        case unreachable:
            assert_never(unreachable)


def _search_denial(
    provider: SchiftSearchProvider, evidence: ProviderEvidence
) -> ProviderDenial | None:
    match evidence:
        case SchiftSearchEvidence(index_ref=index_ref):
            return None if index_ref == provider.index_ref else "provider_evidence_mismatch"
        case (
            RecordsOperationEvidence()
            | OpenConnectorActionEvidence()
            | LocalDocumentsEvidence()
            | WebSearchEvidence()
        ):
            return "provider_evidence_mismatch"
        case unreachable:
            assert_never(unreachable)


def _local_documents_denial(
    provider: LocalDocumentsProvider, evidence: ProviderEvidence
) -> ProviderDenial | None:
    match evidence:
        case LocalDocumentsEvidence(index_ref=index_ref):
            return None if index_ref == provider.index_ref else "provider_evidence_mismatch"
        case (
            RecordsOperationEvidence()
            | OpenConnectorActionEvidence()
            | SchiftSearchEvidence()
            | WebSearchEvidence()
        ):
            return "provider_evidence_mismatch"
        case unreachable:
            assert_never(unreachable)


def _web_denial(provider: WebSearchProvider, evidence: ProviderEvidence) -> ProviderDenial | None:
    match evidence:
        case WebSearchEvidence(provider=actual):
            return None if actual == provider.provider else "provider_evidence_mismatch"
        case (
            RecordsOperationEvidence()
            | OpenConnectorActionEvidence()
            | SchiftSearchEvidence()
            | LocalDocumentsEvidence()
        ):
            return "provider_evidence_mismatch"
        case unreachable:
            assert_never(unreachable)


def provider_denial(
    capability: QueryCapability,
    binding: KnowledgeSourceBinding,
    candidate: CandidateEnvelope,
) -> ProviderDenial | None:
    """Verify provider-native identity and audit evidence against the declaration."""
    match capability.provider:
        case RecordsOperationProvider() as provider:
            return _records_denial(provider, candidate.provider_evidence)
        case OpenConnectorActionProvider() as provider:
            return _connector_denial(provider, candidate.provider_evidence, binding)
        case SchiftSearchProvider() as provider:
            return _search_denial(provider, candidate.provider_evidence)
        case LocalDocumentsProvider() as provider:
            return _local_documents_denial(provider, candidate.provider_evidence)
        case WebSearchProvider() as provider:
            return _web_denial(provider, candidate.provider_evidence)
        case unreachable:
            assert_never(unreachable)
