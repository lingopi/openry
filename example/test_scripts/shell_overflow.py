#!/usr/bin/env python3
"""shell_overflow 测试脚本 — 生成大量输出，测试溢出策略"""
import sys

strategy = sys.argv[1] if len(sys.argv) > 1 else "large"

if strategy == "small":
    # 小输出 — 不触发溢出
    for i in range(5):
        print(f"Line {i}: This is a small output.")
elif strategy == "large":
    # 大输出 — 约 50KB，配合 max_output_tokens: 1000 可触发溢出
    for i in range(2000):
        print(f"Line {i:04d}: The quick brown fox jumps over the lazy dog. 这是重复内容用于填充输出。")
else:
    print(f"Unknown strategy: {strategy}")
    sys.exit(1)

print("Done.")
