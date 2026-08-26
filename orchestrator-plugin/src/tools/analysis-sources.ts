/**
 * openry_analysis_sources — 失败取证工具（loop_analyze_failure 第一步自助调用）
 *
 * 设计定稿：loop-engineering/analysis-source-api.md
 * run_id 三层隐式解析链：
 *   ① ctx.sessionKey → 自己 run_id（复用 openry-run.ts 的 parseSessionKey）
 *   ② 自己 task_state.payload._inherits_from_run_id → 失败任务 run_id
 *   ③ 兜底：本实例 status IN ('retrieve','failed','dropped') 最近一行
 * 显式传参 run_id 也可（校验不过自动回落，resolved.fallback_used=true）。
 *
 * 数据源分界：verdict/transcript/trajectory_* 读 jsonl 文件；
 *             payload/commands_log 读 DB。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionKey } from "./openry-run.js";
import { openDb, getDbPath } from "../orchestrator/db-client.js";

// ── 常量 ──────────────────────────────────────────────────────

const SOURCE_ALIASES: Record<string, string> = {
  "0": "verdict",
  "1": "payload",
  "2": "commands_log",
  "3": "transcript",
  "4": "trajectory_dynamic",
};

/** auto 模式的装填顺序（L-1 → L0 → L1 → L2 → L3；L4 只手动点名） */
const AUTO_ORDER = ["verdict", "payload", "commands_log", "transcript", "trajectory_dynamic"];

const VALID_SOURCES = [...AUTO_ORDER, "trajectory_full"];

const VERDICT_KEYS = [
  "aborted", "externalAbort", "timedOut", "idleTimedOut",
  "timedOutDuringCompaction", "timedOutDuringToolExecution",
  "timedOutByRunBudget", "finalStatus", "status",
];

const MAX_HEAD_CMD = 300;   // commands_log stdout 截断长度
const MAX_HEAD_PAYLOAD = 300; // 相邻步 payload 截断长度
const MAX_TOOL_HEAD = 200;  // transcript 工具结果截断长度

// ── 参数类型 ──────────────────────────────────────────────────

export type AnalysisSourcesParams = {
  sources?: string[];
  budget_tokens?: number;
  run_id?: string;
};

// ── token 估算（启发式，见 analysis-source-ladder.md §5）─────

function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else other += 1;
  }
  return Math.ceil((cjk * 0.7 + other / 4) * 1.2);
}

function estimateTokensByBytes(bytes: number): number {
  return Math.ceil(bytes * 0.35);
}

// ── session 定位 ─────────────────────────────────────────────

function findSessionId(runId: string): string | null {
  const sessDir = path.join(
    os.homedir(), ".openclaw", "agents", "openry-worker", "sessions",
  );
  const indexPath = path.join(sessDir, "sessions.json");
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    for (const key of Object.keys(index)) {
      if (key.includes(`:run:${runId}`)) {
        const entry = index[key];
        return entry?.sessionId ?? null;
      }
    }
  } catch { /* index unreadable — treat as no session */ }
  return null;
}

// ── 各层级读取 ────────────────────────────────────────────────

type Verdict = Record<string, unknown> | null;

