#!/usr/bin/env python3
"""shell_payload_from_test — 验证从指定 upstream step 收到了正确的 payload"""
import json
import sys

# 检查命令行参数中是否有 payload_from 传来的值
status_val = None
count_val = None

for i, arg in enumerate(sys.argv):
    if arg == "--status" and i + 1 < len(sys.argv):
        status_val = sys.argv[i + 1]
    elif arg == "--count" and i + 1 < len(sys.argv):
        count_val = sys.argv[i + 1]

print(f"Status from payload_from: {status_val}")
print(f"Count from payload_from: {count_val}")

if status_val == "ok" and count_val == "42":
    print("✅ payload_from SUCCESS: got correct values from upstream step")
    print(json.dumps({"payload_from_ok": True, "source_status": status_val, "source_count": count_val}))
else:
    print(f"❌ payload_from FAIL: expected status=ok, count=42")
