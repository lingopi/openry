"""Payload routing: merge and pass data between sub_steps."""

from __future__ import annotations

import json
from typing import Any


def load_payload(payload_str: str | None) -> dict[str, Any]:
    """Safely parse a payload JSON string to dict."""
    if not payload_str:
        return {}
    try:
        parsed = json.loads(payload_str)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def dump_payload(payload: dict[str, Any]) -> str:
    """Serialize a payload dict to JSON string."""
    return json.dumps(payload, ensure_ascii=False)


def merge_payload(
    previous_payload: dict[str, Any],
    current_payload: dict[str, Any],
    inherit: bool = False,
) -> dict[str, Any]:
    """Merge payloads according to inherit_payload rules.

    Args:
        previous_payload: Payload from the previous sub_step
        current_payload: Payload submitted by the current agent
        inherit: If True, merge previous + current. If False, use current only.

    Returns:
        Merged payload dict
    """
    if inherit:
        merged = dict(previous_payload)
        merged.update(current_payload)
        return merged
    return dict(current_payload)


def extract_payload_for_next_step(
    current_payload: dict[str, Any],
    next_step_config: dict[str, Any],
    previous_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Prepare the payload that will be passed to the next sub_step.

    This combines the inherit_payload logic with the current step's output.
    """
    inherit = next_step_config.get("inherit_payload", False)
    base = previous_payload if inherit and previous_payload else {}
    return merge_payload(base, current_payload, inherit=False)
