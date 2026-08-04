/**
 * SQLite 客户端 — 封装对 openry.db 的读写操作。
 * 查询逻辑与 Python openry/db.py 完全一致。
 */
import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";

export function getDbPath(basePath: string): string {
  return path.join(basePath, "openry.db");
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

// ── Queries ────────────────────────────────────────────────────

export function queryQueuedTasks(
  db: Database.Database,
  limit: number,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM task_state
       WHERE status = 'queued'
         AND (
           json_extract(payload, '$._compressed') IS NULL
           OR json_extract(payload, '$._compressed') = 1
           OR json_extract(payload, '$._compressed') = 'true'
         )
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}

export function queryTimedOutTasks(
  db: Database.Database,
): Array<{ run_id: string }> {
  return db
    .prepare(
      `SELECT ts.run_id
       FROM task_state ts
       JOIN workflow_instances wi ON ts.workflow_instance_id = wi.id
       WHERE ts.status = 'in_progress'
         AND wi.big_step_started_at IS NOT NULL
         AND wi.timeout_minutes IS NOT NULL
         AND wi.big_step_started_at < datetime('now', '-' || wi.timeout_minutes || ' minutes')`,
    )
    .all() as Array<{ run_id: string }>;
}

export function queryMaxToolCallsExceeded(
  db: Database.Database,
): Array<{ run_id: string; max_tool_calls: number }> {
  return db
    .prepare(
      `SELECT run_id, max_tool_calls FROM task_state
       WHERE status = 'in_progress' AND max_tool_calls > 0`,
    )
    .all() as Array<{ run_id: string; max_tool_calls: number }>;
}

export function countToolCalls(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM commands_log WHERE run_id = ?")
    .get(runId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function countInProgress(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM task_state WHERE status = 'in_progress'")
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function queryZombieTasks(
  db: Database.Database,
  zombieMinutes: number,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM task_state
       WHERE status = 'in_progress'
         AND updated_at < datetime('now', '-' || ? || ' minutes')`,
    )
    .all(String(zombieMinutes)) as Array<Record<string, unknown>>;
}

export function queryPendingValidations(
  db: Database.Database,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM task_state
       WHERE status = 'completed' AND validation_status = 'pending'`,
    )
    .all() as Array<Record<string, unknown>>;
}

export function queryValidatedTasks(
  db: Database.Database,
): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM task_state WHERE status = 'validated'")
    .all() as Array<Record<string, unknown>>;
}

export function queryCancelledTasks(
  db: Database.Database,
): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM task_state WHERE status = 'cancelled'")
    .all() as Array<Record<string, unknown>>;
}

export function queryFailedWithRetries(
  db: Database.Database,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM task_state
       WHERE status = 'failed'
         AND big_step_retry_count < max_retries`,
    )
    .all() as Array<Record<string, unknown>>;
}

export function queryOverflowTasks(
  db: Database.Database,
): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM task_state WHERE status = 'overflow'")
    .all() as Array<Record<string, unknown>>;
}

export function queryOrphanTasks(
  db: Database.Database,
): Array<{ run_id: string }> {
  return db
    .prepare("SELECT run_id FROM task_state WHERE status = 'in_progress'")
    .all() as Array<{ run_id: string }>;
}

// ── Mutations ──────────────────────────────────────────────────

export function setCancelRequested(db: Database.Database, runId: string): void {
  db.prepare(
    `UPDATE task_state
     SET cancel_requested = 1, updated_at = datetime('now')
     WHERE run_id = ?`,
  ).run(runId);
}

export function updateTaskStatus(
  db: Database.Database,
  runId: string,
  status: string,
  extra?: { validation_status?: string },
): void {
  if (extra?.validation_status) {
    db.prepare(
      `UPDATE task_state
       SET status = ?, validation_status = ?, updated_at = datetime('now')
       WHERE run_id = ?`,
    ).run(status, extra.validation_status, runId);
  } else {
    db.prepare(
      `UPDATE task_state
       SET status = ?, updated_at = datetime('now')
       WHERE run_id = ?`,
    ).run(status, runId);
  }
}

export function incrementBigStepRetry(
  db: Database.Database,
  runId: string,
): void {
  db.prepare(
    `UPDATE task_state
     SET big_step_retry_count = big_step_retry_count + 1,
         updated_at = datetime('now')
     WHERE run_id = ?`,
  ).run(runId);
}

export function enqueueNextSubStep(
  db: Database.Database,
  params: {
    newRunId: string;
    workflow: string;
    bigStepRef: string;
    subStepId: string;
    stepId: string;
    payload: string;
    workflowInstanceId: number;
    maxToolCalls: number;
    maxRetries: number;
    maxSubStepRetries: number;
    maxOutputTokens: number;
    onOutputOverflow: string;
    onValidationFail: string;
    commandPolicyJson?: string;
  },
): void {
  db.prepare(
    `INSERT INTO task_state
     (run_id, workflow, step_id, big_step_ref, sub_step_id,
      status, payload, workflow_instance_id, max_tool_calls,
      max_retries, max_sub_step_retries, max_output_tokens,
      on_output_overflow, on_validation_fail, command_policy_json)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.newRunId,
    params.workflow,
    params.stepId,
    params.bigStepRef,
    params.subStepId,
    params.payload,
    params.workflowInstanceId,
    params.maxToolCalls,
    params.maxRetries,
    params.maxSubStepRetries,
    params.maxOutputTokens,
    params.onOutputOverflow,
    params.onValidationFail,
    params.commandPolicyJson ?? null,
  );
}

