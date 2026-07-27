#!/usr/bin/env python3
"""shell_maybe_json — 有时输出 JSON，有时不输出，测试 payload_keys_on_error"""
import json
import sys
import random

mode = sys.argv[1] if len(sys.argv) > 1 else "json"

if mode == "json":
    print(json.dumps({"result": "success", "value": 100}))
elif mode == "text":
    print("This is plain text, not JSON at all.")
    print("No structured data here.")
else:
    print(f"Unknown mode: {mode}")
    sys.exit(1)
