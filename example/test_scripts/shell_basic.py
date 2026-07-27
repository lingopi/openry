#!/usr/bin/env python3
"""shell_basic_stdout 测试脚本 — 最简单的 stdout → _stdout"""
import sys
import time

print("=== Shell Basic Stdout Test ===")
print(f"Current time: {time.ctime()}")
print(f"Python version: {sys.version}")
print("Task completed successfully.")
print("Lines: 6")
print("Status: PASS")
