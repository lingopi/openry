"""Phase 3a: Unified validation engine for conditional routing.

Provides 9 validation types with a common interface. Completely independent
of Phase 2's validation.py — that module continues to serve the legacy
`validation` YAML field, while this module serves `validation_routing`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable

# ── Data structures ────────────────────────────────────────────


@dataclass
class ValidationContext:
    """All data a validator needs to evaluate a condition."""

    run_id: str
    payload: dict[str, Any]
    step_config: dict[str, Any] = field(default_factory=dict)


@dataclass
class ValidationResult:
    """Result of a single validation check."""

    passed: bool
    message: str = ""
    details: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def ok(cls, message: str = "") -> ValidationResult:
        return cls(passed=True, message=message)

    @classmethod
    def fail(cls, message: str, **details: Any) -> ValidationResult:
        return cls(passed=False, message=message, details=dict(details))


# ── Unified entry point ────────────────────────────────────────


def validate(ctx: ValidationContext, rule: dict[str, Any]) -> ValidationResult:
    """Dispatch a single validation rule to the appropriate handler.

    Args:
        ctx: Validation context (run_id, payload, step_config).
        rule: A single validation rule dict with at least a 'type' key.

    Returns:
        ValidationResult with passed/message/details.
    """
    rule_type = rule.get("type", "")
    handler = VALIDATOR_REGISTRY.get(rule_type)
    if handler is None:
        return ValidationResult.fail(
            f"unknown validation type: {rule_type}",
            rule_type=rule_type,
        )
    try:
        return handler(ctx, rule)
    except Exception as exc:
        return ValidationResult.fail(
            f"validation error ({rule_type}): {exc}",
            rule_type=rule_type,
            exception=str(exc),
        )


# ── Individual validators ──────────────────────────────────────


def _validate_payload_values_equal(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Compare two payload keys for equality."""
    key_a = rule["key_a"]
    key_b = rule["key_b"]
    val_a = ctx.payload.get(key_a)
    val_b = ctx.payload.get(key_b)
    if val_a == val_b:
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"values not equal: {key_a}={val_a!r} != {key_b}={val_b!r}",
        key_a=key_a, key_b=key_b, val_a=val_a, val_b=val_b,
    )


def _validate_payload_values_not_equal(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Compare two payload keys for inequality."""
    key_a = rule["key_a"]
    key_b = rule["key_b"]
    val_a = ctx.payload.get(key_a)
    val_b = ctx.payload.get(key_b)
    if val_a != val_b:
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"values unexpectedly equal: {key_a}={val_a!r} == {key_b}={val_b!r}",
        key_a=key_a, key_b=key_b, val_a=val_a, val_b=val_b,
    )


def _validate_payload_value_equals(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Compare a payload key against a literal value."""
    key = rule["key"]
    expected = rule["value"]
    actual = ctx.payload.get(key)
    if actual == expected:
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"value mismatch: {key}={actual!r}, expected {expected!r}",
        key=key, actual=actual, expected=expected,
    )


