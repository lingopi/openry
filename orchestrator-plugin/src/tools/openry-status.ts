import { execSync } from "node:child_process";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { parseSessionKey } from "./openry-run.js";

export type OpenryStatusParams = {
  status: "completed" | "failed" | "cancelled" | "overflow";
  payload?: Record<string, unknown>;
};

export async function openryStatusExecute(
  params: OpenryStatusParams,
  ctx: OpenClawPluginToolContext,
) {
  const { status, payload } = params;
  const { run_id } = parseSessionKey(ctx.sessionKey);

  const payloadJson = payload ? JSON.stringify(payload) : "{}";

  try {
    // Delegate to openry CLI — it handles DB writes (Phase 1 already implemented)
    const result = execSync(
      `openry --status ${status} --payload '${payloadJson.replace(/'/g, "'\\''")}'`,
      {
        env: { ...process.env, OPENRY_RUN_ID: run_id },
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    return {
      content: [{ type: "text" as const, text: result.trim() || `Status updated: ${status}` }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `openry_status error: ${msg}` }] };
  }
}
