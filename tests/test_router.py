"""Phase 3a: Unit tests for router.py — when / when_any evaluation."""

from __future__ import annotations

import json

import pytest

from openry.orchestrator.validator import ValidationContext
from openry.orchestrator.router import (
    RoutingResult,
    _evaluate_when,
    _evaluate_when_any,
    _is_valid_target,
    evaluate_routing,
)


# ── Helpers ────────────────────────────────────────────────────


def _ctx(**payload):
    return ValidationContext(run_id="test-run", payload=dict(payload))


# ── _is_valid_target ────────────────────────────────────────────


def test_valid_target_keywords():
    assert _is_valid_target("done")
    assert _is_valid_target("abort")
    assert _is_valid_target("retry_current")
    assert _is_valid_target("continue")


def test_valid_target_sub_step_id():
    assert _is_valid_target("fix_thread_id")
    assert _is_valid_target("human_review")
    assert _is_valid_target("sub_step_3")


def test_invalid_target():
    assert not _is_valid_target("")
    # None should also be invalid
    assert not _is_valid_target("")  # empty string


# ── _evaluate_when: pass case ──────────────────────────────────


def test_when_pass_continue():
    """when passes → on_match: continue."""
    ctx = _ctx(status="active")
    entry = {
        "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
        "on_match": "continue",
        "on_mismatch": "abort",
    }
    result = _evaluate_when(ctx, entry)
    assert result.action == "route"
    assert result.target == "continue"


def test_when_pass_done():
    """when passes → on_match: done."""
    ctx = _ctx(status="active")
    entry = {
        "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
        "on_match": "done",
        "on_mismatch": "abort",
    }
    result = _evaluate_when(ctx, entry)
    assert result.action == "route"
    assert result.target == "done"


def test_when_pass_sub_step():
    """when passes → on_match: custom sub_step."""
    ctx = _ctx(status="active")
    entry = {
        "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
        "on_match": "auto_publish",
        "on_mismatch": "abort",
    }
    result = _evaluate_when(ctx, entry)
    assert result.action == "route"
    assert result.target == "auto_publish"


# ── _evaluate_when: fail case ──────────────────────────────────


def test_when_fail_with_message():
    """when fails → on_mismatch + message."""
    ctx = _ctx(status="inactive")
    entry = {
        "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
        "on_match": "done",
        "on_mismatch": "fix_status",
        "on_mismatch_message": "Status is not active",
    }
    result = _evaluate_when(ctx, entry)
    assert result.action == "route"
    assert result.target == "fix_status"
    assert "Status is not active" in result.message


def test_when_fail_default_message():
    """when fails without explicit message → uses validation message."""
    ctx = _ctx(status="inactive")
    entry = {
        "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
        "on_match": "done",
        "on_mismatch": "abort",
    }
    result = _evaluate_when(ctx, entry)
    assert result.action == "route"
    assert result.target == "abort"
    assert "value mismatch" in result.message


# ── _evaluate_when_any: OR group ───────────────────────────────


def test_when_any_first_passes():
    """when_any: first sub-condition passes → group passes."""
    ctx = _ctx(role="admin")
    entry = {
        "when_any": [
            {"type": "payload_value_equals", "key": "role", "value": "admin"},
            {"type": "payload_value_equals", "key": "role", "value": "editor"},
        ],
        "on_match": "done",
        "on_mismatch": "abort",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "done"


def test_when_any_second_passes():
    """when_any: first fails, second passes → group passes."""
    ctx = _ctx(role="editor")
    entry = {
        "when_any": [
            {"type": "payload_value_equals", "key": "role", "value": "admin"},
            {"type": "payload_value_equals", "key": "role", "value": "editor"},
        ],
        "on_match": "done",
        "on_mismatch": "abort",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "done"


def test_when_any_all_fail():
    """when_any: all sub-conditions fail → group fails."""
    ctx = _ctx(role="viewer")
    entry = {
        "when_any": [
            {"type": "payload_value_equals", "key": "role", "value": "admin"},
            {"type": "payload_value_equals", "key": "role", "value": "editor"},
        ],
        "on_match": "done",
        "on_mismatch": "escalate",
        "on_mismatch_message": "Access denied",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "escalate"
    assert "Access denied" in result.message


def test_when_any_cross_key_or():
    """when_any: OR across different keys (is_admin OR role in set)."""
    ctx = _ctx(is_admin=False, role="editor")
    entry = {
        "when_any": [
            {"type": "payload_value_equals", "key": "is_admin", "value": True},
            {"type": "payload_value_in_set", "key": "role", "values": ["editor", "reviewer"], "mode": "allow"},
        ],
        "on_match": "done",
        "on_mismatch": "abort",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "done"


def test_when_any_empty():
    """when_any with empty list → treated as failed."""
    ctx = _ctx(x=1)
    entry = {
        "when_any": [],
        "on_match": "done",
        "on_mismatch": "abort",
        "on_mismatch_message": "empty group",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "abort"


# ── _evaluate_when_any: on_match: continue ─────────────────────


def test_when_any_pass_continue():
    """when_any passes with on_match: continue."""
    ctx = _ctx(role="admin")
    entry = {
        "when_any": [
            {"type": "payload_value_equals", "key": "role", "value": "admin"},
        ],
        "on_match": "continue",
        "on_mismatch": "abort",
    }
    result = _evaluate_when_any(ctx, entry)
    assert result.action == "route"
    assert result.target == "continue"


# ── RoutingResult ───────────────────────────────────────────────


def test_routing_result_route_to():
    r = RoutingResult.route_to("done", "all good")
    assert r.action == "route"
    assert r.target == "done"
    assert r.message == "all good"


def test_routing_result_fallthrough():
    r = RoutingResult.fallthrough("no routing")
    assert r.action == "fallthrough"
    assert r.target == ""
    assert r.message == "no routing"
