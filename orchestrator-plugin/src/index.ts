import { execSync } from "node:child_process";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

// ── sessionKey parser ──────────────────────────────────────────

function parseSessionKey(sessionKey?: string) {
  const fallback = { run_id: "unknown", workflow: "unknown", step_id: "unknown", agent_id: "main" };
  if (!sessionKey) return fallback;
  // Format: agent:{agentId}:openry:wf:{workflow}:step:{subStepId}:run:{runId}
  const parts = sessionKey.split(":");
  const runIdx = parts.lastIndexOf("run");
  const stepIdx = parts.lastIndexOf("step");
  const wfIdx = parts.lastIndexOf("wf");
  const agentIdx = parts.indexOf("agent");
  if (runIdx === -1 || stepIdx === -1 || wfIdx === -1) return fallback;
  return {
    run_id: parts[runIdx + 1] ?? "unknown",
    workflow: parts[wfIdx + 1] ?? "unknown",
    step_id: parts[stepIdx + 1] ?? "unknown",
    agent_id: (agentIdx >= 0 ? parts[agentIdx + 1] : "main") ?? "main",
  };
}

// ── constants ──────────────────────────────────────────────────

// Use "openry" from PATH; users install openry via pip which puts it on PATH.
const OPENRY_CLI = "openry";

function buildPath(): string {
  const home = process.env.HOME || "";
  const parts = [
    process.env.PATH || "/usr/bin:/bin",
    "/usr/local/bin",
    home ? `${home}/bin` : "",
    home ? `${home}/.local/bin` : "",
    "/opt/homebrew/bin",
  ].filter(Boolean);
  return parts.join(":");
}

