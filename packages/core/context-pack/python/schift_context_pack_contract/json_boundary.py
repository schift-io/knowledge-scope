"""Canonical JSON and prohibited-material inspection."""

# Exhaustive wildcard arms are required by the cross-language contract audit.
# pyright: reportUnnecessaryComparison=false

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Final, assert_never

from pydantic import TypeAdapter, ValidationError

from schift_context_pack_contract.errors import InvalidJsonError, ProhibitedPackMaterialError

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]

_JSON_ADAPTER: Final[TypeAdapter[JsonValue]] = TypeAdapter(JsonValue)
_FORBIDDEN_KEYS: Final = frozenset(
    {
        "api_key",
        "connection_string",
        "connection_url",
        "content",
        "credential",
        "credential_value",
        "inline_source",
        "password",
        "payload",
        "private_key",
        "raw_content",
        "secret",
        "source_data",
        "sql",
        "token",
    }
)
_CREDENTIAL_URI: Final = re.compile(r"^[a-z][a-z0-9+.-]*://[^/@\s:]+:[^/@\s]+@", re.IGNORECASE)
_SECRET_MARKERS: Final = ("-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----")
_FIXED_DECIMAL_MIN_EXCLUSIVE: Final = -6
_FIXED_DECIMAL_MAX_INCLUSIVE: Final = 21


def parse_json_value(payload: str | bytes) -> JsonValue:
    """Parse untrusted JSON into the recursive JSON value union."""
    try:
        return _JSON_ADAPTER.validate_json(payload)
    except ValidationError as error:
        raise InvalidJsonError(detail=str(error)) from error


def _inspect_mapping(mapping: dict[str, JsonValue], path: str) -> None:
    for key, child in mapping.items():
        child_path = f"{path}.{key}"
        if key.casefold() in _FORBIDDEN_KEYS:
            raise ProhibitedPackMaterialError(path=child_path, material=key)
        inspect_portable_value(child, child_path)


def _inspect_sequence(sequence: list[JsonValue], path: str) -> None:
    for index, child in enumerate(sequence):
        inspect_portable_value(child, f"{path}[{index}]")


def _inspect_text(text: str, path: str) -> None:
    if _CREDENTIAL_URI.search(text) is not None:
        raise ProhibitedPackMaterialError(path=path, material="credential-bearing URI")
    for marker in _SECRET_MARKERS:
        if marker in text:
            raise ProhibitedPackMaterialError(path=path, material=marker)


def _inspect_integer(number: int, path: str) -> None:
    if not -(2**53 - 1) <= number <= 2**53 - 1:
        raise ProhibitedPackMaterialError(
            path=path,
            material="number outside the portable safe-integer range",
        )


def inspect_portable_value(value: JsonValue, path: str = "$") -> None:
    """Reject inline source material and credential values from portable artifacts."""
    match value:
        case dict() as mapping:
            _inspect_mapping(mapping, path)
            return
        case list() as sequence:
            _inspect_sequence(sequence, path)
            return
        case str() as text:
            _inspect_text(text, path)
            return
        case bool() | None:
            return
        case int() as number:
            _inspect_integer(number, path)
            return
        case float():
            raise ProhibitedPackMaterialError(
                path=path,
                material="non-integer portable number",
            )
        case unreachable:
            assert_never(unreachable)


def _ecmascript_float(value: float) -> str:
    if not math.isfinite(value):
        raise InvalidJsonError(detail="canonical JSON requires finite numbers")
    if value == 0:
        return "0"
    text = repr(value).lower()
    sign = "-" if text.startswith("-") else ""
    unsigned = text.removeprefix("-")
    coefficient, separator, exponent_text = unsigned.partition("e")
    exponent = int(exponent_text) if separator else 0
    integer, point, fraction = coefficient.partition(".")
    raw_digits = integer + fraction if point else integer
    leading_zeros = len(raw_digits) - len(raw_digits.lstrip("0"))
    digits = raw_digits.lstrip("0").rstrip("0")
    decimal_point = len(integer) - leading_zeros + exponent
    if (
        decimal_point <= _FIXED_DECIMAL_MIN_EXCLUSIVE
        or decimal_point > _FIXED_DECIMAL_MAX_INCLUSIVE
    ):
        exponent_value = decimal_point - 1
        exponent_sign = "+" if exponent_value >= 0 else "-"
        exponent_digits = str(abs(exponent_value))
        significand = digits[0] if len(digits) == 1 else f"{digits[0]}.{digits[1:]}"
        return f"{sign}{significand}e{exponent_sign}{exponent_digits}"
    if decimal_point <= 0:
        return f"{sign}0.{('0' * -decimal_point)}{digits}"
    if decimal_point >= len(digits):
        return f"{sign}{digits}{'0' * (decimal_point - len(digits))}"
    return f"{sign}{digits[:decimal_point]}.{digits[decimal_point:]}"


def _canonical_serialize(value: JsonValue) -> str:
    match value:
        case dict() as mapping:
            entries = sorted(
                mapping.items(),
                key=lambda item: item[0].encode("utf-16-be", "surrogatepass"),
            )
            serialized = (
                "{"
                + ",".join(
                    f"{json.dumps(key, ensure_ascii=False)}:{_canonical_serialize(child)}"
                    for key, child in entries
                )
                + "}"
            )
        case list() as sequence:
            serialized = "[" + ",".join(_canonical_serialize(child) for child in sequence) + "]"
        case str() as text:
            serialized = json.dumps(text, ensure_ascii=False)
        case bool() as boolean:
            serialized = "true" if boolean else "false"
        case int() as integer:
            serialized = str(integer)
        case float() as number:
            serialized = _ecmascript_float(number)
        case None:
            serialized = "null"
        case unreachable:
            assert_never(unreachable)
    return serialized


def canonical_json(value: JsonValue) -> str:
    """Serialize JSON using JavaScript-compatible UTF-16 key ordering."""
    return _canonical_serialize(value)


def canonical_digest(value: JsonValue) -> str:
    """Return a prefixed SHA-256 digest of canonical UTF-8 JSON."""
    encoded = canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def to_json_value(value: str | bytes) -> JsonValue:
    """Normalize already-serialized Pydantic JSON without untyped escapes."""
    return parse_json_value(value)
