#!/usr/bin/env python3
"""shell_interpolation_test — 接收命令行参数，验证 ${payload.xxx} 模板插值"""
import sys
import json

if len(sys.argv) < 5:
    print("Usage: shell_interpolation_test.py --status <status> --count <count>")
    sys.exit(1)

status_val = sys.argv[sys.argv.index("--status") + 1] if "--status" in sys.argv else "unknown"
count_val = sys.argv[sys.argv.index("--count") + 1] if "--count" in sys.argv else "0"

print(f"Received status: {status_val}")
print(f"Received count: {count_val}")

# 验证：如果接收到的值和上游 payload 一致，说明模板插值成功
if status_val == "ok" and count_val == "42":
    print("✅ Template interpolation SUCCESS: values match upstream payload")
    print(json.dumps({"interpolation_ok": True}))
else:
    print(f"❌ Template interpolation FAIL: expected status=ok, count=42")
    print(f"   Got status={status_val}, count={count_val}")
