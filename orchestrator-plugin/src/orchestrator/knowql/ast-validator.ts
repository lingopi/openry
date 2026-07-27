/**
 * 请求验证器 — 验证 KnowQL 查询的合法性并执行权限检查。
 */
import type { PayloadQueryScope } from "./types.js";

// ── 默认权限 ─────────────────────────────────────────────────────

const DEFAULT_SCOPE: PayloadQueryScope = {
  compositions: "current",
  max_queries: 5,
  allow_search: false,
};

// ── 查询计数器（单 agent 会话内） ──────────────────────────────

const queryCounters = new Map<string, number>();

export function resetQueryCounter(sessionKey: string): void {
  queryCounters.delete(sessionKey);
}

function checkQueryLimit(sessionKey: string, maxQueries: number): void {
  const current = queryCounters.get(sessionKey) ?? 0;
  if (current >= maxQueries) {
    throw new KnowQLValidationError(
      `查询次数已达上限（${maxQueries}）。如需更多查询，请精简查询策略。`
    );
  }
  queryCounters.set(sessionKey, current + 1);
}

// ── 错误类型 ─────────────────────────────────────────────────────

export class KnowQLValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowQLValidationError";
  }
}

// ── 验证入口 ─────────────────────────────────────────────────────

export interface ValidationContext {
  scope?: PayloadQueryScope;
  sessionKey?: string;
  currentComposition?: string;
}

export function validateRequest(
  request: unknown,
  ctx: ValidationContext = {},
): Record<string, unknown> {
  if (!request || typeof request !== "object") {
    throw new KnowQLValidationError("请求必须是一个 JSON 对象");
  }

  const req = request as Record<string, unknown>;
  const scope = ctx.scope ?? DEFAULT_SCOPE;

  // ① 查询次数限制
  if (ctx.sessionKey) {
    checkQueryLimit(ctx.sessionKey, scope.max_queries);
  }

  // ② discover 或 query 二选一
  if ("discover" in req) {
    return validateDiscover(req, scope, ctx);
  }
  if ("query" in req) {
    return validateQuery(req, scope, ctx);
  }

  throw new KnowQLValidationError(
    `请求必须包含 "discover" 或 "query" 字段。` +
    `discover: "runtime" | "compositions" | "big_step"；query: "payload"`
  );
}

// ── discover 验证 ────────────────────────────────────────────────

function validateDiscover(
  req: Record<string, unknown>,
  scope: PayloadQueryScope,
  ctx: ValidationContext,
): Record<string, unknown> {
  const valid = ["runtime", "compositions", "big_step"];
  const mode = req.discover as string;

  if (typeof mode !== "string" || !valid.includes(mode)) {
    throw new KnowQLValidationError(
      `discover 必须是: ${valid.join(" | ")}，收到: ${JSON.stringify(mode)}`
    );
  }

  const result: Record<string, unknown> = { discover: mode };

  if (mode === "big_step") {
    const ref = req.ref;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new KnowQLValidationError(
        `discover "big_step" 需要 ref 参数（big_step 的 ref 名称）`
      );
    }
    result.ref = ref;
  }

  return result;
}

// ── query 验证 ───────────────────────────────────────────────────

function validateQuery(
  req: Record<string, unknown>,
  scope: PayloadQueryScope,
  ctx: ValidationContext,
): Record<string, unknown> {
  const queryMode = req.query as string;

  if (queryMode !== "payload") {
    throw new KnowQLValidationError(
      `query 当前只支持 "payload"，收到: ${JSON.stringify(queryMode)}`
    );
  }

  const runId = req.run_id;
  const stepId = req.step_id;

  if (!runId && !stepId) {
    throw new KnowQLValidationError(
      `query payload 需要 run_id 或 step_id。` +
      `使用 {"discover": "runtime"} 查看可用 step 及其 run_id`
    );
  }

  const result: Record<string, unknown> = { query: "payload" };

  if (runId && typeof runId === "string") result.run_id = runId;
  if (stepId && typeof stepId === "string") result.step_id = stepId;

  // composition 权限
  const comp = req.composition;
  if (comp && typeof comp === "string") {
    if (scope.compositions !== "all") {
      const allowed = scope.compositions === "current"
        ? [ctx.currentComposition ?? "current"]
        : scope.compositions;
      if (!allowed.includes(comp)) {
        throw new KnowQLValidationError(
          `跨 composition 查询 "${comp}" 不在允许范围。允许: ${allowed.join(", ")}`
        );
      }
    }
    result.composition = comp;
  }

  // 可选筛选字段
  if (req.time && typeof req.time === "string") result.time = req.time;
  if (req.status) {
    const s = req.status;
    if (Array.isArray(s)) {
      if (s.some((v) => typeof v !== "string")) throw new KnowQLValidationError("status 数组必须全是字符串");
      result.status = s;
    } else if (typeof s === "string") {
      result.status = s;
    } else {
      throw new KnowQLValidationError("status 必须是字符串或字符串数组");
    }
  }
  if (req.limit !== undefined) {
    if (typeof req.limit !== "number" || req.limit < 1) throw new KnowQLValidationError("limit 必须是正整数");
    result.limit = req.limit;
  }
  if (req.contains) {
    if (typeof req.contains !== "string") throw new KnowQLValidationError("contains 必须是字符串");
    result.contains = req.contains;
  }

  return result;
}

