/**
 * Query Executor — 执行 DB 查询，返回原始数据。
 *
 * discover: runtime（task_state + YAML 拓扑）| compositions | big_step
 * query: payload（run_id 主键 / step_id 条件 + 四维筛选）
 */
import type Database from "better-sqlite3";
import type { ResolvedQuery } from "./intent-resolver.js";
import type {
  KnowQLResponse,
  DiscoverRuntimeStep,
  CompositionEntry,
  BigStepEntry,
  SubStepEntry,
} from "./types.js";

export interface TopologyData {
  compositions: CompositionEntry[];
  bigSteps: BigStepEntry[];
  subSteps: SubStepEntry[];
}

export function executeQuery(
  db: Database.Database,
  resolved: ResolvedQuery,
  topology: TopologyData,
): KnowQLResponse {
  if (resolved.mode === "discover") {
    return executeDiscover(resolved, topology, db);
  }
  return executePayloadQuery(resolved, db);
}

// ═══════════════════════════════════════════════════════════════
//  Discover
// ═══════════════════════════════════════════════════════════════

function executeDiscover(
  resolved: ResolvedQuery,
  topology: TopologyData,
  db: Database.Database,
): KnowQLResponse {
  switch (resolved.discoverMode) {
    case "compositions":
      return {
        compositions: topology.compositions,
        total: topology.compositions.length,
      };

    case "big_step": {
      const ref = resolved.ref ?? "";
      const bs = topology.bigSteps.find((b) => b.ref === ref);
      if (!bs) {
        return { error: `未找到 big_step: ${ref}`, hint: `使用 {\"discover\": \"compositions\"} 查看所有可用 workflow` };
      }
      const subs = topology.subSteps.filter(
        (ss) => (ss as unknown as { _big_step: string })._big_step === ref,
      );
      return {
        ref: bs.ref,
        name: bs.name,
        description: bs.description,
        sub_steps: subs,
      };
    }

    case "runtime":
    default:
      return executeDiscoverRuntime(resolved, topology, db);
  }
}

function executeDiscoverRuntime(
  resolved: ResolvedQuery,
  topology: TopologyData,
  db: Database.Database,
): KnowQLResponse {
  let sql = `SELECT step_id, run_id, status, updated_at FROM task_state WHERE 1=1`;
  const params: unknown[] = [];

  if (resolved._resolvedInstanceId) {
    sql += ` AND workflow_instance_id = ?`;
    params.push(resolved._resolvedInstanceId);
  }

  // 只返回已完成或中止的 step
  sql += ` AND status IN (${resolved.filters.status.map(() => "?").join(",")})`;
  params.push(...resolved.filters.status);

  sql += ` ORDER BY created_at ASC`;

  const rows = db.prepare(sql).all(...params) as Array<{
    step_id: string;
    run_id: string;
    status: string;
    updated_at: string | null;
  }>;

  // 构建 step_id → description 的查找表
  const descMap = new Map<string, string>();
  for (const ss of topology.subSteps) {
    descMap.set(ss.id, ss.description);
  }

  const steps: DiscoverRuntimeStep[] = rows.map((r) => ({
    step_id: r.step_id,
    run_id: r.run_id,
    status: r.status,
    description: descMap.get(r.step_id) ?? "",
    updated_at: r.updated_at,
  }));

  return {
    workflow_instance_id: resolved._resolvedInstanceId ?? 0,
    composition: resolved.composition,
    steps,
    total: steps.length,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Query Payload
// ═══════════════════════════════════════════════════════════════

function executePayloadQuery(
  resolved: ResolvedQuery,
  db: Database.Database,
): KnowQLResponse {
  // ── run_id 主键精确查询 ──
  if (resolved.run_id) {
    return executeRunIdLookup(resolved.run_id, db);
  }

  // ── step_id 条件查询 ──
  if (!resolved.step_id) {
    return { error: "query payload 需要 run_id 或 step_id", hint: "使用 {\"discover\": \"runtime\"} 查看可用 step" };
  }

  return executeStepIdQuery(resolved, db);
}

function executeRunIdLookup(
  runId: string,
  db: Database.Database,
): KnowQLResponse {
  const row = db.prepare(`SELECT * FROM task_state WHERE run_id = ?`)
    .get(runId) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      error: `未找到 run_id: ${runId}`,
      hint: "使用 {\"discover\": \"runtime\"} 查看当前 workflow 已完成的 step 及其 run_id",
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((row.payload as string) || "{}");
  } catch { /* ignore */ }

  return {
    run_id: (row.run_id as string) || runId,
    step_id: (row.step_id as string) || "",
    status: (row.status as string) || "",
    workflow_instance_id: (row.workflow_instance_id as number) || 0,
    updated_at: (row.updated_at as string) || null,
    payload,
  };
}

function executeStepIdQuery(
  resolved: ResolvedQuery,
  db: Database.Database,
): KnowQLResponse {
  const stepId = resolved.step_id!;
  const f = resolved.filters;

  let sql = `SELECT * FROM task_state WHERE step_id = ?`;
  const params: unknown[] = [stepId];

  // instance 隔离（仅当前 composition 内查询时）
  if (resolved._resolvedInstanceId) {
    sql += ` AND workflow_instance_id = ?`;
    params.push(resolved._resolvedInstanceId);
  }

  // 状态筛选
  if (f.status.length > 0) {
    sql += ` AND status IN (${f.status.map(() => "?").join(",")})`;
    params.push(...f.status);
  }

  // 时间筛选
  if (f.time && f.time !== "latest") {
    sql += ` AND date(updated_at) = ?`;
    params.push(f.time);
  }

  // 内容搜索
  if (f.contains) {
    sql += ` AND payload LIKE ?`;
    params.push(`%${f.contains}%`);
  }

  // 排序 + 限制
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(f.limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return {
    step_id: stepId,
    composition: resolved.composition !== (resolved as unknown as { _currentComposition?: string })._currentComposition
      ? resolved.composition : undefined,
    results: rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse((row.payload as string) || "{}");
      } catch { /* ignore */ }
      return {
        run_id: (row.run_id as string) || "",
        step_id: (row.step_id as string) || stepId,
        status: (row.status as string) || "",
        workflow_instance_id: (row.workflow_instance_id as number) || 0,
        updated_at: (row.updated_at as string) || null,
        payload,
      };
    }),
    total: rows.length,
  };
}

