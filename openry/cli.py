"""CLI entry point for openry — Phase 1 command forwarder + Phase 2 action hooks."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

# ── Phase 2: in-process cache for cancel_requested ──
_cancel_cache: dict[str, bool] = {}


def _read_env_meta() -> tuple[str | None, str | None, str | None, str | None, str | None]:
    """Read workflow metadata from environment variables (injected by Orchestrator).

    Returns (run_id, workflow, step_id, session_key, agent_id).
    """
    return (
        os.environ.get("OPENRY_RUN_ID"),
        os.environ.get("OPENRY_WORKFLOW"),
        os.environ.get("OPENRY_STEP_ID"),
        os.environ.get("OPENRY_SESSION_KEY"),
        os.environ.get("OPENRY_AGENT_ID"),
    )


def _parse_env_flags(args: list[str]) -> dict[str, str]:
    """Parse repeated -e KEY=VAL flags into a dict."""
    env_dict: dict[str, str] = {}
    if not args:
        return env_dict
    for item in args:
        if "=" not in item:
            print(json.dumps({"error": f"Invalid env format: '{item}', expected KEY=VAL"}))
            sys.exit(1)
        key, _, val = item.partition("=")
        env_dict[key] = val
    return env_dict


# ──────────────────────────────────────────────
#  Phase 2: action-level hooks (injected into
#  cmd_execute without modifying Phase 1 core)
# ──────────────────────────────────────────────

def _check_cancel(run_id: str) -> str | None:
    """Check if Orchestrator requested cancel (soft-brake).
    Returns a cancel message string if cancelled, None otherwise.
    """
    if not run_id:
        return None
    # Use in-process cache to avoid DB query on every call
    if run_id in _cancel_cache and _cancel_cache[run_id]:
        return "[OPENRY] ⛔ CANCEL REQUESTED: The orchestrator has cancelled this task. Please call: openry --status cancelled"
    from .db import get_cancel_requested
    cancelled = get_cancel_requested(run_id)
    _cancel_cache[run_id] = cancelled
    if cancelled:
        return "[OPENRY] ⛔ CANCEL REQUESTED: The orchestrator has cancelled this task. Please finish your current thought and call: openry --status cancelled"
    return None


def _check_command_policy(run_id: str, command: str) -> str | None:
    """Check command against allowlist/blocklist policy.
    Returns an error message if blocked, None if allowed.
    """
    if not run_id:
        return None
    from .db import get_task_state
    state = get_task_state(run_id)
    if not state:
        return None
    policy_json = state.get("command_policy_json")
    if not policy_json:
        return None  # No policy = unrestricted
    try:
        policy = json.loads(policy_json)
    except (json.JSONDecodeError, TypeError):
        return None

    mode = policy.get("mode", "unrestricted")
    if mode == "unrestricted":
        return None

    cmd_name = command.strip().split()[0] if command.strip() else ""
    commands_list = policy.get("commands", [])

    if mode == "blocklist" and cmd_name in commands_list:
        return f"Command '{cmd_name}' is blocked by sub_step policy"
    if mode == "allowlist" and cmd_name not in commands_list:
        return f"Command '{cmd_name}' is not in the allowed list: {commands_list}"

    return None


def _check_max_tool_calls(run_id: str) -> str | None:
    """Check if agent has exceeded max_tool_calls for this sub_step.
    Returns an error message if limit exceeded, None otherwise.
    """
    if not run_id:
        return None
    from .db import count_tool_calls, get_task_state
    state = get_task_state(run_id)
    if not state:
        return None
    max_calls = state.get("max_tool_calls", 0)
    if not max_calls:
        return None  # No limit set
    current = count_tool_calls(run_id)
    if current >= max_calls:
        return f"[OPENRY] ⛔ MAX TOOL CALLS EXCEEDED: {current}/{max_calls}. Please call: openry --status failed"
    return None


# ── Guard: agent can only act when status == 'in_progress' ──
_STOP_MESSAGE = (
    "⛔ STOP: 当前任务已不在执行阶段（状态: '{status}'）。"
    "请立即停止发言，等待编排器下一步指示。"
)


def _check_in_progress(run_id: str) -> str | None:
    """Check if task is still in_progress (the only state where agent can act).

    Returns a STOP message if status != 'in_progress', None otherwise.
    """
    if not run_id:
        return None
    from .db import get_task_state
    state = get_task_state(run_id)
    if not state:
        return None
    current = state.get("status", "")
    if current != "in_progress":
        return _STOP_MESSAGE.format(status=current)
    return None


def _check_output_overflow(run_id: str, stdout: str) -> tuple[str, bool]:
    """Check if command output exceeds max_output_tokens threshold.
    Returns (possibly_modified_stdout, overflow_occurred).
    """
    if not run_id or not stdout:
        return stdout, False
    from .db import get_task_state
    state = get_task_state(run_id)
    if not state:
        return stdout, False
    max_tokens = state.get("max_output_tokens", 0)
    if not max_tokens:
        return stdout, False

    # Rough token estimate: ~4 chars per token for English text
    estimated_tokens = len(stdout) // 4
    if estimated_tokens <= max_tokens:
        return stdout, False

    # Overflow: inject notification (same pattern as soft-brake)
    overflow_msg = (
        f"\n\n[OPENRY] ⚠ OUTPUT OVERFLOW: ~{estimated_tokens} tokens exceed {max_tokens} limit.\n"
        f"Raw output saved. Please call: openry --status overflow\n"
    )
    return stdout[:max_tokens * 4] + overflow_msg, True


# ──────────────────────────────────────────────
#  Phase 3: session termination via openclaw
# ──────────────────────────────────────────────


def _terminate_session(session_key: str) -> None:
    """Best-effort terminate the agent session via openclaw gateway call.

    Blocks up to 8s waiting for termination to complete before returning.
    Failures are non-fatal — the patrol loop will eventually SIGTERM/SIGKILL.
    """
    if not session_key:
        return
    try:
        import subprocess as _subprocess
        params = json.dumps({"sessionKey": session_key})
        proc = _subprocess.Popen(
            ["openclaw", "gateway", "call", "chat.abort",
             "--params", params,
             "--timeout", "5000"],
            stdout=_subprocess.DEVNULL,
            stderr=_subprocess.DEVNULL,
        )
        try:
            proc.communicate(timeout=8)
        except _subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        pass


# ──────────────────────────────────────────────
#  Phase 3: sync validation (runs in CLI, not patrol loop)
# ──────────────────────────────────────────────


def _validate_payload(run_id: str, payload: dict, step_config: dict) -> tuple[bool, str]:
    """Run validation rules synchronously on --status completed.

    Checks: expect_payload → payload_keys → explicit validation rules.
    Returns (passed, failure_reason).
    """
    # 1. expect_payload check
    if step_config.get("expect_payload") and not payload:
        return False, "expect_payload=True but no payload provided"

    # 2. payload_keys check (hard validation)
    for key in step_config.get("payload_keys", []):
        if key not in payload:
            return False, f"缺少必填字段: '{key}'。请在 payload 中提供此字段后重新 --status completed"

    # 3. Explicit validation rules (Phase 2: 8 types)
    import re as _re
    import os as _os
    for rule in step_config.get("validation", []):
        rule_type = rule.get("type", "")

        if rule_type == "payload_has_key":
            if rule["key"] not in payload:
                return False, f"缺少字段: '{rule['key']}'"

        elif rule_type == "payload_value_matches":
            value = str(payload.get(rule["key"], ""))
            if not _re.match(rule["regex"], value):
                return False, f"字段 '{rule['key']}' 的值 '{value}' 不匹配模式 '{rule['regex']}'"

        elif rule_type == "payload_values_equal":
            if payload.get(rule["key_a"]) != payload.get(rule["key_b"]):
                return False, f"字段 '{rule['key_a']}' 与 '{rule['key_b']}' 不相等"

        elif rule_type == "file_exists":
            if not _os.path.exists(rule["path"]):
                return False, f"文件不存在: {rule['path']}"

        elif rule_type == "file_contains":
            path = rule["path"]
            if not _os.path.exists(path):
                return False, f"文件不存在: {path}"
            with open(path, encoding="utf-8") as f:
                if rule["contains"] not in f.read():
                    return False, f"文件内容不包含: {rule['contains']}"

        elif rule_type == "command":
            import subprocess as _sp
            result = _sp.run(rule["run"], shell=True, capture_output=True)
            if result.returncode != 0:
                return False, f"验证命令失败: {rule['run']}"

        elif rule_type == "command_output_contains":
            import subprocess as _sp
            result = _sp.run(rule["run"], shell=True, capture_output=True, text=True)
            if rule["contains"] not in result.stdout:
                return False, f"命令输出不包含: {rule['contains']}"

        elif rule_type == "db_query":
            from .db import _get_conn
            conn = _get_conn()
            row = conn.execute(rule["query"]).fetchone()
            conn.close()
            if row is None:
                return False, f"数据库查询无结果: {rule['query']}"

        else:
            # Phase 3a: delegate to unified validator for new types
            # (payload_values_not_equal, payload_value_equals, payload_value_in_set,
            #  payload_value_greater_than, payload_value_less_than, payload_type,
            #  file_size_greater_than, http_status, json_schema)
            from .orchestrator.validator import validate, ValidationContext
            ctx = ValidationContext(run_id=run_id, payload=payload)
            result = validate(ctx, rule)
            if not result.passed:
                return False, result.message or f"验证失败: {rule_type}"

    return True, ""


# ──────────────────────────────────────────────
#  Phase 3a: sync conditional routing (runs in CLI)
# ──────────────────────────────────────────────


def _evaluate_routing_sync(run_id: str, payload: dict, step_config: dict) -> dict:
    """Evaluate validation_routing entries synchronously in CLI.

    Returns a dict with:
      - action: "route" | "fallthrough"
      - target: "done" | "abort" | "retry_current" | "continue" | sub_step_id
      - message: human-readable description
    """
    from .orchestrator.validator import validate, ValidationContext

    entries = step_config.get("validation_routing", [])
    if not entries:
        return {"action": "fallthrough", "target": "", "message": "no validation_routing"}

    ctx = ValidationContext(run_id=run_id, payload=payload)
    error_count = 0

    for entry in entries:
        # when_any: OR group
        if "when_any" in entry:
            any_passed = False
            for condition in entry["when_any"]:
                result = validate(ctx, condition)
                if result.passed:
                    any_passed = True
                    break
            if any_passed:
                target = entry.get("on_match", "continue")
                if target == "continue":
                    continue  # go to next entry
                return {"action": "route", "target": target, "message": "when_any matched"}
            else:
                target = entry.get("on_mismatch", "abort")
                msg = entry.get("on_mismatch_message", "when_any: no condition matched")
                return {"action": "route", "target": target, "message": msg}

        # when: single condition
        elif "when" in entry:
            condition = entry["when"]
            result = validate(ctx, condition)
            if result.passed:
                target = entry.get("on_match", "continue")
                if target == "continue":
                    continue
                return {"action": "route", "target": target, "message": result.message or "condition passed"}
            else:
                target = entry.get("on_mismatch", "abort")
                msg = entry.get("on_mismatch_message", result.message or "condition failed")
                return {"action": "route", "target": target, "message": msg}

        else:
            error_count += 1
            continue

    if error_count == len(entries):
        return {"action": "fallthrough", "target": "", "message": "all entries errored"}

    # All entries passed
    on_success = step_config.get("on_success", "done")
    return {"action": "route", "target": on_success, "message": "all routing entries passed"}


# ──────────────────────────────────────────────
#  Phase 3: sync retry logic for --status failed
# ──────────────────────────────────────────────


def _handle_failed_retry(run_id: str, step_config: dict, retry_count: int, conn) -> dict:
    """Determine the outcome of --status failed synchronously.

    MUST be called within an existing transaction (conn is shared).
    Returns a result dict with 'action'. Caller is responsible for COMMIT.
    """
    on_failure = step_config.get("on_failure", "abort")
    max_retries = step_config.get("max_sub_step_retries", 0) or 0

    if on_failure == "retry" and max_retries > 0 and retry_count + 1 < max_retries:
        new_count = retry_count + 1
        conn.execute(
            """UPDATE task_state
               SET status = 'in_progress',
                   sub_step_retry_count = ?,
                   updated_at = datetime('now')
               WHERE run_id = ?""",
            (new_count, run_id),
        )
        return {
            "status": "failed",
            "action": "retry_same_session",
            "retry": f"{new_count}/{max_retries}",
            "hint": (
                f"当前尝试失败（{new_count}/{max_retries}）。"
                "请尝试不同的方法完成此任务，然后重新 --status completed。"
            ),
            "acknowledged": True,
        }

    # Budget exhausted or on_failure=abort → permanently dropped
    conn.execute(
        """UPDATE task_state
           SET status = 'dropped',
               updated_at = datetime('now')
           WHERE run_id = ?""",
        (run_id,),
    )
    reason = "所有重试次数已用尽" if on_failure == "retry" else "on_failure=abort，任务终止"
    return {
        "status": "failed",
        "action": "dropped",
        "reason": reason,
        "acknowledged": True,
    }


# ──────────────────────────────────────────────
#  Phase 1 core (preserved) + Phase 2/3 hooks
# ──────────────────────────────────────────────


def cmd_execute(args: argparse.Namespace) -> None:
    """Handle the -c / --command path (Phase 1 core + Phase 2 hooks)."""
    from .executor import run_command
    from .db import insert_command, upsert_task_state
    from .utils import utc_now_iso

    command = args.command
    if not command or not command.strip():
        print(json.dumps({"error": "command is required", "exit_code": 1}))
        sys.exit(1)

    run_id, workflow, step_id, session_key, agent_id = _read_env_meta()
    extra_env = _parse_env_flags(args.env or [])

    # ── Phase 3: in_progress guard ──
    if run_id:
        stop_msg = _check_in_progress(run_id)
        if stop_msg:
            print(json.dumps({
                "exit_code": 1,
                "stdout": stop_msg,
                "stderr": "",
                "duration_ms": 0,
                "locked": True,
            }, ensure_ascii=False))
            return

        cancel_msg = _check_cancel(run_id)
        if cancel_msg:
            print(json.dumps({
                "exit_code": 0,
                "stdout": cancel_msg,
                "stderr": "",
                "duration_ms": 0,
            }, ensure_ascii=False))
            return

        policy_block = _check_command_policy(run_id, command)
        if policy_block:
            print(json.dumps({
                "exit_code": 1,
                "stdout": "",
                "stderr": policy_block,
                "duration_ms": 0,
                "blocked": True,
            }, ensure_ascii=False))
            return

        max_calls_msg = _check_max_tool_calls(run_id)
        if max_calls_msg:
            print(json.dumps({
                "exit_code": 1,
                "stdout": max_calls_msg,
                "stderr": "",
                "duration_ms": 0,
            }, ensure_ascii=False))
            return
    # ── end Phase 2 hooks ──

    start = time.perf_counter()
    result = run_command(
        command,
        cwd=args.cwd,
        timeout=args.timeout if args.timeout else 600,
        extra_env=extra_env,
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    result["duration_ms"] = elapsed_ms

    # ── Phase 2: post-execution overflow check ──
    overflow = False
    if run_id:
        result["stdout"], overflow = _check_output_overflow(run_id, result["stdout"])
    # ── end Phase 2 hook ──

    # Write to SQLite (best-effort, don't fail the CLI if DB is unwritable)
    try:
        insert_command(
            run_id=run_id,
            workflow=workflow,
            step_id=step_id,
            command=command,
            shell=result["shell"],
            cwd=result["cwd"],
            exit_code=result["exit_code"],
            stdout=result["stdout"],
            stderr=result["stderr"],
            duration_ms=elapsed_ms,
            timeout=result.get("timeout", False),
        )

        if run_id:
            # Ensure a task_state row exists WITHOUT overwriting status,
            # BUT still refresh updated_at as a heartbeat for zombie detection.
            from .db import _get_conn as _get_conn_exec
            conn_exec = _get_conn_exec()
            conn_exec.execute(
                """INSERT INTO task_state (run_id, workflow, step_id, status, updated_at)
                   VALUES (?, ?, ?, 'in_progress', datetime('now'))
                   ON CONFLICT(run_id) DO UPDATE SET
                       updated_at = datetime('now')""",
                (run_id, workflow, step_id),
            )
            conn_exec.commit()
            conn_exec.close()
    except Exception:
        # DB write failure is non-fatal for command execution
        pass

    # Return to agent: clean JSON, no metadata exposed
    agent_response = {
        "exit_code": result["exit_code"],
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "duration_ms": elapsed_ms,
    }
    if result.get("timeout"):
        agent_response["timeout"] = True
    if overflow:
        agent_response["overflow"] = True

    print(json.dumps(agent_response, ensure_ascii=False))


def cmd_status(args: argparse.Namespace) -> None:
    """Handle the --status path with sync validation/retry and session termination.

    Phase 3 atomic design (2026-07-22 fix):
    - Entire guard + status update + retry/validation runs inside one
      BEGIN IMMEDIATE transaction, preventing parallel calls from racing.
    - Session termination happens AFTER COMMIT (outside the lock).
    """
    from .db import set_output_overflow, _get_conn, generate_payload_schema

    status = args.status
    valid_statuses = ("completed", "failed", "cancelled", "overflow")
    if status not in valid_statuses:
        print(json.dumps({"error": f"status must be one of: {', '.join(valid_statuses)}"}))
        sys.exit(1)

    run_id, workflow, step_id, session_key, agent_id = _read_env_meta()
    if not run_id:
        print(json.dumps({"error": "OPENRY_RUN_ID not set; --status requires an active run"}))
        sys.exit(1)

    # Validate and normalize payload (before transaction — no DB involved)
    payload_str = "{}"
    payload_dict: dict = {}
    if args.payload:
        try:
            parsed = json.loads(args.payload)
            if not isinstance(parsed, dict):
                print(json.dumps({"error": "payload must be a JSON object"}))
                sys.exit(1)
            payload_dict = parsed
            payload_str = json.dumps(parsed, ensure_ascii=False)
        except json.JSONDecodeError:
            print(json.dumps({"error": "payload must be valid JSON"}))
            sys.exit(1)

    # ── BEGIN IMMEDIATE transaction ──
    # This acquires a write lock immediately, serializing all parallel calls.
    # If another cmd_status is already in the critical section, this blocks.
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")

        # ① Read current state WITHIN the transaction (sees committed data)
        row = conn.execute(
            "SELECT status, sub_step_retry_count, big_step_ref, sub_step_id,"
            " max_sub_step_retries, on_validation_fail"
            " FROM task_state WHERE run_id = ?",
            (run_id,),
        ).fetchone()

        if row is None:
            conn.execute("ROLLBACK")
            print(json.dumps({"error": f"run_id not found: {run_id}"}))
            sys.exit(1)

        db_status = row[0]
        db_retry_count = row[1] or 0
        big_step_ref = row[2] or ""
        sub_step_id_db = row[3] or ""
        db_max_sub_retries = row[4] or 0
        db_on_vfail = row[5] or ""

        # ── Guard: only in_progress can transition ──
        if db_status != "in_progress":
            conn.execute("ROLLBACK")
            print(json.dumps({
                "error": _STOP_MESSAGE.format(status=db_status),
                "status": status,
                "acknowledged": False,
                "locked": True,
            }, ensure_ascii=False))
            sys.exit(1)

        # ── Load step config from YAML (outside DB, can fail safely) ──
        step_config: dict = {}
        if big_step_ref and sub_step_id_db:
            try:
                from .orchestrator.yaml_loader import load_big_step, get_sub_step_config
                big_step = load_big_step(big_step_ref)
                ss = get_sub_step_config(big_step, sub_step_id_db)
                if ss:
                    step_config = ss
            except Exception:
                pass

        # ── Handle each status within the same transaction ──

        if status == "completed":
            # Agent 自己总结上报 = 天然语义蒸馏完成
            if "_compressed" not in payload_dict:
                payload_dict["_compressed"] = True
            payload_str = json.dumps(payload_dict, ensure_ascii=False)

            # 自动生成 payload_schema
            payload_schema = generate_payload_schema(payload_dict) if payload_dict else {}
            payload_schema_str = json.dumps(payload_schema, ensure_ascii=False)

            # Write completed + payload + schema
            conn.execute(
                """UPDATE task_state
                   SET workflow = COALESCE(?, workflow),
                       step_id  = COALESCE(?, step_id),
                       status   = 'completed',
                       payload  = ?,
                       payload_schema = ?,
                       updated_at = datetime('now')
                   WHERE run_id = ?""",
                (workflow, step_id, payload_str, payload_schema_str, run_id),
            )

            # Sync validation
            passed, reason = _validate_payload(run_id, payload_dict, step_config)

            if passed:
                # Phase 3a: check validation_routing for conditional routing
                routing = _evaluate_routing_sync(run_id, payload_dict, step_config)
                routing_target = routing.get("target", "")
                routing_action = routing.get("action", "fallthrough")

                if routing_action == "route" and routing_target:
                    if routing_target == "done":
                        conn.execute(
                            "UPDATE task_state SET status = 'validated', validation_status = 'passed',"
                            " updated_at = datetime('now') WHERE run_id = ?",
                            (run_id,),
                        )
                        result = {
                            "status": "completed", "action": "validated",
                            "payload": payload_dict, "acknowledged": True,
                            "message": f"✅ 验证通过 → 路由: {routing_target}。",
                        }
                    elif routing_target == "abort":
                        conn.execute(
                            "UPDATE task_state SET status = 'dropped', validation_status = 'failed',"
                            " updated_at = datetime('now') WHERE run_id = ?",
                            (run_id,),
                        )
                        result = {
                            "status": "completed", "action": "dropped",
                            "reason": f"条件路由: {routing.get('message', 'abort')}",
                            "acknowledged": True,
                            "message": f"❌ 条件路由: {routing.get('message', '')}",
                        }
                    elif routing_target == "retry_current":
                        new_count = db_retry_count + 1
                        max_retries = step_config.get("max_sub_step_retries", db_max_sub_retries or 3)
                        if new_count < max_retries:
                            conn.execute(
                                "UPDATE task_state SET status = 'in_progress',"
                                " sub_step_retry_count = ?, validation_status = 'failed',"
                                " updated_at = datetime('now') WHERE run_id = ?",
                                (new_count, run_id),
                            )
                            result = {
                                "status": "completed", "action": "routing_retry",
                                "retry": f"{new_count}/{max_retries}",
                                "reason": routing.get("message", ""),
                                "hint": f"条件路由要求重试（{new_count}/{max_retries}）：{routing.get('message', '')}。请修正后重新 --status completed。",
                                "acknowledged": True,
                            }
                        else:
                            conn.execute(
                                "UPDATE task_state SET status = 'dropped', validation_status = 'failed',"
                                " updated_at = datetime('now') WHERE run_id = ?",
                                (run_id,),
                            )
                            result = {
                                "status": "completed", "action": "dropped",
                                "reason": f"条件路由重试耗尽（{routing.get('message', '')}）",
                                "acknowledged": True,
                                "message": "❌ 条件路由重试已耗尽。",
                            }
                    else:
                        # sub_step_id target — set validated + routing_target for patrol
                        conn.execute(
                            "UPDATE task_state SET status = 'validated', validation_status = 'passed',"
                            " routing_target = ?, updated_at = datetime('now') WHERE run_id = ?",
                            (routing_target, run_id),
                        )
                        result = {
                            "status": "completed", "action": "validated",
                            "routing_target": routing_target,
                            "payload": payload_dict, "acknowledged": True,
                            "message": f"✅ 验证通过 → 路由到: {routing_target}。",
                        }
                else:
                    # No routing or fallthrough — standard validated
                    conn.execute(
                        "UPDATE task_state SET status = 'validated', validation_status = 'passed',"
                        " updated_at = datetime('now') WHERE run_id = ?",
                        (run_id,),
                    )
                    result = {
                        "status": "completed", "action": "validated",
                        "payload": payload_dict, "acknowledged": True,
                        "message": "✅ 验证通过，步骤完成。会话已终止。",
                    }
            else:
                on_vfail = step_config.get("on_validation_fail", db_on_vfail or "retry_current")
                max_retries = step_config.get("max_sub_step_retries", db_max_sub_retries or 3)

                if on_vfail == "retry_current" and db_retry_count + 1 < max_retries:
                    new_count = db_retry_count + 1
                    conn.execute(
                        """UPDATE task_state
                           SET status = 'in_progress',
                               sub_step_retry_count = ?,
                               validation_status = 'failed',
                               updated_at = datetime('now')
                           WHERE run_id = ?""",
                        (new_count, run_id),
                    )
                    result = {
                        "status": "completed",
                        "action": "validation_failed_retry",
                        "retry": f"{new_count}/{max_retries}",
                        "reason": reason,
                        "hint": f"验证未通过（{new_count}/{max_retries}）：{reason}。请修正后重新 --status completed。",
                        "acknowledged": True,
                    }
                else:
                    conn.execute(
                        """UPDATE task_state
                           SET status = 'dropped',
                               validation_status = 'failed',
                               updated_at = datetime('now')
                           WHERE run_id = ?""",
                        (run_id,),
                    )
                    result = {
                        "status": "completed",
                        "action": "dropped",
                        "reason": f"验证失败且重试耗尽（{reason}）" if on_vfail == "retry_current"
                                  else f"验证失败，on_validation_fail=abort（{reason}）",
                        "acknowledged": True,
                        "message": "❌ 验证失败，步骤已终止。会话已终结。",
                    }

        elif status == "failed":
            # Write failed
            conn.execute(
                """UPDATE task_state
                   SET workflow = COALESCE(?, workflow),
                       step_id  = COALESCE(?, step_id),
                       status   = 'failed',
                       payload  = ?,
                       updated_at = datetime('now')
                   WHERE run_id = ?""",
                (workflow, step_id, payload_str, run_id),
            )

            result = _handle_failed_retry(run_id, step_config, db_retry_count, conn)

        elif status == "cancelled":
            conn.execute(
                """UPDATE task_state
                   SET workflow = COALESCE(?, workflow),
                       step_id  = COALESCE(?, step_id),
                       status   = 'cancelled',
                       updated_at = datetime('now')
                   WHERE run_id = ?""",
                (workflow, step_id, run_id),
            )
            result = {
                "status": "cancelled",
                "action": "cancelled",
                "acknowledged": True,
                "message": "任务已取消。会话已终止，编排器将进行清理。",
            }

        elif status == "overflow":
            conn.execute(
                """UPDATE task_state
                   SET output_overflow = 1,
                       status = 'overflow',
                       updated_at = datetime('now')
                   WHERE run_id = ?""",
                (run_id,),
            )
            result = {
                "status": "overflow",
                "action": "overflow",
                "acknowledged": True,
                "message": "输出溢出已确认。会话已终止，编排器将触发 overflow workflow。",
            }

        else:
            conn.execute("ROLLBACK")
            result = {"status": status, "acknowledged": False, "error": "unknown status"}

        conn.commit()

    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # ── Session termination OUTSIDE the transaction ──
    action = result.get("action", "")
    if action in ("validated", "dropped", "cancelled", "overflow"):
        _terminate_session(session_key or "")

    print(json.dumps(result, ensure_ascii=False))


def _run_cmd(cmd: list[str], **kwargs) -> bool:
    """Run a command, returning True on success. Never raises."""
    try:
        if sys.platform == "win32" and cmd[0] in ("openclaw",):
            # On Windows, Node.js global tools may need .cmd extension
            import shutil as _shutil
            resolved = _shutil.which(cmd[0])
            if resolved:
                cmd = [resolved] + cmd[1:]
        subprocess.run(cmd, capture_output=True, timeout=kwargs.pop("timeout", 15), **kwargs)
        return True
    except FileNotFoundError:
        print(f"  ⚠ Command not found: {cmd[0]} (skip)")
        return False
    except Exception as e:
        print(f"  ⚠ Failed: {e}")
        return False


def _kill_openry_processes() -> None:
    """Kill openry processes that may hold DB lock."""
    try:
        if sys.platform == "win32":
            # Only kill python.exe processes whose command line mentions openry.
            # Write a temp .ps1 to avoid shell-quoting nightmares.
            import tempfile as _tf, os as _os
            _script = (
                '$procs = Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" |'
                ' Where-Object { $_.CommandLine -match \'openry\' };'
                ' foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }'
            )
            _fd, _path = _tf.mkstemp(suffix=".ps1", prefix="openry-kill-")
            try:
                _os.write(_fd, _script.encode("utf-8"))
                _os.close(_fd)
                subprocess.run(
                    ["powershell", "-NoProfile", "-File", _path],
                    capture_output=True, timeout=15)
            finally:
                try:
                    _os.unlink(_path)
                except OSError:
                    pass
        else:
            subprocess.run(["pkill", "-f", "openry"],
                           capture_output=True, timeout=5)
    except Exception:
        pass


def _clean_shell_config(home: Path) -> None:
    """Remove OpenRY entries from shell config."""
    if sys.platform == "win32":
        # Windows: delete OPENRY_HOME user environment variable (not set to empty)
        try:
            import subprocess as _sp
            _sp.run(
                ["powershell", "-NoProfile", "-Command",
                 "[Environment]::SetEnvironmentVariable('OPENRY_HOME', $null, 'User')"],
                capture_output=True, timeout=10)
            print("  ✓ OPENRY_HOME env var deleted")
        except Exception as e:
            print(f"  ⚠ Could not delete OPENRY_HOME: {e}")
        return

    # Unix: clean .zshrc / .bashrc / .profile
    shell_rc = _detect_shell_rc()
    if not shell_rc.exists():
        return
    try:
        lines = shell_rc.read_text(encoding="utf-8").splitlines(keepends=True)
        filtered = []
        skip = 0
        for line in lines:
            if skip > 0:
                skip -= 1
                continue
            if "# Added by OpenRY installer" in line:
                skip = 2
                continue
            if "OPENRY_HOME" in line and "# Added by OpenRY" not in line:
                continue
            filtered.append(line)
        shell_rc.write_text("".join(filtered), encoding="utf-8")
        print(f"  ✓ OpenRY entries removed from {shell_rc}")
    except Exception as e:
        print(f"  ⚠ Could not update {shell_rc}: {e}")


def cmd_uninstall(args: argparse.Namespace) -> None:
    """Uninstall OpenRY: remove data directory, clean shell config.

    openry uninstall                   # Remove ~/.openry, clean shell config
    openry uninstall --with-openclaw   # Also stop gateway, unregister plugin, remove agent

    Note: To also remove the CLI binary, use the shell script:
      bash scripts/uninstall.sh --full --force
    """
    import shutil
    from pathlib import Path

    home = Path.home()
    openry_home = Path(os.environ.get("OPENRY_HOME", home / ".openry"))

    if not args.force:
        scope = "EVERYTHING" if args.with_openclaw else "OpenRY data"
        print(f"This will remove {scope}. Continue? (y/N) ", end="")
        confirm = input().strip().lower()
        if confirm not in ("y", "yes"):
            print("Aborted.")
            return

    # ── 1. Stop gateway (--with-openclaw only) ──
    if args.with_openclaw:
        print("Stopping OpenClaw gateway...")
        if _run_cmd(["openclaw", "gateway", "stop"], timeout=10):
            print("  ✓ Gateway stopped")

    # ── 2. Unregister plugin (--with-openclaw only) ──
    if args.with_openclaw:
        print("Unregistering orchestrator-plugin...")
        if _run_cmd(["openclaw", "plugins", "uninstall", "orchestrator-plugin"],
                    input=b"y\n", timeout=15):
            print("  ✓ Plugin unregistered")

    # ── 3. Remove agent from openclaw.json (--with-openclaw only) ──
    if args.with_openclaw:
        ocl_config = home / ".openclaw" / "openclaw.json"
        if ocl_config.exists():
            try:
                import json as _json
                with open(ocl_config, "r", encoding="utf-8") as f:
                    cfg = _json.load(f)
                agents = cfg.get("agents", {}).get("list", [])
                cfg["agents"]["list"] = [a for a in agents if a.get("id") != "openry-worker"]
                with open(ocl_config, "w", encoding="utf-8") as f:
                    _json.dump(cfg, f, indent=2, ensure_ascii=False)
                print("  ✓ Agent 'openry-worker' removed from openclaw.json")
            except Exception as e:
                print(f"  ⚠ Could not update openclaw.json: {e}")

    # ── 4. Remove ~/.openry data ──
    if not args.keep_data:
        if openry_home.exists():
            _kill_openry_processes()
            import time as _time
            _time.sleep(0.5)

            # Remove DB files first (often locked)
            for db_file in ["openry.db", "openry.db-wal", "openry.db-shm"]:
                fp = openry_home / db_file
                try:
                    fp.unlink(missing_ok=True)
                except Exception:
                    pass

            shutil.rmtree(openry_home, ignore_errors=True)
            print(f"  ✓ Removed {openry_home}")
        else:
            print("  ~/.openry not found, skip")
    else:
        print("  Keeping ~/.openry (--keep-data)")

    # ── 4.5 Clean egg-info (editable install residue) ──
    try:
        import openry as _openry
        _repo_root = Path(_openry.__path__[0]).parent
        _egg_info = _repo_root / "openry.egg-info"
        if _egg_info.exists():
            shutil.rmtree(_egg_info, ignore_errors=True)
            print(f"  ✓ Removed {_egg_info}")
    except Exception:
        pass

    # ── 5. Clean shell config ──
    if not args.keep_env:
        _clean_shell_config(home)
    else:
        print("  Keeping shell config (--keep-env)")

    # ── 6. Plugin artifacts (--with-openclaw only) ──
    # Cleans the orchestrator-plugin directory inside the repo:
    #   - node_modules / dist (build artifacts)
    #   - @xenova/transformers/.cache (BGE-M3 model cache — the real one)
    # Note: ~/.cache/huggingface and ~/.cache/transformers are Python-ecosystem
    # caches that OpenRY does NOT use; they are deliberately NOT cleaned here.
    if args.with_openclaw:
        try:
            import openry as _openry
            _repo_root = Path(_openry.__path__[0]).parent
            _plugin_dir = _repo_root / "orchestrator-plugin"
            if _plugin_dir.exists():
                # Xenova BGE-M3 cache (the path actually used by the plugin)
                _xenova_cache = _plugin_dir / "node_modules" / "@xenova" / "transformers" / ".cache"
                if _xenova_cache.exists():
                    shutil.rmtree(_xenova_cache, ignore_errors=True)
                    print(f"  ✓ Removed Xenova BGE-M3 cache: {_xenova_cache}")

                # Plugin build artifacts
                for _sub in ["node_modules", "dist"]:
                    _p = _plugin_dir / _sub
                    if _p.exists():
                        shutil.rmtree(_p, ignore_errors=True)
                        print(f"  ✓ Removed {_p}")
        except Exception as e:
            print(f"  ⚠ Could not clean plugin directory: {e}")

    # ── 7. Self-uninstall (detached background process) ──
    if args.with_openclaw:
        print()
        print("  Removing openry CLI in background...")
        _spawn_self_uninstall(home)
        print("  Done. The openry command will be gone in a moment.")
    else:
        print()
        print("  OpenRY data removed.")
        print("  For complete cleanup: openry uninstall --with-openclaw --force")
    print()


def _spawn_self_uninstall(home: Path) -> None:
    """Remove wrapper scripts and spawn background pip uninstall.

    Wrapper scripts are removed immediately (they're not the running process).
    pip uninstall is spawned as a detached background process.
    """
    import subprocess as _sp

    # 1. Remove wrapper scripts (safe — not the running Python)
    if sys.platform == "win32":
        wrapper_paths = [
            home / ".local" / "bin" / "openry.cmd",
            home / "bin" / "openry.cmd",
            home / ".local" / "bin" / "openry.bat",
        ]
    else:
        wrapper_paths = [
            home / ".local" / "bin" / "openry",
            home / "bin" / "openry",
        ]
    for wp in wrapper_paths:
        if wp.exists():
            try:
                wp.unlink()
                print(f"  ✓ Removed wrapper: {wp}")
            except Exception:
                pass

    # 2. Spawn detached pip uninstall (runs after we exit)
    if sys.platform == "win32":
        # Windows: use start /B for background
        _sp.Popen(
            ["cmd", "/c", "timeout /t 2 >nul && python -m pip uninstall openry -y >nul 2>&1"],
            creationflags=0x00000008,  # DETACHED_PROCESS
            stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
        )
    else:
        # Unix: nohup + bash delay
        _sp.Popen(
            ["nohup", "bash", "-c",
             "sleep 2 && python3 -m pip uninstall openry -y >/dev/null 2>&1"],
            start_new_session=True,
            stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
        )


def cmd_tools_sync(args: argparse.Namespace) -> None:
    """Sync tool configuration from seed/tools.yaml to OpenClaw configs.

    openry tools sync                   # Sync both contracts and agent config
    openry tools sync --check           # Dry-run: report differences only
    """
    import yaml
    from pathlib import Path as _Path

    home = _Path.home()
    try:
        import openry as _openry
        repo_root = _Path(_openry.__path__[0]).parent
    except Exception:
        print("✗ Could not locate OpenRY repo root")
        return

    tools_yaml = repo_root / "seed" / "tools.yaml"
    plugin_json = repo_root / "orchestrator-plugin" / "openclaw.plugin.json"
    ocl_config = home / ".openclaw" / "openclaw.json"

    if not tools_yaml.exists():
        print(f"✗ Not found: {tools_yaml}")
        return
    if not plugin_json.exists():
        print(f"✗ Not found: {plugin_json} (is the plugin installed?)")
        return

    # Read tools.yaml
    with open(tools_yaml, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    tools = data.get("tools", [])
    if not tools:
        print("✗ No tools defined in seed/tools.yaml")
        return

    print(f"Tools from seed/tools.yaml: {', '.join(tools)}")
    print()

    changes_made = False

    # ── 1. Update openclaw.plugin.json contracts.tools ──
    import json
    with open(plugin_json, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    old_contracts = cfg.get("contracts", {}).get("tools", [])

    if args.check:
        added = [t for t in tools if t not in old_contracts]
        removed = [t for t in old_contracts if t not in tools]
        if added:
            print(f"  Would add to contracts.tools: {added}")
        if removed:
            print(f"  Would remove from contracts.tools: {removed}")
        if not added and not removed:
            print("  contracts.tools: up to date")
    else:
        cfg.setdefault("contracts", {})["tools"] = tools
        with open(plugin_json, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"  ✓ Updated openclaw.plugin.json contracts.tools")
        changes_made = True

    # ── 2. Update ~/.openclaw/openclaw.json agent alsoAllow ──
    if ocl_config.exists():
        with open(ocl_config, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        found = False
        for a in cfg.get("agents", {}).get("list", []):
            if a.get("id") == "openry-worker":
                old_tools = a.get("tools", {}).get("alsoAllow", [])
                if args.check:
                    added = [t for t in tools if t not in old_tools]
                    removed = [t for t in old_tools if t not in tools]
                    if added:
                        print(f"  Would add to agent alsoAllow: {added}")
                    if removed:
                        print(f"  Would remove from agent alsoAllow: {removed}")
                    if not added and not removed:
                        print("  agent alsoAllow: up to date")
                else:
                    a.setdefault("tools", {})["alsoAllow"] = tools
                    if "profile" not in a.get("tools", {}):
                        a["tools"]["profile"] = "minimal"
                    print(f"  ✓ Updated agent 'openry-worker' alsoAllow")
                    changes_made = True
                found = True
                break

        if not found:
            print(f"  ⚠ Agent 'openry-worker' not found in openclaw.json (run install.sh first)")
        elif not args.check:
            with open(ocl_config, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
                f.write("\n")
    else:
        print(f"  ⚠ openclaw.json not found")

    print()
    if args.check:
        print("Dry-run complete. Run without --check to apply changes.")
    elif changes_made:
        print("✓ Tool config sync complete.")
        if args.restart:
            print("  Restarting OpenClaw gateway...")
            try:
                # Resolve openclaw path on Windows (subprocess doesn't auto-resolve .CMD/.ps1)
                _ocl = "openclaw"
                if sys.platform == "win32":
                    import shutil as _shutil
                    _resolved = _shutil.which("openclaw")
                    if _resolved:
                        _ocl = _resolved
                subprocess.run([_ocl, "gateway", "restart"], check=False)
            except FileNotFoundError:
                print("  ⚠ openclaw not found")
            except Exception as e:
                print(f"  ⚠ Gateway restart failed: {e}")
        else:
            print("  Run: openclaw gateway restart")
    else:
        print("✓ All configs up to date.")


def _detect_shell_rc() -> Path:
    """Detect the user's shell RC file path."""
    from pathlib import Path
    home = Path.home()
    shell = os.environ.get("SHELL", "")
    if "zsh" in shell:
        return home / ".zshrc"
    elif "bash" in shell:
        return home / ".bashrc"
    else:
        return home / ".profile"


def main() -> None:
    """Main entry point for the openry CLI.

    Usage:
        openry -c "command"           # Execute a command (backward compatible)
        openry --status completed      # Update task status (backward compatible)
        openry serve [--port PORT]     # Start the dashboard API server
    """
    # Fix stdout encoding on Windows (defaults to cp1252, can't encode emoji)
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")

    # Route 'serve' subcommand early to avoid breaking backward compat
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve_parser = argparse.ArgumentParser(prog="openry serve", description="Start the dashboard API server")
        serve_parser.add_argument("--host", type=str, default="127.0.0.1", help="Bind host")
        serve_parser.add_argument("--port", type=int, default=9100, help="Bind port")
        serve_parser.add_argument("--dev", action="store_true", help="Development mode")
        serve_args = serve_parser.parse_args(sys.argv[2:])
        from .server import run_server
        run_server(serve_args.host, serve_args.port)
        return

    # Route 'uninstall' subcommand
    if len(sys.argv) > 1 and sys.argv[1] == "uninstall":
        uninstall_parser = argparse.ArgumentParser(
            prog="openry uninstall",
            description="Uninstall OpenRY — remove data, clean config, optionally Full uninstall",
        )
        uninstall_parser.add_argument(
            "--with-openclaw", action="store_true",
            help="Also stop OpenClaw gateway, unregister plugin, remove agent config",
        )
        uninstall_parser.add_argument(
            "--force", "-f", action="store_true",
            help="Skip confirmation prompts",
        )
        uninstall_parser.add_argument(
            "--keep-data", action="store_true",
            help="Keep ~/.openry data directory",
        )
        uninstall_parser.add_argument(
            "--keep-env", action="store_true",
            help="Keep shell environment variable config",
        )
        uninstall_args = uninstall_parser.parse_args(sys.argv[2:])
        cmd_uninstall(uninstall_args)
        return

    # Route 'tools sync' subcommand
    if len(sys.argv) > 1 and sys.argv[1] == "tools" and len(sys.argv) > 2 and sys.argv[2] == "sync":
        tools_parser = argparse.ArgumentParser(
            prog="openry tools sync",
            description="Sync tool configuration from seed/tools.yaml to OpenClaw configs.",
        )
        tools_parser.add_argument(
            "--check", action="store_true",
            help="Dry-run: report differences without making changes",
        )
        tools_parser.add_argument(
            "--restart", "-r", action="store_true",
            help="Restart OpenClaw gateway after sync (one-command apply)",
        )
        tools_args = tools_parser.parse_args(sys.argv[3:])
        cmd_tools_sync(tools_args)
        return

    # Default mode: -c or --status (Phase 1/2 backward compatible)
    parser = argparse.ArgumentParser(
        prog="openry",
        description="Command forwarder and workflow guardrail for AI agents.",
        epilog=(
            "Subcommands:\n"
            "  openry serve [--port PORT]     Start the web dashboard\n"
            "  openry uninstall [OPTIONS]     Remove OpenRY data and configuration\n"
            "  openry tools sync [--check]    Sync tool config from seed/tools.yaml\n"
            "\n"
            "Examples:\n"
            "  openry -c 'echo hello'\n"
            "  openry --status completed --payload '{\"key\":\"value\"}'\n"
            "  openry serve --port 8080\n"
            "  openry uninstall --with-openclaw --force\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "-c", "--command",
        type=str,
        help="Shell command to execute",
    )
    group.add_argument(
        "--status",
        type=str,
        choices=["completed", "failed", "cancelled", "overflow"],
        help="Update task status (requires OPENRY_RUN_ID env var). "
             "Phase 2 adds: cancelled (soft-brake response), overflow (output too large)",
    )

    parser.add_argument(
        "--payload",
        type=str,
        default=None,
        help="JSON payload to attach to status update",
    )
    parser.add_argument(
        "-d", "--cwd",
        type=str,
        default=None,
        help="Working directory for command execution",
    )
    parser.add_argument(
        "-t", "--timeout",
        type=int,
        default=None,
        help="Command timeout in seconds (default: 300)",
    )
    parser.add_argument(
        "-e", "--env",
        type=str,
        action="append",
        default=None,
        help="Extra environment variable in KEY=VAL format (repeatable)",
    )

    args = parser.parse_args()

    if args.command is not None:
        cmd_execute(args)
    elif args.status is not None:
        cmd_status(args)
    else:
        print(json.dumps({"error": "either --command or --status is required"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
