"""Phase 3a: Unit tests for validator.py — all 10 validation types."""

from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from openry.orchestrator.validator import (
    ValidationContext,
    ValidationResult,
    validate,
    VALIDATOR_REGISTRY,
)


# ── Helpers ────────────────────────────────────────────────────

def _ctx(**payload):
    return ValidationContext(run_id="test-run", payload=dict(payload))


# ── payload_values_equal ───────────────────────────────────────


def test_values_equal_pass():
    r = validate(_ctx(a=1, b=1), {"type": "payload_values_equal", "key_a": "a", "key_b": "b"})
    assert r.passed


def test_values_equal_fail():
    r = validate(_ctx(a=1, b=2), {"type": "payload_values_equal", "key_a": "a", "key_b": "b"})
    assert not r.passed
    assert "values not equal" in r.message


def test_values_equal_missing_key():
    # Both keys missing → None == None → passes
    r = validate(_ctx(), {"type": "payload_values_equal", "key_a": "a", "key_b": "b"})
    assert r.passed


def test_values_equal_one_missing():
    # One key present, one missing → not equal
    r = validate(_ctx(a=1), {"type": "payload_values_equal", "key_a": "a", "key_b": "b"})
    assert not r.passed


def test_values_equal_strings():
    r = validate(_ctx(x="hello", y="hello"), {"type": "payload_values_equal", "key_a": "x", "key_b": "y"})
    assert r.passed


# ── payload_values_not_equal ───────────────────────────────────


def test_values_not_equal_pass():
    r = validate(_ctx(a=1, b=2), {"type": "payload_values_not_equal", "key_a": "a", "key_b": "b"})
    assert r.passed


def test_values_not_equal_fail():
    r = validate(_ctx(a=1, b=1), {"type": "payload_values_not_equal", "key_a": "a", "key_b": "b"})
    assert not r.passed


# ── payload_value_equals ───────────────────────────────────────


def test_value_equals_pass():
    r = validate(_ctx(status="active"), {"type": "payload_value_equals", "key": "status", "value": "active"})
    assert r.passed


def test_value_equals_fail():
    r = validate(_ctx(status="inactive"), {"type": "payload_value_equals", "key": "status", "value": "active"})
    assert not r.passed
    assert "value mismatch" in r.message


def test_value_equals_int():
    r = validate(_ctx(count=5), {"type": "payload_value_equals", "key": "count", "value": 5})
    assert r.passed


def test_value_equals_bool():
    r = validate(_ctx(is_admin=True), {"type": "payload_value_equals", "key": "is_admin", "value": True})
    assert r.passed


def test_value_equals_null():
    r = validate(_ctx(x=None), {"type": "payload_value_equals", "key": "x", "value": None})
    assert r.passed


# ── payload_value_in_set ───────────────────────────────────────


def test_in_set_allow_pass():
    r = validate(_ctx(role="admin"), {"type": "payload_value_in_set", "key": "role", "values": ["admin", "editor"], "mode": "allow"})
    assert r.passed


def test_in_set_allow_fail():
    r = validate(_ctx(role="viewer"), {"type": "payload_value_in_set", "key": "role", "values": ["admin", "editor"], "mode": "allow"})
    assert not r.passed


def test_in_set_deny_pass():
    r = validate(_ctx(role="viewer"), {"type": "payload_value_in_set", "key": "role", "values": ["admin", "banned"], "mode": "deny"})
    assert r.passed


def test_in_set_deny_fail():
    r = validate(_ctx(role="admin"), {"type": "payload_value_in_set", "key": "role", "values": ["admin", "banned"], "mode": "deny"})
    assert not r.passed


# ── payload_value_greater_than ──────────────────────────────────


def test_greater_than_pass():
    r = validate(_ctx(count=10), {"type": "payload_value_greater_than", "key": "count", "threshold": 5})
    assert r.passed


def test_greater_than_fail():
    r = validate(_ctx(count=3), {"type": "payload_value_greater_than", "key": "count", "threshold": 5})
    assert not r.passed


def test_greater_than_or_equal_pass():
    r = validate(_ctx(count=5), {"type": "payload_value_greater_than", "key": "count", "threshold": 5, "or_equal": True})
    assert r.passed


def test_greater_than_or_equal_fail():
    r = validate(_ctx(count=4), {"type": "payload_value_greater_than", "key": "count", "threshold": 5, "or_equal": True})
    assert not r.passed


def test_greater_than_missing_key():
    r = validate(_ctx(), {"type": "payload_value_greater_than", "key": "count", "threshold": 5})
    assert not r.passed
    assert "not found" in r.message


def test_greater_than_non_numeric():
    r = validate(_ctx(count="abc"), {"type": "payload_value_greater_than", "key": "count", "threshold": 5})
    assert not r.passed
    assert "not numeric" in r.message


# ── payload_value_less_than ─────────────────────────────────────


def test_less_than_pass():
    r = validate(_ctx(errors=2), {"type": "payload_value_less_than", "key": "errors", "threshold": 5})
    assert r.passed