function escapeShell(cmd: string): string {
  return cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── trusted policy ─────────────────────────────────────────────

import { evaluateOpenryExecGate } from "./tools/trusted-policy.js";

// ── Phase 3c: command policy ──────────────────────────────────

import { resolvePolicy, evaluatePolicy } from "./orchestrator/command-policy.js";
import {
  ensureCommandLogColumns,
  insertRejectedCommand,
} from "./orchestrator/db-client.js";

/** 从 DB 读取当前 run 的 sub_step 配置，加载其 command_policy */
function loadCommandPolicyForRun(runId: string) {
  if (runId === "unknown") return null;
  try {
    const basePath = process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry");
    const db = openDb(getDbPath(basePath));
    const row = db
      .prepare("SELECT big_step_ref, sub_step_id FROM task_state WHERE run_id = ?")
      .get(runId) as { big_step_ref: string; sub_step_id: string } | undefined;
    db.close();

    if (!row?.big_step_ref || !row?.sub_step_id) return null;

    const bigStep = loadBigStep(row.big_step_ref);
    const subStep = getSubStepConfig(bigStep, row.sub_step_id);
    if (!subStep) return null;

    return resolvePolicy(subStep.command_policy ?? null);
  } catch {
    return null;
  }
}

// ── KnowQL ────────────────────────────────────────────────────

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { openDb, getDbPath, getWorkflowInstanceId, getCompositionForRun } from "./orchestrator/db-client.js";
import { validateRequest, resetQueryCounter } from "./orchestrator/knowql/ast-validator.js";
import { resolveQuery } from "./orchestrator/knowql/intent-resolver.js";
import { executeQuery, type TopologyData } from "./orchestrator/knowql/query-executor.js";
import { buildResponse, buildErrorResponse } from "./orchestrator/knowql/response-builder.js";
import { loadComposition, loadBigStep, getSubStepConfig } from "./orchestrator/yaml-loader.js";

// ── service ────────────────────────────────────────────────────

import { createOrchestratorService } from "./orchestrator/service.js";

// ── plugin entry ───────────────────────────────────────────────

const plugin = {
  id: "orchestrator-plugin" as const,
  name: "OpenRY Orchestrator",
  description:
    "OpenRY workflow orchestration: openry_run (command execution) and openry_status (state declaration) tools for OpenClaw agents.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    // ── openry_run ──
    api.registerTool((ctx: OpenClawPluginToolContext) => {
      const { run_id, workflow, step_id, agent_id } = parseSessionKey(ctx.sessionKey);
      const sessionKey = ctx.sessionKey || "";

      return {
        name: "openry_run",
        label: "OpenRY Run",
        description:
          "Execute a shell command via the OpenRY command forwarder. " +
          "Use this for ALL shell operations. Returns command output.",
        parameters: Type.Object({
          command: Type.String({
            description: "The shell command to execute.",
          }),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { command } = params as { command: string };
          if (!command?.trim()) {
            return textResult("Error: command is required", null);
          }

          // ── Phase 3c: command policy check ──
          const policy = loadCommandPolicyForRun(run_id);
          if (policy) {
            const result = evaluatePolicy(command, policy);
            if (!result.allowed) {
              // Log rejected command to DB (best-effort, don't block on failure)
              try {
                const basePath = process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry");
                const db = openDb(getDbPath(basePath));
                ensureCommandLogColumns(db);
                insertRejectedCommand(db, {
                  runId: run_id,
                  command,
                  reason: result.reason ?? "unknown",
                  policyRule: result.rule ?? "policy",
                });
                db.close();
              } catch { /* DB write failure is non-fatal */ }
              return textResult(
                `⛔ 命令被策略拒绝: ${result.reason}`,
                null,
              );
            }
          }
          // ── end Phase 3c ──

          try {
            const execEnv = {
              ...process.env,
              PATH: buildPath(),
              OPENRY_RUN_ID: run_id,
              OPENRY_WORKFLOW: workflow,
              OPENRY_STEP_ID: step_id,
              OPENRY_AGENT_ID: agent_id,
              OPENRY_SESSION_KEY: sessionKey,
            };
            const stdout = execSync(
              `${OPENRY_CLI} -c "${escapeShell(command)}"`,
              {
                env: execEnv,
                timeout: 300_000,
                encoding: "utf-8",
                maxBuffer: 10 * 1024 * 1024,
              },
            );
            return textResult(stdout, null);
          } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string; message?: string };
            const detail = (execErr.stdout || execErr.stderr || execErr.message || String(err)).trim();
            return textResult(detail || `openry_run error: ${String(err)}`, null);
          }
        },
      };
    });

    // ── openry_status ──
    api.registerTool((ctx: OpenClawPluginToolContext) => {
      const { run_id, workflow, step_id, agent_id } = parseSessionKey(ctx.sessionKey);
      const sessionKey = ctx.sessionKey || "";

      return {
        name: "openry_status",
        label: "OpenRY Status",
        description:
          "Declare the current sub-step status. " +
          "Call this when you have completed the task or cannot continue. " +
          "For 'completed', include a payload with the required result data.",
        parameters: Type.Object({
          status: Type.Union([
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("cancelled"),
            Type.Literal("overflow"),
          ], {
            description:
              "Sub-step status: completed (success), failed (cannot proceed), " +
              "cancelled (received cancel request), overflow (output too large).",
          }),
          payload: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                "Result data for 'completed' status. JSON object with required keys.",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { status, payload } = params as {
            status: string;
            payload?: Record<string, unknown>;
          };
          const payloadJson = payload ? JSON.stringify(payload) : "{}";

          try {
            const execEnv = {
              ...process.env,
              PATH: buildPath(),
              OPENRY_RUN_ID: run_id,
              OPENRY_WORKFLOW: workflow,
              OPENRY_STEP_ID: step_id,
              OPENRY_AGENT_ID: agent_id,
              OPENRY_SESSION_KEY: sessionKey,
            };
            const stdout = execSync(
              `${OPENRY_CLI} --status ${status} --payload '${payloadJson.replace(/'/g, "'\\''")}'`,
              {
                env: execEnv,
                timeout: 10_000,
                encoding: "utf-8",
              },
            );
            return textResult(stdout.trim() || `Status updated: ${status}`, null);
          } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string; message?: string };
            const detail = (execErr.stdout || execErr.stderr || execErr.message || String(err)).trim();
            return textResult(detail || `openry_status error: ${String(err)}`, null);
          }
        },
      };
    });

    // ── openry_payload_query (KnowQL) ──
    api.registerTool((ctx: OpenClawPluginToolContext) => {
      const { run_id } = parseSessionKey(ctx.sessionKey);

      return {
        name: "openry_payload_query",
        label: "OpenRY Payload Query (KnowQL)",
        description:
          "Query historical step payload data along the knowledge graph. " +
          "Use this to discover what previous steps produced and retrieve their full payloads.\n\n" +
          "=== Discover ===\n" +
          '{"discover":"runtime"} — list completed steps in current workflow (returns step_id + run_id + description)\n' +
          '{"discover":"compositions"} — list all available workflow compositions\n' +
          '{"discover":"big_step","ref":"<ref>"} — view sub-steps of a specific big_step\n\n' +
          "=== Query Payload ===\n" +
          '{"query":"payload","run_id":"<uuid>"} — exact lookup by run_id (preferred, from discover runtime)\n' +
          '{"query":"payload","step_id":"<id>","composition":"<name>"} — conditional query (cross-composition)\n' +
          '  Optional filters: time ("latest" or date), status (default done/abort), limit (default 3), contains (text search)\n\n' +
          "=== Flow ===\n" +
          "1. discover runtime → see completed steps + their run_ids\n" +
          "2. query payload with run_id → get full payload",
        parameters: Type.Object({
          query: Type.Record(Type.String(), Type.Unknown(), {
            description:
              "KnowQL query object with discover or query field.",
          }),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const { query } = params as { query: unknown };

          try {
            // ① Read YAML scope config for current step
            let yamlScope: Record<string, unknown> | undefined;
            try {
              const dbPath = getDbPath(process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry"));
              const db = openDb(dbPath);
              const row = db.prepare(
                "SELECT big_step_ref, sub_step_id FROM task_state WHERE run_id = ?"
              ).get(run_id) as { big_step_ref: string; sub_step_id: string } | undefined;
              if (row) {
                const bigStep = loadBigStep(row.big_step_ref);
                const subStep = getSubStepConfig(bigStep, row.sub_step_id);
                if (subStep?.payload_query_scope) {
                  yamlScope = subStep.payload_query_scope as unknown as Record<string, unknown>;
                }
              }
              db.close();
            } catch { /* YAML unavailable, use defaults */ }

            // ② Validate request (with YAML scope if available)
            const validated = validateRequest(query, {
              sessionKey: ctx.sessionKey,
              scope: yamlScope as any,
            });

            // ③ Open DB and resolve runtime context
            const basePath = process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry");
            const dbPath2 = getDbPath(basePath);
            const db2 = openDb(dbPath2);

            let workflowInstanceId: number | null = null;
            let composition: string | null = null;

            if (run_id !== "unknown") {
              workflowInstanceId = getWorkflowInstanceId(db2, run_id);
              composition = getCompositionForRun(db2, run_id);
            }

            if (!workflowInstanceId) {
              db2.close();
              return textResult(
                buildErrorResponse("无法确定当前 workflow instance", "请确保在 OpenRY step 上下文中调用此工具"),
                null,
              );
            }

            // ④ Resolve query with runtime context
            const resolved = resolveQuery(validated as any, {
              currentWorkflowInstanceId: workflowInstanceId,
              currentComposition: composition ?? "unknown",
            });

            // ⑤ Build topology from YAML
            const topology = buildTopology(basePath);

            // ⑥ Execute
            const result = executeQuery(db2, resolved, topology);

            db2.close();

            return textResult(buildResponse(result), null);
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "KnowQLValidationError") {
              return textResult(buildErrorResponse(err.message), null);
            }
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(buildErrorResponse(`查询执行失败: ${msg}`), null);
          }
        },
      };
    });

    // ── trusted tool policy ──
    api.registerTrustedToolPolicy({
      id: "openry-exec-gate",
      description:
        "Blocks all non-openry tool calls in OpenRY worker sessions. " +
        "All operations must go through openry_run for audit logging and policy enforcement.",
      evaluate: evaluateOpenryExecGate,
    });

    // ── orchestrator service ──
    api.registerService(createOrchestratorService());
  },
};

