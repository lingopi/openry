/**
 * Intent Resolver — 将 KnowQL 扁平请求解析为标准化查询参数。
 *
 * 负责填充 discover/query 的默认值（instance、composition），
 * 构建供 query-executor 使用的标准化查询描述。
 */
import type { KnowQLRequest } from "./types.js";

// ── 解析后的查询描述 ────────────────────────────────────────────

export interface ResolvedQuery {
  mode: "discover" | "query";
  discoverMode?: "runtime" | "compositions" | "big_step";
  /** discover="big_step" 时的 ref */
  ref?: string;
  /** query="payload" 时的定位方式 */
  run_id?: string;
  step_id?: string;
  /** 标准化后的筛选条件 */
  filters: NormalizedFilters;
  /** 目标 composition */
  composition: string;
  /** 运行时解析后的 workflow_instance_id（仅当前 workflow 内查询生效） */
  _resolvedInstanceId?: number;
}

export interface NormalizedFilters {
  time?: string;
  status: string[];
  limit: number;
  contains?: string;
}

// ── 默认值 ───────────────────────────────────────────────────────

const DEFAULT_FILTERS: NormalizedFilters = {
  status: ["done", "abort"],
  limit: 3,
};

// ── 入口 ─────────────────────────────────────────────────────────

export function resolveQuery(
  request: KnowQLRequest,
  runtimeContext: {
    currentWorkflowInstanceId: number;
    currentComposition: string;
  },
): ResolvedQuery {
  if ("discover" in request) {
    return resolveDiscover(request, runtimeContext);
  }
  return resolvePayloadQuery(request, runtimeContext);
}

// ── Discover 解析 ────────────────────────────────────────────────

function resolveDiscover(
  req: { discover: "runtime" | "compositions" | "big_step"; ref?: string },
  ctx: { currentWorkflowInstanceId: number; currentComposition: string },
): ResolvedQuery {
  const base: ResolvedQuery = {
    mode: "discover",
    discoverMode: req.discover,
    composition: ctx.currentComposition,
    filters: { ...DEFAULT_FILTERS },
  };

  if (req.discover === "big_step") {
    base.ref = req.ref;
    // big_step 的 ref 在 workflows/ 扁平目录中全局唯一，不需要 composition 消歧
    return base;
  }

  if (req.discover === "runtime") {
    // 限定当前 workflow instance
    base._resolvedInstanceId = ctx.currentWorkflowInstanceId;
    return base;
  }

  // discover="compositions" 不需要 instance 隔离
  return base;
}

// ── Query Payload 解析 ───────────────────────────────────────────

function resolvePayloadQuery(
  req: {
    query: "payload";
    run_id?: string;
    step_id?: string;
    composition?: string;
    time?: string;
    status?: string | string[];
    limit?: number;
    contains?: string;
  },
  ctx: { currentWorkflowInstanceId: number; currentComposition: string },
): ResolvedQuery {
  const targetComposition = req.composition ?? ctx.currentComposition;
  const isCrossComposition = req.composition !== undefined && req.composition !== ctx.currentComposition;

  const filters: NormalizedFilters = {
    time: req.time ?? "latest",
    status: normalizeStatus(req.status),
    limit: req.limit ?? DEFAULT_FILTERS.limit,
    contains: req.contains,
  };

  const resolved: ResolvedQuery = {
    mode: "query",
    composition: targetComposition,
    filters,
  };

  if (req.run_id) {
    // 主键精确查询，不需要 instance 隔离
    resolved.run_id = req.run_id;
    return resolved;
  }

  // step_id 条件查询
  resolved.step_id = req.step_id;

  // 关键修复：跨 composition 时不注入当前 instance ID
  if (!isCrossComposition) {
    resolved._resolvedInstanceId = ctx.currentWorkflowInstanceId;
  }

  return resolved;
}

// ── 辅助 ─────────────────────────────────────────────────────────

function normalizeStatus(status: string | string[] | undefined): string[] {
  if (!status) return DEFAULT_FILTERS.status;
  const arr = Array.isArray(status) ? status : [status];
  return arr.length > 0 ? arr : DEFAULT_FILTERS.status;
}