export function getCommandsHistory(
  db: Database.Database,
  runId: string,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT command, exit_code, stdout, stderr, duration_ms, timestamp
       FROM commands_log WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
}

// ── Phase 3c: commands_log schema extension + rejected command logging ─

/**
 * 确保 commands_log 表包含 3c 新增列（幂等）。
 * 在 Plugin 启动时调用一次。
 */
export function ensureCommandLogColumns(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(commands_log)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("status")) {
    db.exec("ALTER TABLE commands_log ADD COLUMN status TEXT DEFAULT 'executed'");
  }
  if (!colNames.has("reject_reason")) {
    db.exec("ALTER TABLE commands_log ADD COLUMN reject_reason TEXT");
  }
  if (!colNames.has("policy_rule")) {
    db.exec("ALTER TABLE commands_log ADD COLUMN policy_rule TEXT");
  }
}

/**
 * 记录一条被策略拒绝的命令到 commands_log。
 * 与 Python CLI 的 insert_command() 独立，不冲突。
 */
export function insertRejectedCommand(
  db: Database.Database,
  params: {
    runId: string;
    command: string;
    reason: string;
    policyRule: string;
  },
): void {
  db.prepare(
    `INSERT INTO commands_log
     (run_id, command, shell, cwd, exit_code, stdout, stderr, duration_ms, status, reject_reason, policy_rule)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?)`,
  ).run(
    params.runId,
    params.command,
    "/bin/sh",
    process.cwd(),
    -1,
    "",
    params.reason,
    0,
    params.reason,
    params.policyRule,
  );
}

// ── Mutations (continued) ──────────────────────────────────────

export function updateWorkflowInstanceCurrentStep(
  db: Database.Database,
  workflowInstanceId: number,
  bigStepRef: string,
): void {
  db.prepare(
    `UPDATE workflow_instances
     SET current_big_step = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(bigStepRef, workflowInstanceId);
}

export function updateWorkflowInstanceStatus(
  db: Database.Database,
  workflowInstanceId: number,
  status: string,
): void {
  db.prepare(
    `UPDATE workflow_instances
     SET status = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, workflowInstanceId);
}

// ── Phase 3a: retry with budget ────────────────────────────────

export function retryOrFail(
  db: Database.Database,
  runId: string,
  maxRetries: number,
  reason: string,
): { retried: boolean; exhausted: boolean } {
  const row = db
    .prepare("SELECT sub_step_retry_count FROM task_state WHERE run_id = ?")
    .get(runId) as { sub_step_retry_count: number } | undefined;

  const retryCount = row?.sub_step_retry_count ?? 0;

  if (retryCount + 1 >= maxRetries) {
    // Budget exhausted → permanently failed
    db.prepare(
      `UPDATE task_state
       SET status = 'failed', validation_status = 'failed', updated_at = datetime('now')
       WHERE run_id = ?`,
    ).run(runId);
    console.log(
      `[orchestrator-plugin] Phase 3a: ${runId} retry budget exhausted (${retryCount}/${maxRetries}): ${reason}`,
    );
    return { retried: false, exhausted: true };
  }

  // Retry: increment counter and re-enqueue
  const newCount = retryCount + 1;
  db.prepare(
    `UPDATE task_state
     SET status = 'queued', validation_status = 'failed',
         sub_step_retry_count = ?, updated_at = datetime('now')
     WHERE run_id = ?`,
  ).run(newCount, runId);
  console.log(
    `[orchestrator-plugin] Phase 3a: ${runId} retry ${newCount}/${maxRetries}: ${reason}`,
  );
  return { retried: true, exhausted: false };
}

