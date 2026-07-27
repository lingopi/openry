/**
 * shell-executor 单元测试。
 */
import { describe, it, expect } from "vitest";
import {
  isStdoutOverflow,
  truncateStdout,
  buildOverflowSummary,
  buildStdoutPayload,
  interpolateCommand,
  mapExitCode,
} from "./shell-executor.js";

// ── mapExitCode ──────────────────────────────────────────────

describe("mapExitCode", () => {
  it("exit 0 → completed", () => {
    expect(mapExitCode(0)).toBe("completed");
  });
  it("exit 1 → failed", () => {
    expect(mapExitCode(1)).toBe("failed");
  });
  it("exit null → failed", () => {
    expect(mapExitCode(null)).toBe("failed");
  });
});

// ── isStdoutOverflow / truncateStdout ────────────────────────

describe("isStdoutOverflow", () => {
  it("maxTokens=0 不触发溢出", () => {
    expect(isStdoutOverflow("a".repeat(100000), 0)).toBe(false);
  });
  it("stdout 超出阈值", () => {
    expect(isStdoutOverflow("a".repeat(50000), 10000)).toBe(true);
  });
  it("stdout 未超出阈值", () => {
    expect(isStdoutOverflow("a".repeat(10000), 10000)).toBe(false);
  });
});

describe("truncateStdout", () => {
  it("截断到阈值", () => {
    const result = truncateStdout("a".repeat(50000), 10000);
    expect(result.length).toBe(10000 * 4);
  });
});

// ── buildOverflowSummary ─────────────────────────────────────

describe("buildOverflowSummary", () => {
  it("包裹 stdout 全文", () => {
    const result = buildOverflowSummary("hello world");
    const parsed = JSON.parse(result);
    expect(parsed._full_stdout).toBe("hello world");
  });
});

// ── interpolateCommand ───────────────────────────────────────

describe("interpolateCommand", () => {
  it("简单替换 ${payload.xxx}", () => {
    const result = interpolateCommand(
      "echo ${payload.msg}",
      { msg: "hello" },
      {},
    );
    expect(result).toBe("echo 'hello'");
  });

  it("多 key 替换", () => {
    const result = interpolateCommand(
      "cmd --a ${payload.x} --b ${payload.y}",
      { x: "1", y: "2" },
      {},
    );
    expect(result).toBe("cmd --a '1' --b '2'");
  });

  it("管道兼容", () => {
    const result = interpolateCommand(
      "cat ${payload.file} | grep x",
      { file: "/tmp/a.log" },
      {},
    );
    expect(result).toBe("cat '/tmp/a.log' | grep x");
  });

  it("特殊字符单引号包裹", () => {
    const result = interpolateCommand(
      "grep ${payload.pat} file",
      { pat: "err|warn" },
      {},
    );
    expect(result).toBe("grep 'err|warn' file");
  });

  it("${env.VAR} 插值", () => {
    const result = interpolateCommand(
      "--token ${env.TOKEN}",
      {},
      { TOKEN: "sk-xxxxx" },
    );
    expect(result).toBe("--token 'sk-xxxxx'");
  });

  it("key 缺失替换为空字符串", () => {
    const result = interpolateCommand(
      "echo ${payload.missing}",
      {},
      {},
    );
    expect(result).toBe("echo ''");
  });
});

// ── buildStdoutPayload ───────────────────────────────────────

describe("buildStdoutPayload", () => {
  it("默认：全文 _stdout", () => {
    const { payload, overrideStatus } = buildStdoutPayload("hello world");
    expect(payload._stdout).toBe("hello world");
    expect(overrideStatus).toBeUndefined();
  });

  it("payload_keys 正常提取", () => {
    const { payload } = buildStdoutPayload(
      '{"a":1,"b":2,"c":3}',
      { payloadKeys: ["a", "c"] },
    );
    expect(payload).toEqual({ a: 1, c: 3 });
  });

  it("payload_keys 部分缺失，静默跳过", () => {
    const { payload } = buildStdoutPayload(
      '{"a":1}',
      { payloadKeys: ["a", "b"] },
    );
    expect(payload).toEqual({ a: 1 });
  });

  it("非 JSON + abort（默认）→ dropped", () => {
    const { payload, overrideStatus } = buildStdoutPayload(
      "not json",
      { payloadKeys: ["a"] },
    );
    expect(overrideStatus).toBe("dropped");
    expect(payload._parse_error).toBeDefined();
  });

  it("非 JSON + fallback → 降级到 _stdout", () => {
    const { payload, overrideStatus } = buildStdoutPayload(
      "not json",
      { payloadKeys: ["a"], payloadKeysOnError: "fallback" },
    );
    expect(overrideStatus).toBe("completed");
    expect(payload._stdout).toBe("not json");
  });

  it("JSON 数组 + abort → dropped", () => {
    const { payload, overrideStatus } = buildStdoutPayload(
      "[1,2,3]",
      { payloadKeys: ["a"] },
    );
    expect(overrideStatus).toBe("dropped");
    expect(payload._parse_error).toBeDefined();
  });

  it("无 payload_keys 时 stdout 是 JSON 也全文 _stdout", () => {
    const { payload } = buildStdoutPayload('{"a":1}');
    expect(payload._stdout).toBe('{"a":1}');
  });

  it("truncated 标记", () => {
    const { payload } = buildStdoutPayload("short", { truncated: true, originalSize: 50000 });
    expect(payload._truncated).toBe(true);
    expect(payload._original_size).toBe(50000);
  });

  it("overflow 标记", () => {
    const { payload } = buildStdoutPayload("big", { overflow: true });
    expect(payload._overflow).toBe(true);
  });

  it("空 stdout", () => {
    const { payload } = buildStdoutPayload("");
    expect(payload._stdout).toBe("");
  });
});
