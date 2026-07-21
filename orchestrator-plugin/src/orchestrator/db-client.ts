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
  },
): void {
  db.prepare(
    `INSERT INTO task_state
     (run_id, workflow, step_id, big_step_ref, sub_step_id,
      status, payload, workflow_instance_id, max_tool_calls,
      max_retries, max_sub_step_retries, max_output_tokens,
      on_output_overflow, on_validation_fail)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  if (retryCount >= maxRetries) {
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