// ── KnowQL: payload 查询辅助 ─────────────────────────────────────

/**
 * 从 run_id 反查 workflow_instance_id。
 * KnowQL 用此实现 instance="current" 的并发隔离。
 */
export function getWorkflowInstanceId(
  db: Database.Database,
  runId: string,
): number | null {
  const row = db
    .prepare("SELECT workflow_instance_id FROM task_state WHERE run_id = ?")
    .get(runId) as { workflow_instance_id: number | null } | undefined;
  return row?.workflow_instance_id ?? null;
}

/**
 * 从 run_id 反查 composition 名称。
 */
export function getCompositionForRun(
  db: Database.Database,
  runId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT wi.composition
       FROM task_state ts
       JOIN workflow_instances wi ON ts.workflow_instance_id = wi.id
       WHERE ts.run_id = ?`,
    )
    .get(runId) as { composition: string } | undefined;
  return row?.composition ?? null;
}

/**
 * 查询指定 step_id + workflow_instance_id 的 task_state 行。
 */
export function queryTaskByStepAndInstance(
  db: Database.Database,
  stepId: string,
  workflowInstanceId: number,
): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT * FROM task_state
       WHERE step_id = ? AND workflow_instance_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(stepId, workflowInstanceId) as Record<string, unknown> | undefined;
}

/**
 * 查询当前 workflow_instance 内已完成的 step 列表（用于 discover runtime）。
 */
export function queryCompletedSteps(
  db: Database.Database,
  workflowInstanceId: number,
  limit: number = 50,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT step_id, payload, status, completed_at
       FROM task_state
       WHERE workflow_instance_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(workflowInstanceId, limit) as Array<Record<string, unknown>>;
}

// ── Phase 3b: shell payload_from ─────────────────────────────

/**
 * 按 step_id + workflow_instance_id 查询已完成 step 的 payload。
 * 供 shell 模式的 payload_from 字段使用。
 */
export function getStepPayload(
  db: Database.Database,
  stepId: string,
  workflowInstanceId: number,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT payload FROM task_state
       WHERE sub_step_id = ? AND workflow_instance_id = ?
         AND status IN ('done', 'validated', 'completed')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(stepId, workflowInstanceId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Phase C: 语义蒸馏辅助查询 ──────────────────────────────────

/**
 * 查询 _compressed: false 的已完成/已验证 step（shell 产出，待蒸馏）。
 */
export function queryUncompressedTasks(
  db: Database.Database,
  limit: number,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT run_id, payload, sub_step_id, big_step_ref, workflow_instance_id
       FROM task_state
       WHERE status IN ('completed', 'validated', 'done')
         AND (json_extract(payload, '$._compressed') = 0
              OR json_extract(payload, '$._compressed') = 'false')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}

/**
 * 查找依赖指定 run_id 的 queued step（通过 _inherits_from_run_id）。
 */
export function queryDownstreamQueuedTasks(
  db: Database.Database,
  sourceRunId: string,
): Array<{ run_id: string }> {
  return db
    .prepare(
      `SELECT run_id FROM task_state
       WHERE status = 'queued'
         AND json_extract(payload, '$._inherits_from_run_id') = ?`,
    )
    .all(sourceRunId) as Array<{ run_id: string }>;
}

/**
 * Phase D: 查询 agent step 中有 concepts 但未归一化（缺 _core_id）的记录。
 * 用于 scanAndNormalizeAgentConcepts 巡逻步骤。
 */
export function queryAgentStepsNeedingNormalization(
  db: Database.Database,
  limit: number,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT run_id, payload FROM task_state
       WHERE status = 'done'
         AND run_id NOT LIKE 'compress-%'
         AND json_extract(payload, '$.concepts') IS NOT NULL
         AND (json_extract(payload, '$._core_id') IS NULL
              OR json_extract(payload, '$._core_id') = '')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}