export default definePluginEntry(plugin) as ReturnType<typeof definePluginEntry>;

// ── KnowQL topology helpers ─────────────────────────────────────

function buildTopology(basePath: string): TopologyData {
  const compositions: import("./orchestrator/knowql/types.js").CompositionEntry[] = [];
  const bigSteps: import("./orchestrator/knowql/types.js").BigStepEntry[] = [];
  const subSteps: import("./orchestrator/knowql/types.js").SubStepEntry[] = [];

  // Big Steps (workflows) — load first so composition builds can reference descriptions
  const wfDir = path.join(basePath, "workflows");
  const bigStepDescMap = new Map<string, string>();
  if (fs.existsSync(wfDir)) {
    for (const file of fs.readdirSync(wfDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const ref = file.replace(/\.(yaml|yml)$/, "");
      try {
        const bigStep = loadBigStep(ref);
        bigStepDescMap.set(ref, bigStep.description ?? "");
        bigSteps.push({
          ref,
          name: bigStep.name ?? ref,
          description: bigStep.description ?? "",
          sub_step_ids: bigStep.sub_steps.map((ss) => ss.id),
        } as import("./orchestrator/knowql/types.js").BigStepEntry);
        // Sub-steps
        for (const ss of bigStep.sub_steps) {
          subSteps.push({
            id: ss.id,
            kind: ss.kind ?? "agent",
            description: ss.description ?? "",
            _big_step: ref,
          } as any);
        }
      } catch {
        bigSteps.push({ ref, name: ref, description: "", sub_step_ids: [] } as any);
      }
    }
  }

  // Compositions — with big_step refs + descriptions
  const compDir = path.join(basePath, "compositions");
  if (fs.existsSync(compDir)) {
    for (const file of fs.readdirSync(compDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const name = file.replace(/\.(yaml|yml)$/, "");
      try {
        const comp = loadComposition(name);
        compositions.push({
          name,
          description: comp.description ?? "",
          big_steps: comp.big_steps.map((bs) => ({
            ref: bs.ref,
            description: bigStepDescMap.get(bs.ref) ?? "",
          })),
        });

        // Fix: 给属于当前 composition 的 big_step 标记 _composition
        for (const bs of comp.big_steps) {
          const entry = bigSteps.find((b) => b.ref === bs.ref);
          if (entry) {
            (entry as any)._composition = name;
          }
        }
      } catch {
        compositions.push({ name, description: "", big_steps: [] });
      }
    }
  }

  return { compositions, bigSteps, subSteps };
}

// Keep old helpers for backwards compatibility
function listCompositions(basePath: string): string[] {
  const compDir = path.join(basePath, "compositions");
  if (!fs.existsSync(compDir)) return [];
  return fs.readdirSync(compDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.(yaml|yml)$/, ""));
}

function buildBigStepMap(basePath: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const compDir = path.join(basePath, "compositions");
  if (!fs.existsSync(compDir)) return map;
  for (const file of fs.readdirSync(compDir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const compName = file.replace(/\.(yaml|yml)$/, "");
    try {
      const comp = loadComposition(compName);
      map.set(compName, comp.big_steps.map((bs) => bs.ref));
    } catch { map.set(compName, []); }
  }
  return map;
}

function buildSubStepMap(basePath: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const wfDir = path.join(basePath, "workflows");
  if (!fs.existsSync(wfDir)) return map;
  for (const file of fs.readdirSync(wfDir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const ref = file.replace(/\.(yaml|yml)$/, "");
    try {
      const bigStep = loadBigStep(ref);
      map.set(ref, bigStep.sub_steps.map((ss) => ss.id));
    } catch { map.set(ref, []); }
  }
  return map;
}
