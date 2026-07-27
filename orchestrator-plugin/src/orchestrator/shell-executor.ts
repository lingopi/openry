/**
 * Shell 执行器 — kind=shell sub_step 的辅助函数。
 * 纯函数，不依赖 PatrolLoop 或 DB。
 */

/**
 * 粗略估算 stdout 是否超过 max_output_tokens 阈值。
 * ~4 字符 ≈ 1 token（英文），中文 ~1.5 字符 ≈ 1 token。
 * 后续 Phase 3d 替换为 tiktoken 精确计数。
 */
export function isStdoutOverflow(stdout: string, maxTokens: number): boolean {
  if (maxTokens <= 0) return false;
  return stdout.length > maxTokens * 4;
}

/** 截断 stdout 到 maxTokens 阈值。 */
export function truncateStdout(stdout: string, maxTokens: number): string {
  return stdout.slice(0, maxTokens * 4);
}

/** 构建 overflow 策略下的 previous_summary（全文保存供 overflow workflow 使用）。 */
export function buildOverflowSummary(stdout: string): string {
  return JSON.stringify({ _full_stdout: stdout });
}

/** P0 默认 exit_code 映射。P1 扩展为 on_exit_codes。 */
export function mapExitCode(code: number | null): "completed" | "failed" {
  return code === 0 ? "completed" : "failed";
}

// ── 模板插值 ──────────────────────────────────────────────────

/**
 * 模板插值：替换 command 中的 ${payload.xxx} 和 ${env.VAR}。
 * payload 值自动单引号包裹，防止 shell 特殊字符破坏命令结构。
 */
export function interpolateCommand(
  command: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
): string {
  return command
    .replace(/\$\{payload\.([^}]+)\}/g, (_, key: string) => {
      const val = payload[key];
      return shellEscape(val !== undefined ? String(val) : "");
    })
    .replace(/\$\{env\.([^}]+)\}/g, (_, key: string) => {
      return shellEscape(env[key] ?? "");
    });
}

/** 单引号包裹，内部单引号转义为 '\\'' */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Payload 构建 ──────────────────────────────────────────────

/**
 * 从 stdout 构建 payload。
 *
 * 优先级：
 *   1. 如果指定了 payload_keys → 尝试 JSON.parse → 白名单过滤
 *   2. JSON.parse 失败 → 按 payload_keys_on_error 策略降级
 *   3. 未指定 payload_keys → 全文 _stdout
 */
export function buildStdoutPayload(
  stdout: string,
  opts?: {
    payloadKeys?: string[];
    payloadKeysOnError?: "abort" | "fallback";
    truncated?: boolean;
    originalSize?: number;
    overflow?: boolean;
  },
): { payload: Record<string, unknown>; overrideStatus?: "dropped" | "completed" } {
  const keys = opts?.payloadKeys;

  // 用户指定了 payload_keys → 尝试 JSON 提取
  if (keys && keys.length > 0) {
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const extracted: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in parsed) {
            extracted[key] = parsed[key];
          }
        }
        return { payload: extracted };
      }
      // stdout 是合法 JSON 但不是 object（如 "hello" 或 [1,2,3]）
      return handleParseFailure(stdout, opts?.payloadKeysOnError);
    } catch {
      // JSON.parse 失败
      return handleParseFailure(stdout, opts?.payloadKeysOnError);
    }
  }

  // 默认：全文 _stdout
  return { payload: buildRawPayload(stdout, opts) };
}

function handleParseFailure(
  stdout: string,
  onError?: "abort" | "fallback",
): { payload: Record<string, unknown>; overrideStatus: "dropped" | "completed" } {
  if (onError === "fallback") {
    return { payload: { _stdout: stdout }, overrideStatus: "completed" };
  }
  return {
    payload: {
      _parse_error: "stdout is not a valid JSON object; payload_keys extraction failed",
      _stdout: stdout.slice(0, 500),
    },
    overrideStatus: "dropped",
  };
}

function buildRawPayload(
  stdout: string,
  opts?: { truncated?: boolean; originalSize?: number; overflow?: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { _stdout: stdout };
  if (opts?.truncated) {
    payload._truncated = true;
    payload._original_size = opts.originalSize;
  }
  if (opts?.overflow) {
    payload._overflow = true;
  }
  return payload;
}
