/**
 * KnowQL 类型定义（重构版）
 *
 * discover（探索） + query（精确查询），扁平化参数，无 key 投影。
 */

// ── 顶层请求 ────────────────────────────────────────────────────

/** discover: 探索静态配置或运行时状态 */
export interface KnowQLDiscover {
  discover: "runtime" | "compositions" | "big_step";
  /** discover="big_step" 时必填 */
  ref?: string;
}

/** query: 精确查询 payload */
export interface KnowQLQuery {
  query: "payload";
  /** 主键精确查询（优先，来自 discover runtime） */
  run_id?: string;
  /** 条件查询：sub_step id */
  step_id?: string;
  /** 跨 composition 查询时指定 */
  composition?: string;
  /** 时间筛选："latest" 或 "2026-07-23" 格式日期 */
  time?: string;
  /** 状态筛选 */
  status?: string | string[];
  /** 数量限制 */
  limit?: number;
  /** 内容搜索 */
  contains?: string;
}

export type KnowQLRequest = KnowQLDiscover | KnowQLQuery;

// ── Topology entries（buildTopology 产出）───────────────────────

export interface CompositionEntry {
  name: string;
  description: string;
  big_steps: BigStepRefEntry[];
}

export interface BigStepRefEntry {
  ref: string;
  description: string;
}

export interface BigStepEntry {
  ref: string;
  name: string;
  description: string;
  sub_step_ids: string[];
  /** buildTopology 填充：所属 composition name */
  _composition?: string;
}

export interface SubStepEntry {
  id: string;
  kind: string;
  description: string;
  /** buildTopology 填充：所属 big_step ref */
  _big_step?: string;
}

// ── discover 返回 ────────────────────────────────────────────────

export interface DiscoverRuntimeStep {
  step_id: string;
  run_id: string;
  status: string;
  description: string;
  updated_at: string | null;
}

export interface DiscoverRuntimeResult {
  workflow_instance_id: number;
  composition: string;
  steps: DiscoverRuntimeStep[];
  total: number;
}

export interface DiscoverCompositionsResult {
  compositions: CompositionEntry[];
  total: number;
}

export interface DiscoverBigStepResult {
  ref: string;
  name: string;
  description: string;
  sub_steps: SubStepEntry[];
}

// ── query payload 返回 ───────────────────────────────────────────

export interface QueryPayloadHit {
  run_id: string;
  step_id: string;
  status: string;
  workflow_instance_id: number;
  updated_at: string | null;
  payload: Record<string, unknown>;
}

/** run_id 精确查询：单条结果 */
export interface QueryPayloadSingleResult {
  run_id: string;
  step_id: string;
  status: string;
  workflow_instance_id: number;
  updated_at: string | null;
  payload: Record<string, unknown>;
}

/** step_id 条件查询：多条结果 */
export interface QueryPayloadMultiResult {
  step_id: string;
  composition?: string;
  results: QueryPayloadHit[];
  total: number;
  hint?: string;
}

export type QueryPayloadResult = QueryPayloadSingleResult | QueryPayloadMultiResult;

// ── 统一返回 ─────────────────────────────────────────────────────

export type KnowQLResponse =
  | DiscoverRuntimeResult
  | DiscoverCompositionsResult
  | DiscoverBigStepResult
  | QueryPayloadResult
  | { error: string; hint?: string };

// ── 权限配置 ────────────────────────────────────────────────────

export interface PayloadQueryScope {
  compositions: "current" | "all" | string[];
  max_queries: number;
  allow_search?: boolean;
  allowed_intents?: string[];
}
