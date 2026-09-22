"""Typed errors raised at Context Pack trust boundaries."""

from __future__ import annotations

from typing import final, override


class ContextPackContractError(Exception):
    """Base error for the portable Context Pack contract."""


@final
class InvalidJsonError(ContextPackContractError):
    """Untrusted payload is not valid JSON."""

    __slots__ = ("detail",)
    detail: str

    def __init__(self, *, detail: str) -> None:
        super().__init__()
        self.detail = detail

    @override
    def __str__(self) -> str:
        return f"invalid JSON: {self.detail}"


@final
class InvalidManifestError(ContextPackContractError):
    """Portable manifest violates the v0.1 contract."""

    __slots__ = ("issues",)
    issues: tuple[str, ...]

    def __init__(self, *, issues: tuple[str, ...]) -> None:
        super().__init__()
        self.issues = issues

    @override
    def __str__(self) -> str:
        return "invalid Context Pack manifest: " + "; ".join(self.issues)


@final
class InvalidPortableLockError(ContextPackContractError):
    """Portable lock violates the v0.1 contract."""

    __slots__ = ("issues",)
    issues: tuple[str, ...]

    def __init__(self, *, issues: tuple[str, ...]) -> None:
        super().__init__()
        self.issues = issues

    @override
    def __str__(self) -> str:
        return "invalid portable Pack lock: " + "; ".join(self.issues)


@final
class ProhibitedPackMaterialError(ContextPackContractError):
    """Portable artifact contains installation data or a secret-like value."""

    __slots__ = ("material", "path")
    material: str
    path: str

    def __init__(self, *, path: str, material: str) -> None:
        super().__init__()
        self.path = path
        self.material = material

    @override
    def __str__(self) -> str:
        return f"prohibited Pack material {self.material!r} at {self.path}"
