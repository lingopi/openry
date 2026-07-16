"""Hard-code validation engine for sub_step results."""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any

from openry.db import (
    get_conn,
    get_task_state,
    insert_validation_result,
)


def validate_step(run_id: str, step_config: dict[str, Any]) -> tuple[bool, str]:
    """Run all validation rules against a completed sub_step.

    Args:
        run_id: The run to validate
        step_config: The sub_step YAML config (including validation rules)

    Returns:
        (passed, failure_reason) — failure_reason is "" on success
    """
    state = get_task_state(run_id)
    if not state:
        return False, f"run_id not found: {run_id}"

    try:
        payload = json.loads(state.get("payload", "{}"))
    except (json.JSONDecodeError, TypeError):
        payload = {}

    # 1. expect_payload check
    if step_config.get("expect_payload") and not payload:
        _log_validation(run_id, "expect_payload", None, False, "no payload provided")
        return False, "expect_payload=True but no payload provided"

    # 2. payload_keys check (implicit validation)
    for key in step_config.get("payload_keys", []):
        if key not in payload:
            _log_validation(run_id, "payload_has_key", key, False, f"missing key: {key}")
            return False, f"missing required payload key: {key}"

    # 3. Explicit validation rules
    for rule in step_config.get("validation", []):
        rule_type = rule.get("type", "")
        rule_params = json.dumps({k: v for k, v in rule.items() if k != "type"})
        passed = True
        reason = ""

        if rule_type == "payload_has_key":
            passed = rule["key"] in payload
            reason = "" if passed else f"missing key: {rule['key']}"

        elif rule_type == "payload_value_matches":
            value = str(payload.get(rule["key"], ""))
            passed = bool(re.match(rule["regex"], value))
            reason = "" if passed else f"value mismatch: {rule['key']}={value}"

        elif rule_type == "payload_values_equal":
            passed = payload.get(rule["key_a"]) == payload.get(rule["key_b"])
            reason = "" if passed else f"values not equal: {rule['key_a']} != {rule['key_b']}"

        elif rule_type == "file_exists":
            path = rule["path"]
            passed = os.path.exists(path)
            reason = "" if passed else f"file not found: {path}"

        elif rule_type == "file_contains":
            path = rule["path"]
            if not os.path.exists(path):
                passed = False
                reason = f"file not found: {path}"
            else:
                with open(path) as f:
                    passed = rule["contains"] in f.read()
                reason = "" if passed else f"missing content: {rule['contains']}"

        elif rule_type == "command":
            result = subprocess.run(
                rule["run"], shell=True, capture_output=True, text=True, timeout=60,
            )
            passed = result.returncode == 0
            reason = f"exit_code={result.returncode}" if not passed else ""

        elif rule_type == "command_output_contains":
            result = subprocess.run(
                rule["run"], shell=True, capture_output=True, text=True, timeout=60,
            )
            passed = rule["contains"] in result.stdout
            reason = "" if passed else f"output missing: {rule['contains']}"

        elif rule_type == "db_query":
            conn = get_conn()
            row = conn.execute(rule["query"]).fetchone()
            conn.close()
            passed = row is not None
            reason = "" if passed else "query returned no rows"

        else:
            passed = False
            reason = f"unknown rule type: {rule_type}"

        _log_validation(run_id, rule_type, rule_params, passed, reason)
        if not passed:
            return False, reason

    return True, ""


def _log_validation(
    run_id: str,
    rule_type: str,
    rule_params: str | None,
    passed: bool,
    message: str,
) -> None:
    """Log a single validation result to DB."""
    try:
        insert_validation_result(run_id, rule_type, rule_params, passed, message)
    except Exception:
        pass  # Validation logging is best-effort
