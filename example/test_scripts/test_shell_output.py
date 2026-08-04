#!/usr/bin/env python3
"""
Phase C 测试脚本 — 模拟 shell step 的输出

读取一个真实的 session.json 文件，将其内容作为 stdout 输出。
模拟"shell 执行了一个数据拉取操作，产出了大批量结构化 JSON"的场景。

用法：
  python3 test_shell_output.py <session_json_path>

示例：
  python3 test_shell_output.py /Users/yifan/Desktop/OpenRY/docs/781b57d5d5b0.json
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 test_shell_output.py <session_json_path>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(json.dumps({"error": f"Failed to read file: {e}"}))
        sys.exit(1)

    # 直接输出完整的 JSON 内容到 stdout
    # 这模拟了 shell 命令的输出 —— 一堆原始数据
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