function readVerdict(sessionId: string): Verdict {
  const trPath = path.join(
    os.homedir(), ".openclaw", "agents", "openry-worker", "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
  if (!fs.existsSync(trPath)) return null;
  const verdict: Record<string, unknown> = {};
  try {
    for (const line of fs.readFileSync(trPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (["model.completed", "trace.artifacts", "session.ended"].includes(evt.type)) {
        const d = evt.data ?? {};
        for (const k of VERDICT_KEYS) {
          if (k in d) verdict[k] = d[k];
        }
      }
    }
  } catch { /* malformed trajectory — return partial */ }
  return Object.keys(verdict).length > 0 ? verdict : null;
}

function readTranscript(sessionId: string): { text: string; bytes: number } | null {
  const tsPath = path.join(
    os.homedir(), ".openclaw", "agents", "openry-worker", "sessions",
    `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(tsPath)) return null;
  const raw = fs.readFileSync(tsPath, "utf-8");
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type !== "message") continue;
      const msg = evt.message ?? {};
      const role = msg.role ?? "";
      if (role === "user") {
        parts.push(`[user] ${String(msg.content ?? "").slice(0, 4000)}`);
      } else if (role === "assistant") {
        const content = msg.content;
        if (typeof content === "string") {
          parts.push(`[assistant] ${content.slice(0, 4000)}`);
        } else if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const c of content) {
            if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
            else if (c?.type === "toolCall" && c?.name) {
              texts.push(`[toolCall ${c.name}] ${String(c.arguments ?? "").slice(0, MAX_TOOL_HEAD)}`);
            }
          }
          if (texts.length > 0) parts.push(`[assistant] ${texts.join("\n").slice(0, 4000)}`);
        }
      } else if (role === "toolResult") {
        const content = msg.content;
        let text = "";
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "text" && typeof c.text === "string") text += c.text;
          }
        } else if (typeof content === "string") {
          text = content;
        }
        if (text.trim()) parts.push(`[toolResult] ${text.slice(0, MAX_TOOL_HEAD)}`);
      }
    } catch { /* skip malformed line */ }
  }
  return { text: parts.join("\n"), bytes: Buffer.byteLength(raw, "utf-8") };
}

function readTrajectoryDynamic(sessionId: string): { text: string; bytes: number } | null {
  const trPath = path.join(
    os.homedir(), ".openclaw", "agents", "openry-worker", "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
  if (!fs.existsSync(trPath)) return null;
  const raw = fs.readFileSync(trPath, "utf-8");
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (["model.completed", "trace.artifacts", "session.ended"].includes(evt.type)) {
        lines.push(line);
      }
    } catch { /* skip */ }
  }
  const text = lines.join("\n");
  return { text, bytes: Buffer.byteLength(text, "utf-8") };
}

function readTrajectoryFull(sessionId: string): { text: string; bytes: number } | null {
  const trPath = path.join(
    os.homedir(), ".openclaw", "agents", "openry-worker", "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
  if (!fs.existsSync(trPath)) return null;
  const raw = fs.readFileSync(trPath, "utf-8");
  return { text: raw, bytes: Buffer.byteLength(raw, "utf-8") };
}

// ── DB 读取 ──────────────────────────────────────────────────

function readPayloadLayer(db: ReturnType<typeof openDb>, runId: string) {
  const row = db.prepare(
    `SELECT run_id, workflow, step_id, big_step_ref, status, validation_status,
            payload, workflow_instance_id, created_at, updated_at
     FROM task_state WHERE run_id = ?`,
  ).get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;

  let payloadParsed: unknown = {};
  try { payloadParsed = JSON.parse((row.payload as string) || "{}"); } catch { /* keep {} */ }

  const adjacent: Array<Record<string, unknown>> = [];
  const wfid = row.workflow_instance_id;
  if (typeof wfid === "number") {
    const rows = db.prepare(
      `SELECT run_id, step_id, status, payload, created_at
       FROM task_state WHERE workflow_instance_id = ? ORDER BY created_at`,
    ).all(wfid) as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.run_id);
    const idx = ids.indexOf(runId);
    if (idx >= 0) {
      for (const r of rows.slice(Math.max(0, idx - 1), idx + 2)) {
        if (r.run_id === runId) continue;
        adjacent.push({
          run_id: r.run_id,
          step_id: r.step_id,
          status: r.status,
          payload_head: String(r.payload ?? "").slice(0, MAX_HEAD_PAYLOAD),
          created_at: r.created_at,
        });
      }
    }
  }

  return {
    task_row: {
      run_id: row.run_id,
      workflow: row.workflow,
      step_id: row.step_id,
      big_step_ref: row.big_step_ref,
      status: row.status,
      validation_status: row.validation_status,
      payload: payloadParsed,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    adjacent_steps: adjacent,
  };
}

function readCommandsLayer(db: ReturnType<typeof openDb>, runId: string) {
  const agg = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(duration_ms),0) AS total_ms,
            COALESCE(SUM(length(stdout)),0) AS stdout_bytes
     FROM commands_log WHERE run_id = ?`,
  ).get(runId) as Record<string, unknown>;
  const entries = db.prepare(
    `SELECT command, exit_code, duration_ms, timeout, substr(stdout,1,?) AS stdout_head
     FROM commands_log WHERE run_id = ? ORDER BY id`,
  ).all(MAX_HEAD_CMD, runId) as Array<Record<string, unknown>>;
  return {
    aggregate: agg,
    headtail: [...entries.slice(0, 3), ...entries.slice(-3)],
  };
}

// ── 主执行 ────────────────────────────────────────────────────

export function analysisSourcesExecute(
  params: AnalysisSourcesParams,
  ctx: { sessionKey?: string },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return Promise.resolve().then(() => {
    const basePath = process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry");
    const db = openDb(getDbPath(basePath));
    try {
      const own = parseSessionKey(ctx.sessionKey);
      const ownRunId = own.run_id;
      let targetRunId: string | null = params.run_id?.trim() || null;
      let fallbackUsed = false;

      // ① 显式传参校验：查不到 → 回落
      if (targetRunId) {
        const exists = db.prepare("SELECT 1 FROM task_state WHERE run_id = ?").get(targetRunId);
        if (!exists) {
          targetRunId = null;
          fallbackUsed = true;
        }
      }

      // ② 隐式指针：自己 payload._inherits_from_run_id
      let ownWfId: number | null = null;
      if (!targetRunId && ownRunId !== "unknown") {
        const ownRow = db.prepare(
          "SELECT payload, workflow_instance_id FROM task_state WHERE run_id = ?",
        ).get(ownRunId) as { payload?: string; workflow_instance_id?: number } | undefined;
        ownWfId = ownRow?.workflow_instance_id ?? null;
        if (ownRow?.payload) {
          try {
            const p = JSON.parse(ownRow.payload);
            if (p._inherits_from_run_id) {
              targetRunId = String(p._inherits_from_run_id);
            }
          } catch { /* payload 非 JSON，走兜底 */ }
        }
      }

      // ③ 兜底：本实例 retrieve/failed/dropped 最近一行
      if (!targetRunId && ownWfId !== null) {
        const fb = db.prepare(
          `SELECT run_id FROM task_state
           WHERE workflow_instance_id = ? AND status IN ('retrieve','failed','dropped')
           ORDER BY updated_at DESC LIMIT 1`,
        ).get(ownWfId) as { run_id: string } | undefined;
        if (fb) {
          targetRunId = fb.run_id;
          fallbackUsed = true;
        }
      }

      if (!targetRunId) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "无法定位失败任务：显式 run_id 无效、指针缺失、且本实例无 retrieve/failed/dropped 行",
              hint: "确认当前 sub_step 配了 inherit_payload: true 且由 on_dropped 路由进入",
            }, null, 2),
          }],
        };
      }

      const sessionId = findSessionId(targetRunId);
      const view = fallbackUsed && !params.run_id ? "instance" : "single_step";

      // ── 层级内容预取（只取被请求的）──
      const requested = new Set<string>();
      const rawSources = params.sources && params.sources.length > 0 ? params.sources : ["auto"];
      for (const s of rawSources) {
        const name = SOURCE_ALIASES[s] ?? s;
        if (name === "auto") {
          for (const auto of AUTO_ORDER) requested.add(auto);
        } else if (VALID_SOURCES.includes(name)) {
          requested.add(name);
        }
      }

      const budget = typeof params.budget_tokens === "number" && params.budget_tokens > 0
        ? params.budget_tokens : 12000;

      const catalog: Array<Record<string, unknown>> = [];
      const data: Record<string, unknown> = {};
      const skipped: Array<Record<string, unknown>> = [];
      let verdict: Verdict = null;
      let spent = 0;

      const addSource = (name: string, content: unknown, tokens: number, bytes: number) => {
        if (spent + tokens > budget) {
          skipped.push({ source: name, reason: "budget", est_tokens: tokens });
          return;
        }
        spent += tokens;
        data[name] = content;
        catalog.push({ source: name, available: true, bytes, est_tokens: tokens });
      };

      // 预读 jsonl 相关（避免重复读文件）
      let transcriptRaw: { text: string; bytes: number } | null = null;
      let trajectoryDyn: { text: string; bytes: number } | null = null;
      if (sessionId) {
        if (requested.has("transcript")) transcriptRaw = readTranscript(sessionId);
        if (requested.has("trajectory_dynamic")) trajectoryDyn = readTrajectoryDynamic(sessionId);
      }

      // L-1 verdict：直接进顶层，不占 data
      if (requested.has("verdict")) {
        verdict = sessionId ? readVerdict(sessionId) : null;
        const text = JSON.stringify(verdict);
        catalog.push({ source: "verdict", available: verdict !== null, bytes: Buffer.byteLength(text), est_tokens: estimateTokens(text) });
        spent += estimateTokens(text);
      }

      // L0 payload
      if (requested.has("payload")) {
        const layer = readPayloadLayer(db, targetRunId);
        if (layer) {
          const text = JSON.stringify(layer);
          addSource("payload", layer, estimateTokens(text), Buffer.byteLength(text));
        } else {
          catalog.push({ source: "payload", available: false, bytes: 0, est_tokens: 0 });
        }
      }

      // L1 commands_log
      if (requested.has("commands_log")) {
        const layer = readCommandsLayer(db, targetRunId);
        const text = JSON.stringify(layer);
        addSource("commands_log", layer, estimateTokens(text), Buffer.byteLength(text));
      }

      // L2 transcript
      if (requested.has("transcript")) {
        if (transcriptRaw) {
          addSource("transcript", { text: transcriptRaw.text }, estimateTokens(transcriptRaw.text), transcriptRaw.bytes);
        } else {
          catalog.push({ source: "transcript", available: false, bytes: 0, est_tokens: 0 });
        }
      }

      // L3 trajectory_dynamic
      if (requested.has("trajectory_dynamic")) {
        if (trajectoryDyn) {
          addSource("trajectory_dynamic", { text: trajectoryDyn.text }, estimateTokens(trajectoryDyn.text), trajectoryDyn.bytes);
        } else {
          catalog.push({ source: "trajectory_dynamic", available: false, bytes: 0, est_tokens: 0 });
        }
      }

      // L4 trajectory_full（仅手动点名）
      if (requested.has("trajectory_full")) {
        if (sessionId) {
          const full = readTrajectoryFull(sessionId);
          if (full) addSource("trajectory_full", { text: full.text }, estimateTokens(full.text), full.bytes);
          else catalog.push({ source: "trajectory_full", available: false, bytes: 0, est_tokens: 0 });
        } else {
          catalog.push({ source: "trajectory_full", available: false, bytes: 0, est_tokens: 0 });
        }
      }

      const response = {
        resolved: {
          target_run_id: targetRunId,
          own_run_id: ownRunId,
          view,
          session_id: sessionId,
          fallback_used: fallbackUsed,
        },
        catalog,
        verdict,
        data,
        skipped,
        budget_tokens: budget,
        used_tokens: spent,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    } finally {
      db.close();
    }
  });
}