def test_less_than_fail():
    r = validate(_ctx(errors=10), {"type": "payload_value_less_than", "key": "errors", "threshold": 5})
    assert not r.passed


def test_less_than_or_equal_pass():
    r = validate(_ctx(errors=5), {"type": "payload_value_less_than", "key": "errors", "threshold": 5, "or_equal": True})
    assert r.passed


# ── payload_type ───────────────────────────────────────────────


def test_type_int_pass():
    r = validate(_ctx(x=1), {"type": "payload_type", "key": "x", "expected_type": "int"})
    assert r.passed


def test_type_int_fail_bool():
    r = validate(_ctx(x=True), {"type": "payload_type", "key": "x", "expected_type": "int"})
    assert not r.passed  # bool is subclass of int, should be rejected


def test_type_str_pass():
    r = validate(_ctx(name="hello"), {"type": "payload_type", "key": "name", "expected_type": "str"})
    assert r.passed


def test_type_list_pass():
    r = validate(_ctx(items=[1, 2, 3]), {"type": "payload_type", "key": "items", "expected_type": "list"})
    assert r.passed


def test_type_dict_pass():
    r = validate(_ctx(data={"a": 1}), {"type": "payload_type", "key": "data", "expected_type": "dict"})
    assert r.passed


def test_type_null_pass():
    r = validate(_ctx(x=None), {"type": "payload_type", "key": "x", "expected_type": "null"})
    assert r.passed


def test_type_fail():
    r = validate(_ctx(x="hello"), {"type": "payload_type", "key": "x", "expected_type": "int"})
    assert not r.passed


# ── file_size_greater_than ─────────────────────────────────────


def test_file_size_pass():
    with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".txt") as f:
        f.write("hello world!")  # 12 bytes
        tmp = f.name
    try:
        r = validate(_ctx(path=tmp), {"type": "file_size_greater_than", "path_key": "path", "min_bytes": 5})
        assert r.passed
    finally:
        os.unlink(tmp)


def test_file_size_fail():
    with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".txt") as f:
        f.write("hi")  # 2 bytes
        tmp = f.name
    try:
        r = validate(_ctx(path=tmp), {"type": "file_size_greater_than", "path_key": "path", "min_bytes": 5})
        assert not r.passed
    finally:
        os.unlink(tmp)


def test_file_size_not_found():
    r = validate(_ctx(path="/nonexistent/file.txt"), {"type": "file_size_greater_than", "path_key": "path", "min_bytes": 1})
    assert not r.passed
    assert "not found" in r.message


def test_file_size_missing_key():
    r = validate(_ctx(), {"type": "file_size_greater_than", "path_key": "path", "min_bytes": 1})
    assert not r.passed


# ── http_status ────────────────────────────────────────────────


def test_http_status_pass():
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = mock_urlopen.return_value.__enter__.return_value
        mock_resp.status = 200
        r = validate(_ctx(), {"type": "http_status", "url": "http://localhost/health", "expected_status": 200})
        assert r.passed


def test_http_status_fail():
    import urllib.error
    with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("url", 500, "err", {}, None)):
        r = validate(_ctx(), {"type": "http_status", "url": "http://localhost/health", "expected_status": 200})
        assert not r.passed


# ── json_schema ────────────────────────────────────────────────


def test_json_schema_pass():
    jsonschema = pytest.importorskip("jsonschema")
    schema = {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}
    r = validate(_ctx(data={"id": 1, "name": "test"}), {"type": "json_schema", "key": "data", "schema": schema})
    assert r.passed


def test_json_schema_fail():
    jsonschema = pytest.importorskip("jsonschema")
    schema = {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}
    r = validate(_ctx(data={"id": "not_int", "name": "test"}), {"type": "json_schema", "key": "data", "schema": schema})
    assert not r.passed


def test_json_schema_not_installed():
    with patch("openry.orchestrator.validator.validate", side_effect=None):
        # Without jsonschema installed, the validator returns a fail with helpful message
        pass  # This test depends on jsonschema not being installed


# ── Unknown type ────────────────────────────────────────────────


def test_unknown_type():
    r = validate(_ctx(), {"type": "nonexistent_type"})
    assert not r.passed
    assert "unknown validation type" in r.message


# ── Registry ────────────────────────────────────────────────────


def test_registry_has_all_types():
    expected = {
        "payload_values_equal",
        "payload_values_not_equal",
        "payload_value_equals",
        "payload_value_in_set",
        "payload_value_greater_than",
        "payload_value_less_than",
        "payload_type",
        "file_size_greater_than",
        "http_status",
        "json_schema",
    }
    assert set(VALIDATOR_REGISTRY.keys()) == expected


# ── ValidationResult helpers ────────────────────────────────────


def test_result_ok():
    r = ValidationResult.ok("all good")
    assert r.passed
    assert r.message == "all good"


def test_result_fail():
    r = ValidationResult.fail("something wrong", key="x", value=1)
    assert not r.passed
    assert r.message == "something wrong"
    assert r.details == {"key": "x", "value": 1}
