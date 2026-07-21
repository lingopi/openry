"""Phase 3a: Conditional routing engine with when / when_any short-circuit evaluation.

Evaluates validation_routing entries from a sub_step YAML config, determines
the routing target based on short-circuit AND/OR logic.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from openry.db import get_task_state

from .validator import ValidationContext, ValidationResult, validate


# ── Data structures ────────────────────────────────────────────


@dataclass
class RoutingResult:
    """Result of evaluating the entire validation_routing block.

    Attributes:
        action: What to do next.
            - "route": Proceed to the specified target.
            - "fallthrough": No routing decision made (delegate to Phase 2).
        target: Routing target if action is "route".
            - "done": Big step complete (success).
            - "abort": Big step failed.
            - "retry_current": Retry current sub_step.
            - "continue": Internal signal to proceed to next entry.
            - Any sub_step_id string.
        message: Human-readable description of the routing decision.
    """

    action: str  # "route" | "fallthrough"
    target: str = ""
    message: str = ""

    @classmethod
    def route_to(cls, target: str, message: str = "") -> RoutingResult:
        return cls(action="route", target=target, message=message)

    @classmethod
    def fallthrough(cls, message: str = "") -> RoutingResult:
        return cls(action="fallthrough", message=message)


# ── Valid routing targets ──────────────────────────────────────

VALID_TARGETS = frozenset({"done", "abort", "retry_current", "continue"})


def _is_valid_target(target: str) -> bool:
    """Check if a routing target is one of the well-known keywords or a sub_step ID."""
    if target in VALID_TARGETS:
        return True
    # Non-keyword targets are assumed to be sub_step IDs
    return bool(target and target not in ("",))


# ── Main entry point ───────────────────────────────────────────


def evaluate_routing(run_id: str, step_config: dict[str, Any]) -> RoutingResult:
    """Evaluate all validation_routing entries with short-circuit logic.

    Processing order:
      1. For each entry (when or when_any), evaluate conditions.
      2. If ANY entry fails (on_mismatch), route immediately (short-circuit).
      3. If ALL entries pass, use the global on_success.

    Validation errors (exceptions during evaluation) cause the entry
    to be skipped; if all entries error out, fall through to Phase 2.

    Args:
        run_id: The task run_id being validated.
        step_config: The sub_step YAML configuration dict.

    Returns:
        RoutingResult with action and target.
    """
    ctx = _build_context(run_id)

    entries = step_config.get("validation_routing", [])
    if not entries:
        return RoutingResult.fallthrough("no validation_routing entries")

    error_count = 0

    for idx, entry in enumerate(entries):
        has_when = "when" in entry
        has_when_any = "when_any" in entry

        if not has_when and not has_when_any:
            error_count += 1
            continue

        if has_when_any:
            result = _evaluate_when_any(ctx, entry)
        else:
            result = _evaluate_when(ctx, entry)

        if result.action == "error":
            error_count += 1
            continue

        if result.action == "route":
            if result.target == "continue":
                continue
            return result

        return result

    if error_count == len(entries):
        return RoutingResult.fallthrough("all validation_routing entries errored")

    on_success = step_config.get("on_success", "done")
    return RoutingResult.route_to(on_success, "all validation_routing entries passed")


# ── Entry evaluators ───────────────────────────────────────────


def _evaluate_when(
    ctx: ValidationContext, entry: dict[str, Any],
) -> RoutingResult:
    """Evaluate a single 'when' entry (one condition)."""
    condition = entry["when"]
    result = validate(ctx, condition)

    if result.passed:
        on_match = entry.get("on_match", "continue")
        if on_match == "continue":
            return RoutingResult.route_to("continue", "condition passed, continue")
        if _is_valid_target(on_match):
            return RoutingResult.route_to(on_match, result.message or "condition passed")
        return RoutingResult.fallthrough(f"unknown on_match target: {on_match}")
    else:
        on_mismatch = entry.get("on_mismatch", "abort")
        msg = entry.get("on_mismatch_message", result.message)
        if _is_valid_target(on_mismatch):
            return RoutingResult.route_to(on_mismatch, msg)
        return RoutingResult.fallthrough(f"unknown on_mismatch target: {on_mismatch}")


def _evaluate_when_any(
    ctx: ValidationContext, entry: dict[str, Any],
) -> RoutingResult:
    """Evaluate a 'when_any' entry (OR group: any sub-condition passes → pass)."""
    conditions = entry.get("when_any", [])
    if not conditions:
        # Empty when_any → treated as failed
        on_mismatch = entry.get("on_mismatch", "abort")
        msg = entry.get("on_mismatch_message", "empty when_any group")
        if _is_valid_target(on_mismatch):
            return RoutingResult.route_to(on_mismatch, msg)
        return RoutingResult.fallthrough(f"unknown on_mismatch target: {on_mismatch}")

    errors: list[str] = []
    any_passed = False

    for condition in conditions:
        try:
            result = validate(ctx, condition)
        except Exception as exc:
            errors.append(str(exc))
            continue

        if result.passed:
            any_passed = True
            break  # OR: first pass wins
        else:
            errors.append(result.message)

    if any_passed:
        on_match = entry.get("on_match", "continue")
        if on_match == "continue":
            return RoutingResult.route_to("continue", "when_any: condition passed")
        if _is_valid_target(on_match):
            return RoutingResult.route_to(on_match, "when_any: condition passed")
        return RoutingResult.fallthrough(f"unknown on_match target: {on_match}")
    else:
        on_mismatch = entry.get("on_mismatch", "abort")
        msg = entry.get(
            "on_mismatch_message",
            f"when_any: no conditions matched ({'; '.join(errors)})",
        )
        if _is_valid_target(on_mismatch):
            return RoutingResult.route_to(on_mismatch, msg)
        return RoutingResult.fallthrough(f"unknown on_mismatch target: {on_mismatch}")


# ── Helpers ────────────────────────────────────────────────────


def _build_context(run_id: str) -> ValidationContext:
    """Build a ValidationContext from a run_id by reading DB state."""
    state = get_task_state(run_id)
    if not state:
        return ValidationContext(run_id=run_id, payload={})

    try:
        payload = json.loads(state.get("payload", "{}"))
    except (json.JSONDecodeError, TypeError):
        payload = {}

    return ValidationContext(
        run_id=run_id,
        payload=payload,
        step_config={},  # step_config passed separately at call site
    )
