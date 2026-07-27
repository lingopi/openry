#!/usr/bin/env python3
"""shell_json_test 测试脚本 — 输出合法 JSON，供 payload_keys 提取"""
import json
import sys

# 一些日志走 stderr（不影响 payload）
print("Starting analysis...", file=sys.stderr)
print("Processing data...", file=sys.stderr)

# 结构化结果走 stdout
result = {
    "status": "ok",
    "count": 42,
    "message": "Analysis complete",
    "debug_info": "this should be filtered out by payload_keys",
    "timestamp": "2026-07-27T22:00:00Z",
}
print(json.dumps(result))
