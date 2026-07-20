import { execSync } from "node:child_process";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Parse run_id / workflow / step_id from a structured sessionKey.
 *
 * sessionKey format (what we pass in agent.run):
 *   "openry:wf:{composition}:step:{sub_step_id}:run:{run_id}"
 *
 * OpenClaw prefixes it with "agent:{agentId}:" before storing, so we
 * parse from the rightmost colon-delimited fields.
 */
export function parseSessionKey(sessionKey?: string): {
  run_id: string;
  workflow: string;
  step_id: string;
} {
  const fallback = { run_id: "unknown", workflow: "unknown", step_id: "unknown" };
  if (!sessionKey) return fallback;

  // Expected suffix: "...:wf:{workflow}:step:{step_id}:run:{run_id}"
  const parts = sessionKey.split(":");
  const runIdx = parts.lastIndexOf("run");
  const stepIdx = parts.lastIndexOf("step");
  const wfIdx = parts.lastIndexOf("wf");

  if (runIdx === -1 || stepIdx === -1 || wfIdx === -1) return fallback;

  return {
    run_id: parts[runIdx + 1] ?? "unknown",
    workflow: parts[wfIdx + 1] ?? "unknown",
    step_id: parts[stepIdx + 1] ?? "unknown",
  };
}

export type OpenryRunParams = { command: string };

export async function openryRunExecute(
  params: OpenryRunParams,
  ctx: OpenClawPluginToolContext,
) {
  const { command } = params;
  if (!command?.trim()) {
    return { content: [{ type: "text" as const, text: "Error: command is required" }] };
  }

  const { run_id } = parseSessionKey(ctx.sessionKey);

  try {
    const result = execSync(`openry -c "${command.replace(/"/g, '\\"')}"`, {
      env: { ...process.env, OPENRY_RUN_ID: run_id },
      timeout: 300_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { content: [{ type: "text" as const, text: result }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `openry_run error: ${msg}` }] };
  }
}
