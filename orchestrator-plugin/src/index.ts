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

    // ── orchestrator service ──
    api.registerService(createOrchestratorService());
  },
};

export default definePluginEntry(plugin) as ReturnType<typeof definePluginEntry>;