def _validate_payload_value_in_set(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Check if a payload value is in (or not in) a set of allowed values."""
    key = rule["key"]
    values = rule.get("values", [])
    mode = rule.get("mode", "allow")  # "allow" | "deny"
    actual = ctx.payload.get(key)

    in_set = actual in values
    if mode == "allow":
        if in_set:
            return ValidationResult.ok()
        return ValidationResult.fail(
            f"value not in allowed set: {key}={actual!r}, allowed={values!r}",
            key=key, actual=actual, values=values, mode=mode,
        )
    else:  # mode == "deny"
        if not in_set:
            return ValidationResult.ok()
        return ValidationResult.fail(
            f"value in denied set: {key}={actual!r}, denied={values!r}",
            key=key, actual=actual, values=values, mode=mode,
        )


def _validate_payload_value_greater_than(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Check if a payload value is greater than (or >=) a threshold."""
    key = rule["key"]
    threshold = rule["threshold"]
    or_equal = rule.get("or_equal", False)
    actual = ctx.payload.get(key)

    if actual is None:
        return ValidationResult.fail(
            f"key not found in payload: {key}", key=key,
        )
    try:
        actual_num = float(actual)
    except (TypeError, ValueError):
        return ValidationResult.fail(
            f"value is not numeric: {key}={actual!r}", key=key, actual=actual,
        )

    passed = actual_num >= threshold if or_equal else actual_num > threshold
    if passed:
        return ValidationResult.ok()
    op = ">=" if or_equal else ">"
    return ValidationResult.fail(
        f"value not {op} threshold: {key}={actual_num}, threshold={threshold}",
        key=key, actual=actual_num, threshold=threshold, or_equal=or_equal,
    )


def _validate_payload_value_less_than(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Check if a payload value is less than (or <=) a threshold."""
    key = rule["key"]
    threshold = rule["threshold"]
    or_equal = rule.get("or_equal", False)
    actual = ctx.payload.get(key)

    if actual is None:
        return ValidationResult.fail(
            f"key not found in payload: {key}", key=key,
        )
    try:
        actual_num = float(actual)
    except (TypeError, ValueError):
        return ValidationResult.fail(
            f"value is not numeric: {key}={actual!r}", key=key, actual=actual,
        )

    passed = actual_num <= threshold if or_equal else actual_num < threshold
    if passed:
        return ValidationResult.ok()
    op = "<=" if or_equal else "<"
    return ValidationResult.fail(
        f"value not {op} threshold: {key}={actual_num}, threshold={threshold}",
        key=key, actual=actual_num, threshold=threshold, or_equal=or_equal,
    )


def _validate_payload_type(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Check if a payload value is of the expected Python type."""
    key = rule["key"]
    expected_type = rule["expected_type"]  # "int" | "float" | "str" | "bool" | "list" | "dict" | "null"
    actual = ctx.payload.get(key)

    TYPE_MAP: dict[str, type | tuple] = {
        "int": int,
        "float": float,
        "str": str,
        "bool": bool,
        "list": list,
        "dict": dict,
        "null": type(None),
    }
    expected_cls = TYPE_MAP.get(expected_type)
    if expected_cls is None:
        return ValidationResult.fail(
            f"unknown expected_type: {expected_type}",
            key=key, expected_type=expected_type,
        )

    if isinstance(actual, expected_cls):
        # Special case: bool is a subclass of int in Python
        if expected_type == "int" and isinstance(actual, bool):
            return ValidationResult.fail(
                f"expected int but got bool: {key}={actual!r}",
                key=key, actual=actual, expected_type=expected_type,
            )
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"type mismatch: {key}={actual!r} ({type(actual).__name__}), "
        f"expected {expected_type}",
        key=key, actual=actual, actual_type=type(actual).__name__,
        expected_type=expected_type,
    )


def _validate_file_size_greater_than(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Check if a file (path from payload) has size > min_bytes."""
    path_key = rule["path_key"]
    min_bytes = rule["min_bytes"]
    file_path = ctx.payload.get(path_key)

    if not file_path:
        return ValidationResult.fail(
            f"file path key not found in payload: {path_key}",
            path_key=path_key,
        )
    if not os.path.exists(str(file_path)):
        return ValidationResult.fail(
            f"file not found: {file_path}",
            path_key=path_key, file_path=str(file_path),
        )
    try:
        size = os.path.getsize(str(file_path))
    except OSError as exc:
        return ValidationResult.fail(
            f"cannot stat file: {file_path}: {exc}",
            path_key=path_key, file_path=str(file_path), exception=str(exc),
        )

    if size > min_bytes:
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"file size {size} <= {min_bytes}: {file_path}",
        path_key=path_key, file_path=str(file_path),
        size=size, min_bytes=min_bytes,
    )


def _validate_http_status(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Make an HTTP request and check the response status code."""
    url = rule["url"]
    expected_status = rule["expected_status"]
    method = rule.get("method", "GET").upper()
    timeout = rule.get("timeout_seconds", 10)

    try:
        import urllib.request
        import urllib.error

        req = urllib.request.Request(url, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                actual_status = resp.status
        except urllib.error.HTTPError as exc:
            actual_status = exc.code
    except Exception as exc:
        return ValidationResult.fail(
            f"HTTP request failed: {url}: {exc}",
            url=url, method=method, exception=str(exc),
        )

    if actual_status == expected_status:
        return ValidationResult.ok()
    return ValidationResult.fail(
        f"HTTP status mismatch: {url} → {actual_status}, expected {expected_status}",
        url=url, method=method,
        actual_status=actual_status, expected_status=expected_status,
    )


def _validate_json_schema(
    ctx: ValidationContext, rule: dict[str, Any],
) -> ValidationResult:
    """Validate a payload value against a JSON Schema (draft-07).

    Requires the optional 'jsonschema' package.
    """
    key = rule["key"]
    schema = rule["schema"]
    instance = ctx.payload.get(key)

    try:
        import jsonschema
    except ImportError:
        return ValidationResult.fail(
            f"jsonschema package not installed (pip install jsonschema). "
            f"Cannot validate schema for {key}",
            key=key,
        )

    try:
        jsonschema.validate(instance=instance, schema=schema)
        return ValidationResult.ok()
    except jsonschema.ValidationError as exc:
        return ValidationResult.fail(
            f"JSON Schema validation failed for {key}: {exc.message}",
            key=key, schema_path=list(exc.absolute_path),
            schema_message=exc.message,
        )
    except jsonschema.SchemaError as exc:
        return ValidationResult.fail(
            f"Invalid JSON Schema for {key}: {exc.message}",
            key=key, schema_message=exc.message,
        )


# ── Registry ───────────────────────────────────────────────────

VALIDATOR_REGISTRY: dict[str, Callable[[ValidationContext, dict[str, Any]], ValidationResult]] = {
    "payload_values_equal": _validate_payload_values_equal,
    "payload_values_not_equal": _validate_payload_values_not_equal,
    "payload_value_equals": _validate_payload_value_equals,
    "payload_value_in_set": _validate_payload_value_in_set,
    "payload_value_greater_than": _validate_payload_value_greater_than,
    "payload_value_less_than": _validate_payload_value_less_than,
    "payload_type": _validate_payload_type,
    "file_size_greater_than": _validate_file_size_greater_than,
    "http_status": _validate_http_status,
    "json_schema": _validate_json_schema,
}
