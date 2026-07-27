#!/usr/bin/env python3
"""Phase 3a 端到端测试：向 DB 注入 completed 任务，由 orchestrator 验证并路由。

用法：
    # 确保 orchestrator 在运行中
    python3 tests/run_phase3a_e2e.py

每个测试用例：
  1. 向 task_state 表插入一条 status='completed' 的记录
  2. orchestrator 在下一个 patrol 周期（最多 5 秒）自动验证
  3. 查询 validation_results 表确认验证结果
  4. 查询 task_state 确认路由目标
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

# 确保项目根在 sys.path 中
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 强制使用 ~/.openry（不要污染项目目录）
os.environ.setdefault("OPENRY_HOME", os.path.expanduser("~/.openry"))

from openry.db import (
    _get_conn,
    _init_phase2_schema,
)
from openry.orchestrator.yaml_loader import load_big_step


# ── 颜色输出 ───────────────────────────────────────────────────

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"


def ok(msg: str) -> str:
    return f"{GREEN}✓{RESET} {msg}"


def fail(msg: str) -> str:
    return f"{RED}✗{RESET} {msg}"


def info(msg: str) -> str:
    return f"{CYAN}→{RESET} {msg}"


def header(msg: str) -> str:
    return f"\n{BOLD}{'='*60}{RESET}\n{BOLD}{msg}{RESET}\n{BOLD}{'='*60}{RESET}"


# ── 测试用例定义 ────────────────────────────────────────────────

TEST_CASES = [
    {
        "name": "全部验证通过 (all_pass)",
        "sub_step_id": "all_pass",
        "payload": {
            "a": 42,
            "b": 42,             # a == b ✓
            "status": "active",
            "old_status": "draft",  # status != old_status ✓
            "count": 10,          # > 0 ✓
            "errors": 2,          # < 5 ✓
            "category": "safe",   # in allow set ✓
            "data_type": "hello", # type str ✓
            "is_admin": False,
            "role": "editor",     # OR: role in set ✓
        },
        "expected_target": "done",
    },
    {
        "name": "短路求值 — 第一条 when 失败",
        "sub_step_id": "short_circuit",
        "payload": {
            "status": "inactive",  # != "active" → 第一条 when 失败
            "count": 5,
        },
        "expected_target": "fail_short_circuit",
    },
    {
        "name": "when_any OR 组 — 第二条件通过",
        "sub_step_id": "when_any_pass",
        "payload": {
            "is_admin": False,     # 第一条件不通过
            "role": "editor",      # 第二条件通过 → OR 组通过
        },
        "expected_target": "done",
    },
    {
        "name": "when_any OR 组 — 全部不通过",
        "sub_step_id": "when_any_fail",
        "payload": {
            "is_admin": False,     # 不通过
            "role": "viewer",      # 不通过 → OR 组失败
        },
        "expected_target": "fail_or_all",
    },
    {
        "name": "payload_value_in_set deny 模式",
        "sub_step_id": "deny_mode",
        "payload": {
            "category": "banned",  # 在 deny 列表中 → on_mismatch
        },
        "expected_target": "fail_deny",
    },
]


# ── 测试执行 ───────────────────────────────────────────────────


def run_one_test(tc: dict, big_step: dict) -> bool:
    """运行一个测试用例：插入 DB → evaluate_routing() → 验证结果。"""
    sub_step_id = tc["sub_step_id"]
    step_config = None
    for ss in big_step.get("sub_steps", []):
        if ss.get("id") == sub_step_id:
            step_config = ss
            break

    if not step_config:
        print(fail(f"  找不到 sub_step: {sub_step_id}"))
        return False

    validation_routing = step_config.get("validation_routing")
    if not validation_routing:
        print(fail(f"  sub_step 没有 validation_routing"))
        return False

    run_id = f"e2e-{uuid.uuid4().hex[:8]}"
    payload_json = json.dumps(tc["payload"], ensure_ascii=False)

    # 写入 completed 任务到 DB
    conn = _get_conn()
    conn.execute(
        """INSERT INTO task_state
           (run_id, workflow, step_id, big_step_ref, sub_step_id,
            status, payload, workflow_instance_id, max_tool_calls,
            max_retries, max_sub_step_retries, validation_status)
           VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, 0, 0, 0, 'pending')""",
        (run_id, "test_all_validations", sub_step_id,
         "test_all_validations", sub_step_id, payload_json),
    )
    conn.commit()
    conn.close()

    # 端到端：从 DB 读取 payload → validate → route
    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing(run_id, step_config)

    expected = tc["expected_target"]

    # 打印每条 when 的验证详情
    if hasattr(result, 'target'):
        pass  # handled below

    # 查询 validation_results（由 evaluate_routing 内部的 validate 写入）
    conn = _get_conn()
    conn.row_factory = None
    vrows = conn.execute(
        "SELECT rule_type, passed, message FROM validation_results WHERE run_id = ? ORDER BY id",
        (run_id,),
    ).fetchall()
    conn.close()

    passed = (result.target == expected)

    if passed:
        print(ok(f"  {tc['name']}: 路由到 '{result.target}' (期望 '{expected}')"))
    else:
        print(fail(f"  {tc['name']}: 路由到 '{result.target}' (期望 '{expected}')"))
    if result.message:
        print(f"     message: {result.message[:100]}")

    # 打印验证详情
    if vrows:
        for rule_type, p, msg in vrows:
            icon = "✓" if p else "✗"
            short = msg[:80] if msg else ""
            print(f"     {icon} {rule_type}: {short}")

    return passed


def main():
    _init_phase2_schema()

    # 加载 workflow
    try:
        big_step = load_big_step("test_all_validations")
    except FileNotFoundError:
        print(fail("找不到 workflow: test_all_validations.yaml"))
        print("请确保文件在 .openry/workflows/ 下")
        sys.exit(1)

    print(header("Phase 3a 端到端验证测试"))
    print(f"Workflow: test_all_validations ({len(big_step.get('sub_steps', []))} 个 sub_step)")
    print(f"测试用例: {len(TEST_CASES)} 个\n")

    passed = 0
    failed = 0

    for i, tc in enumerate(TEST_CASES, 1):
        print(f"\n{CYAN}[{i}/{len(TEST_CASES)}]{RESET} {BOLD}{tc['name']}{RESET}")
        if run_one_test(tc, big_step):
            passed += 1
        else:
            failed += 1

    print(header("结果"))
    print(f"  通过: {GREEN}{passed}{RESET}")
    print(f"  失败: {RED}{failed}{RESET}")
    print(f"  总计: {passed + failed}")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
