/**
 * KnowQL Knowledge — Executor（DB 查询）
 */

import type Database from "better-sqlite3";
import type { QueryKnowledgeRequest, QueryKnowledgeResponse, QueryKnowledgeResult } from "./types.js";
import { planQuery, ABS_THRESHOLD } from "./planner.js";

/**
 * 执行 knowledge 查询：
 *   Planner → core_id(s) → DB 精确匹配 → 组装响应
 */
export async function executeQuery(
  db: Database.Database,
  req: QueryKnowledgeRequest,
): Promise<QueryKnowledgeResponse> {
  const mode = req.mode ?? "best";
  const limit = Math.min(req.limit ?? 5, 20);
  const sortDir = req.sort ?? "desc";

  // 1. Planner
  const plan = await planQuery(db, req.search, mode);

  if (plan.coreIds.length === 0) {
    return {
      results: [],
      matched: 0,
      planner_trace: {
        search: req.search,
        method: "vector",
        mode,
        threshold: ABS_THRESHOLD,
        candidates_above_threshold: 0,
        selected_core_ids: [],
        sort: sortDir,
      },
    };
  }

  // 2. DB 查询（逐 cluster，按 core_rank 优先）
  const allResults: QueryKnowledgeResult[] = [];

  // 构建 primitives 过滤子句
  let primitivesFilter = "";
  if (req.primitives?.values?.length) {
    if (req.primitives.mode === "all") {
      // TODO: 实现 all 语义（所有指定 primitives 都要存在）
      primitivesFilter = "";
    } else {
      primitivesFilter = `AND (
        ${req.primitives.values.map(p =>
          `json_extract(payload, '$.primitives') LIKE '%${p}%'`
        ).join(" OR ")}
      )`;
    }
  }

  // 时间过滤
  let timeFilter = "";
  if (req.scope?.since) timeFilter += ` AND updated_at >= '${req.scope.since}'`;
  if (req.scope?.until) timeFilter += ` AND updated_at <= '${req.scope.until}'`;

  for (const [idx, coreId] of plan.coreIds.entries()) {
    if (allResults.length >= limit) break;

    const remaining = limit - allResults.length;
    const rows = db.prepare(
      `SELECT run_id, sub_step_id, status, updated_at, payload
       FROM task_state
       WHERE json_extract(payload, '$._core_id') = ?
         AND run_id NOT LIKE 'compress-%'
         ${primitivesFilter}
         ${timeFilter}
       ORDER BY updated_at ${sortDir}
       LIMIT ?`
    ).all(coreId, remaining) as Array<{
      run_id: string;
      sub_step_id: string;
      status: string;
      updated_at: string;
      payload: string;
    }>;

    const ranking = plan.rankings.find(r => r.core_id === coreId);

    for (const row of rows) {
      const payload = JSON.parse(row.payload || "{}");
      allResults.push({
        _run_id: row.run_id,
        _step: (payload._step as string) || row.sub_step_id || "",
        _at: row.updated_at,
        core_rank: ranking?.rank ?? idx + 1,
        cos_similarity: ranking?.cos ?? 0,
        concepts: (payload.concepts as string[]) || [],
        _core_id: coreId,
        primitives: (payload.primitives as string[]) || [],
        payload,
      });
    }
  }

  return {
    results: allResults,
    matched: allResults.length,
    planner_trace: {
      search: req.search,
      method: plan.method,
      mode,
      threshold: ABS_THRESHOLD,
      candidates_above_threshold: plan.rankings.length,
      selected_core_ids: plan.coreIds,
      sort: sortDir,
    },
  };
}
