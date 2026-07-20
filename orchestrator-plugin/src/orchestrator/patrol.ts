/**
 * 巡查循环 — 通过 openclaw agent CLI 子进程调度 agent。
 * CLI 内部使用 Gateway WebSocket 协议（三次握手 + 双帧响应）。
 * 直接 WebSocket 方案见 design/phase2b-websocket-plan.md 和 gateway-client.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { WorkerPool } from "./worker-pool.js";
import { validateStep, type StepConfig } from "./validation.js";
import {
  loadBigStep,
  loadComposition,
  getSubStepConfig,
  getFirstSubStep,
  getNextSubStep,
  type BigStep,
  type SubStep,
} from "./yaml-loader.js";
import { buildSessionKey } from "./session-key.js";
import * as db from "./db-client.js";

export type PatrolConfig = {
  maxWorkers: number;
  patrolIntervalMs: number;
  zombieTimeoutMinutes: number;
  graceShutdownSeconds: number;
  openclawPath: string;
  agentId: string;
};

export class PatrolLoop {
  private pool: WorkerPool;
  private activeRuns = new Map<string, ChildProcess>();
  private db: Database.Database;
  private config: PatrolConfig;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(database: Database.Database, config: PatrolConfig) {
    this.db = database;
    this.config = config;
    this.pool = new WorkerPool(config.maxWorkers);
  }

  start(): void {
    this.running = true;
    this.cleanupOrphans();   // 启动时清理：reset 所有 in_progress → queued
    this.patrol();           // 立即跑一轮
    this.timer = setInterval(() => this.patrol(), this.config.patrolIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const [, proc] of this.activeRuns) {
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
    }
    setTimeout(() => {
      for (const [, proc] of this.activeRuns) {
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
      }
      this.activeRuns.clear();
    }, this.config.graceShutdownSeconds * 1000);
  }

  // ── 主巡查 ──────────────────────────────────────────────────

  private patrol(): void {
    if (!this.running) return;
    try {
      this.reapZombies();        // 1. 清理 activeRuns 中已退出的子进程
      this.checkTimeout();         // 2. 超时检测 → 软刹车
      this.checkMaxToolCalls();    // 3. max_tool_calls 超限检测
      this.dispatchQueued();       // 4. 调度 queued 任务
      this.checkZombies();         // 5. 僵死检测
      this.validateCompleted();    // 6. 验证 completed
      this.routeValidated();       // 7. 路由 validated
      this.hardKillCancelled();    // 8. 硬杀 cancelled
      this.handleOverflow();       // 9. overflow 处理
      this.recoverOverflow();      // 10. overflow 恢复
      this.retryFailed();          // 11. big_step 重试
    } catch (err) {
      console.error("[orchestrator-plugin] patrol error:", err);
    }
  }

  // ── 1. 清理 activeRuns 中已退出的子进程 ─────────────────────

  /**
   * 遍历 activeRuns，清理已退出但未从 Map 中移除的子进程引用。
   *
   * Node.js/libuv 会在子进程退出时自动调用 waitpid（不产生 OS 层僵尸），
   * 但 activeRuns Map 可能因异常路径残留已死进程的引用，导致：
   *   - WorkerPool slot 泄漏（release 未调用）
   *   - hardKillCancelled 等操作一个已死进程
   *
   * 本方法作为安全网：
   *   1. 优先检查 proc.exitCode（Node.js 同步字段，null=运行中，数字=已退出）
   *   2. 兜底用 process.kill(pid, 0) 检测进程存活（信号0不发送信号，仅检查存在性）
   */
  private reapZombies(): void {
    for (const [runId, proc] of this.activeRuns) {
      // exitCode !== null 表示进程已退出（Node.js 特性，同步可读）
      if (proc.exitCode !== null) {
        this.activeRuns.delete(runId);
        this.pool.release();
        continue;
      }
      // 兜底：用 signal 0 检测进程是否还活着
      if (proc.pid) {
        try {
          process.kill(proc.pid, 0);
        } catch {
          // 进程已死但 exitCode 尚未设置（竞态窗口）
          this.activeRuns.delete(runId);
          this.pool.release();
        }
      }
    }
  }

  // ── 启动时孤儿清理 ─────────────────────────────────────────

  /**
   * Orchestrator 启动时执行：将 DB 中所有 in_progress 任务重置为 queued。
   *
   * 与 Python 引擎 _cleanup_orphans() 逻辑一致，但简化了 PID 检测：
   * TS 插件的 activeRuns 在重启后必然为空（内存 Map），因此无需逐个检测
   * PID 是否存活——所有 in_progress 任务都是孤儿，统一重置。
   */
  private cleanupOrphans(): void {
    const orphans = db.queryOrphanTasks(this.db);
    if (orphans.length === 0) return;
    console.log(
      `[orchestrator-plugin] cleaning up ${orphans.length} orphaned in_progress task(s)`,
    );
    for (const { run_id } of orphans) {
      db.updateTaskStatus(this.db, run_id, "queued");
    }
  }

  // ── 2. 超时检测 ─────────────────────────────────────────────

  private checkTimeout(): void {
    const tasks = db.queryTimedOutTasks(this.db);
    for (const t of tasks) {
      db.setCancelRequested(this.db, t.run_id);
    }
  }

  // ── 3. max_tool_calls 超限 ──────────────────────────────────

  private checkMaxToolCalls(): void {
    const tasks = db.queryMaxToolCallsExceeded(this.db);
    for (const t of tasks) {
      const current = db.countToolCalls(this.db, t.run_id);
      if (current >= t.max_tool_calls) {
        db.updateTaskStatus(this.db, t.run_id, "failed");
        this.killRun(t.run_id);
      }
    }
  }

  // ── 4. 调度 queued ──────────────────────────────────────────

  private dispatchQueued(): void {
    const available = this.pool.available();
    if (available <= 0) return;

    const tasks = db.queryQueuedTasks(this.db, available);
    for (const task of tasks) {
      this.spawnAgentSession(task);
    }
  }

  private spawnAgentSession(task: Record<string, unknown>): void {
    const runId = task.run_id as string;
    const subStepId = (task.sub_step_id as string) || "";
    const workflow = (task.workflow as string) || "";
    const description = this.buildTaskDescription(task);
    const sessionKey = buildSessionKey(workflow, subStepId, runId);
    try {
      this.pool.acquire();
      const proc = spawn(this.config.openclawPath, [
        "agent", "--agent", this.config.agentId,
        "--session-key", sessionKey, "--message", description,
        "--json", "--timeout", "600",
      ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        PATH: [
          process.env.PATH || '/usr/bin:/bin',
          '/usr/local/bin',
          `${process.env.HOME}/bin`,
          `${process.env.HOME}/.local/bin`,     // pip --user + wrapper target
          '/opt/homebrew/bin',                  // Apple Silicon Homebrew
        ].join(':'),
      } });
      this.activeRuns.set(runId, proc);
      proc.on("close", (code) => {
        this.activeRuns.delete(runId); this.pool.release();
        if (code !== 0) db.updateTaskStatus(this.db, runId, "failed");
        console.log(`[orchestrator] run ${runId} completed (exit ${code})`);
      });
      proc.on("error", (err) => {
        this.activeRuns.delete(runId); this.pool.release();
        db.updateTaskStatus(this.db, runId, "failed");
      });
      db.updateTaskStatus(this.db, runId, "in_progress");
      console.log(`[orchestrator] dispatched run ${runId} (step=${subStepId})`);
    } catch (err) {
      this.pool.release();
    }
  }

  private buildTaskDescription(task: Record<string, unknown>): string {
    const subStepId = (task.sub_step_id as string) || "";
    const bigStepRef = (task.big_step_ref as string) || "";

    try {
      const bigStep = loadBigStep(bigStepRef);
      const subStep = getSubStepConfig(bigStep, subStepId);
      if (subStep?.description) {
        let desc = subStep.description;

        // If inherit_payload, prepend previous step's data
        if (subStep.inherit_payload) {
          const payloadStr = (task.payload as string) || "{}";
          try {
            const prevPayload = JSON.parse(payloadStr);
            if (Object.keys(prevPayload).length > 0) {
              desc = `Previous step results:\n${JSON.stringify(prevPayload, null, 2)}\n\n${desc}`;
            }
          } catch { /* ignore parse errors */ }
        }

        return desc;
      }
    } catch {
      // YAML not found, use default
    }

    return `Execute sub_step: ${subStepId}`;
  }

  // ── 5. 僵死检测 ─────────────────────────────────────────────

  private checkZombies(): void {
    const zombies = db.queryZombieTasks(this.db, this.config.zombieTimeoutMinutes);
    for (const task of zombies) {
      const runId = task.run_id as string;
      db.updateTaskStatus(this.db, runId, "queued");
      this.killRun(runId);
    }
  }

  // ── 6. 验证 completed ───────────────────────────────────────

  private validateCompleted(): void {
    const tasks = db.queryPendingValidations(this.db);
    for (const task of tasks) {
      const runId = task.run_id as string;
      const subStepId = (task.sub_step_id as string) || "";
      const bigStepRef = (task.big_step_ref as string) || "";

      let stepConfig: StepConfig = {};
      try {
        const bigStep = loadBigStep(bigStepRef);
        const ss = getSubStepConfig(bigStep, subStepId);
        if (ss) {
          stepConfig = {
            expect_payload: ss.expect_payload,
            payload_keys: ss.payload_keys,
            validation: ss.validation as StepConfig["validation"],
            on_validation_fail: ss.on_validation_fail,
          };
        }
      } catch {
        // no YAML config
      }

      // 无验证规则 → 自动通过
      if (
        !stepConfig.expect_payload &&
        !stepConfig.payload_keys?.length &&
        !stepConfig.validation?.length
      ) {
        db.updateTaskStatus(this.db, runId, "validated", { validation_status: "passed" });
        continue;
      }

      const { passed, reason } = validateStep(this.db, runId, stepConfig);
      if (passed) {
        db.updateTaskStatus(this.db, runId, "validated", { validation_status: "passed" });
      } else {
        const onFail = stepConfig.on_validation_fail ?? "retry_current";
        if (onFail === "retry_current") {
          db.updateTaskStatus(this.db, runId, "queued", { validation_status: "failed" });
        } else {
          db.updateTaskStatus(this.db, runId, "failed", { validation_status: "failed" });
        }
      }
    }
  }

  // ── 7. 路由 validated ───────────────────────────────────────

  private routeValidated(): void {
    const tasks = db.queryValidatedTasks(this.db);
    for (const task of tasks) {
      const runId = task.run_id as string;
      const subStepId = (task.sub_step_id as string) || "";
      const bigStepRef = (task.big_step_ref as string) || "";

      try {
        const bigStep = loadBigStep(bigStepRef);
        const ss = getSubStepConfig(bigStep, subStepId);

        if (!ss || ss.on_success === "done") {
          db.updateTaskStatus(this.db, runId, "done");
          this.advanceBigStep(task);
        } else {
          const nextStep = getNextSubStep(bigStep, ss.on_success ?? "done");
          if (nextStep) {
            this.enqueueNextSubStep(task, bigStep, nextStep);
          } else {
            db.updateTaskStatus(this.db, runId, "failed");
          }
        }
      } catch {
        db.updateTaskStatus(this.db, runId, "done");
      }
    }
  }

  private enqueueNextSubStep(
    task: Record<string, unknown>,
    bigStep: BigStep,
    nextStep: SubStep,
  ): void {
    const newRunId = randomUUID();

    // Payload 合并
    let currentPayload: Record<string, unknown> = {};
    try {
      currentPayload = JSON.parse((task.payload as string) || "{}");
    } catch { /* empty */ }

    const merged = nextStep.inherit_payload ? currentPayload : {};

    db.enqueueNextSubStep(this.db, {
      newRunId,
      workflow: (task.workflow as string) || "",
      bigStepRef: (task.big_step_ref as string) || "",
      subStepId: nextStep.id,
      stepId: nextStep.id,
      payload: JSON.stringify(merged),
      workflowInstanceId: (task.workflow_instance_id as number) || 0,
      maxToolCalls: nextStep.max_tool_calls ?? 0,
      maxRetries: bigStep.max_retries ?? 0,
      maxSubStepRetries: nextStep.max_sub_step_retries ?? 0,
      maxOutputTokens: nextStep.max_output_tokens ?? 0,
      onOutputOverflow: nextStep.on_output_overflow ?? "",
      onValidationFail: nextStep.on_validation_fail ?? "retry_current",
    });

    db.updateTaskStatus(this.db, task.run_id as string, "done");
  }

  private advanceBigStep(task: Record<string, unknown>): void {
    const wfId = task.workflow_instance_id as number;
    if (!wfId) return;
    // Simplified: mark workflow as completed for now
    const row = this.db
      .prepare("SELECT composition FROM workflow_instances WHERE id = ?")
      .get(wfId) as { composition: string } | undefined;

    if (!row) return;

    try {
      const comp = loadComposition(row.composition);
      const currentRef = (task.big_step_ref as string) || "";
      const steps = comp.big_steps;
      const idx = steps.findIndex((s) => s.ref === currentRef);

      if (idx >= 0 && idx < steps.length - 1 && steps[idx].on_success !== "done") {
        const nextRef = steps[idx].on_success ?? steps[idx + 1]?.ref;
        if (nextRef) {
          // Enqueue first sub_step of next big_step
          const bigStep = loadBigStep(nextRef);
          const firstSub = getFirstSubStep(bigStep);
          if (firstSub) {
            const newRunId = randomUUID();
            db.enqueueNextSubStep(this.db, {
              newRunId,
              workflow: comp.name,
              bigStepRef: nextRef,
              subStepId: firstSub.id,
              stepId: firstSub.id,
              payload: "{}",
              workflowInstanceId: wfId,
              maxToolCalls: firstSub.max_tool_calls ?? 0,
              maxRetries: bigStep.max_retries ?? 0,
              maxSubStepRetries: firstSub.max_sub_step_retries ?? 0,
              maxOutputTokens: firstSub.max_output_tokens ?? 0,
              onOutputOverflow: firstSub.on_output_overflow ?? "",
              onValidationFail: firstSub.on_validation_fail ?? "retry_current",
            });
            db.updateWorkflowInstanceCurrentStep(this.db, wfId, nextRef);
          }
        }
      } else {
        // Workflow complete
        this.db
          .prepare("UPDATE workflow_instances SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
          .run(wfId);
      }
    } catch {
      // composition not found
    }
  }

  // ── 8. 硬杀 cancelled ────────────────────────────────────────

  private hardKillCancelled(): void {
    const tasks = db.queryCancelledTasks(this.db);
    for (const task of tasks) {
      const runId = task.run_id as string;
      this.killRun(runId);
      db.updateTaskStatus(this.db, runId, "failed");
    }
  }

  // ── 9. overflow 处理 ─────────────────────────────────────────

  private handleOverflow(): void {
    const tasks = db.queryOverflowTasks(this.db);
    for (const task of tasks) {
      const runId = task.run_id as string;
      const bigStepRef = (task.big_step_ref as string) || "";
      const onOverflow = (task.on_output_overflow as string) || task.big_step_ref as string || "";

      if (!onOverflow) {
        // No overflow handler configured → mark failed
        db.updateTaskStatus(this.db, runId, "failed");
        this.killRun(runId);
        continue;
      }

      try {
        // Create a new workflow instance for the overflow handler
        const overflowRunId = randomUUID();
        const overflowRef = onOverflow;

        // Insert workflow instance for overflow
        this.db.prepare(
          `INSERT INTO workflow_instances (composition, status, current_big_step)
           VALUES ('overflow', 'running', ?)`,
        ).run(overflowRef);

        const overflowWfId = this.db.prepare(
          "SELECT last_insert_rowid() as id",
        ).get() as { id: number };

        // Enqueue overflow handler's first sub_step
        const bigStep = loadBigStep(overflowRef);
        const firstSub = getFirstSubStep(bigStep);
        if (firstSub) {
          db.enqueueNextSubStep(this.db, {
            newRunId: overflowRunId,
            workflow: "overflow",
            bigStepRef: overflowRef,
            subStepId: firstSub.id,
            stepId: firstSub.id,
            payload: JSON.stringify({
              original_run_id: runId,
              overflow_type: "output_overflow",
            }),
            workflowInstanceId: overflowWfId.id,
            maxToolCalls: firstSub.max_tool_calls ?? 0,
            maxRetries: bigStep.max_retries ?? 0,
            maxSubStepRetries: firstSub.max_sub_step_retries ?? 0,
            maxOutputTokens: firstSub.max_output_tokens ?? 0,
            onOutputOverflow: firstSub.on_output_overflow ?? "",
            onValidationFail: firstSub.on_validation_fail ?? "retry_current",
          });
        }

        // Mark original as overflowed with reference
        this.db.prepare(
          `UPDATE task_state
           SET overflow_workflow_id = ?, status = 'overflow_processing'
           WHERE run_id = ?`,
        ).run(overflowWfId.id, runId);

        this.killRun(runId);
      } catch (err) {
        console.error(`[orchestrator] overflow handler failed for ${runId}:`, err);
        db.updateTaskStatus(this.db, runId, "failed");
      }
    }
  }

  // ── 10. overflow 恢复 ───────────────────────────────────────

  private recoverOverflow(): void {
    // Check if overflow workflows have completed
    const overflowed = this.db
      .prepare(
        `SELECT run_id, overflow_workflow_id, big_step_ref, sub_step_id, workflow
         FROM task_state
         WHERE status = 'overflow_processing' AND overflow_workflow_id IS NOT NULL`,
      )
      .all() as Array<{
        run_id: string;
        overflow_workflow_id: number;
        big_step_ref: string;
        sub_step_id: string;
        workflow: string;
      }>;

    for (const task of overflowed) {
      // Check if the overflow workflow instance is completed
      const wf = this.db
        .prepare(
          "SELECT status FROM workflow_instances WHERE id = ?",
        )
        .get(task.overflow_workflow_id) as { status: string } | undefined;

      if (!wf || wf.status !== "completed") continue;

      // Overflow done — gather result from overflow's task_state payload
      const overflowPayload = this.db
        .prepare(
          "SELECT payload FROM task_state WHERE workflow_instance_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(task.overflow_workflow_id) as { payload: string } | undefined;

      // Re-enqueue the original sub_step with overflow summary
      const newRunId = randomUUID();

      db.enqueueNextSubStep(this.db, {
        newRunId,
        workflow: task.workflow,
        bigStepRef: task.big_step_ref,
        subStepId: task.sub_step_id,
        stepId: task.sub_step_id,
        payload: JSON.stringify({
          overflow_summary: overflowPayload?.payload
            ? JSON.parse(overflowPayload.payload)
            : {},
        }),
        workflowInstanceId: (task as unknown as Record<string, unknown>).workflow_instance_id as number || 0,
        maxToolCalls: 0,
        maxRetries: 0,
        maxSubStepRetries: 0,
        maxOutputTokens: 0,
        onOutputOverflow: "",
        onValidationFail: "retry_current",
      });

      // Mark original as done and update status
      this.db.prepare(
        `UPDATE task_state
         SET status = 'overflow_completed', updated_at = datetime('now')
         WHERE run_id = ?`,
      ).run(task.run_id);

      console.log(`[orchestrator] overflow recovered for ${task.run_id}, re-enqueued as ${newRunId}`);
    }
  }

  // ── 11. 重试 failed (big_step + sub_step 两级) ───────────────

  private retryFailed(): void {
    // Big-step level retry
    const tasks = db.queryFailedWithRetries(this.db);
    for (const task of tasks) {
      const runId = task.run_id as string;
      db.incrementBigStepRetry(this.db, runId);
      db.updateTaskStatus(this.db, runId, "queued");
    }

    // Sub-step level retry: on_failure=retry with remaining retries
    const subRetryTasks = this.db
      .prepare(
        `SELECT * FROM task_state
         WHERE status = 'failed'
           AND sub_step_retry_count < max_sub_step_retries
           AND max_sub_step_retries > 0`,
      )
      .all() as Array<Record<string, unknown>>;

    for (const task of subRetryTasks) {
      const runId = task.run_id as string;
      const current = (task.sub_step_retry_count as number) || 0;
      this.db.prepare(
        `UPDATE task_state
         SET sub_step_retry_count = ?,
             status = 'queued',
             updated_at = datetime('now')
         WHERE run_id = ?`,
      ).run(current + 1, runId);
    }
  }

  // ── helpers ──────────────────────────────────────────────────

  private killRun(runId: string): void {
    const proc = this.activeRuns.get(runId);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
      this.activeRuns.delete(runId);
    }
  }
}
