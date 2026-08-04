/**
 * KnowQL Knowledge — 类型定义
 */

// ── AST 请求 ────────────────────────────────────────────────────

export interface QueryKnowledgeRequest {
  query: "knowledge";

  /** 搜索描述（自由文本） */
  search: string;

  /** 筛选条件：primitives 过滤 */
  primitives?: {
    mode: "all" | "any";
    values: string[];
  };

  /** 时间范围硬过滤 */
  scope?: {
    workflow_instance_id?: number;
    composition?: string;
    since?: string;
    until?: string;
  };

  /** 模式：best = 只取 Top-1 cluster；expand = 不够时扩展 */
  mode?: "best" | "expand";

  /** 排序：desc = 最新在前（默认）；asc = 最早在前 */
  sort?: "desc" | "asc";

  /** 返回数量，默认 5，最大 20 */
  limit?: number;
}

// ── 响应 ────────────────────────────────────────────────────────

export interface QueryKnowledgeResult {
  _run_id: string;
  _step: string;
  _at: string;

  /** 该记录所属 cluster 在向量搜索中的排名（1 = 最匹配） */
  core_rank: number;

  /** 该 cluster 与搜索词的语义相似度 */
  cos_similarity: number;

  /** 归一化后的显示标签 */
  concepts: string[];

  /** cluster UUID 主键 */
  _core_id: string;

  /** 全部原语类型 */
  primitives: string[];

  /** 三层全返 payload */
  payload: Record<string, unknown>;
}

export interface QueryKnowledgeResponse {
  results: QueryKnowledgeResult[];
  matched: number;
  planner_trace: {
    search: string;
    method: "vector" | "llm";
    mode: "best" | "expand";
    threshold: number;
    candidates_above_threshold: number;
    selected_core_ids: string[];
    sort: string;
  };
}

// ── Cluster 记录 ─────────────────────────────────────────────────

export interface ClusterRecord {
  core_id: string;
  display_labels: string[];
  description: string;
  centroid_embedding: number[];
  sum_embedding: number[];
  member_count: number;
  created_at: string;
  updated_at: string;
}

// ── 归一化结果 ──────────────────────────────────────────────────

export interface NormalizeResult {
  core_id: string;
  display_labels: string[];
}
