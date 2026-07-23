/**
 * OpenRY Trusted Tool Policy — "openry-exec-gate"
 *
 * Registered as a Trusted Tool Policy in OpenClaw's tool execution pipeline.
 * This runs at the HIGHEST priority, before any before_tool_call hooks.
 *
 * Execution order:
 *   LLM tool call
 *     → ① Trusted Tool Policies（this file）
 *       → {allow: false} → immediately blocked, reason returned to LLM
 *     → ② before_tool_call Hooks
 *     → ③ execute() function
 *
 * Only "openry_run" and "openry_status" are allowed through.
 * All other tools — built-in, MCP-bridged, or third-party — are blocked.
 * This is enforced at call time, regardless of when the tool was registered.
 */

// ── Allowed tools ──────────────────────────────────────────────

const ALLOWED_TOOLS = new Set(["openry_run", "openry_status"]);

// ── Guidance messages for commonly intercepted tools ───────────

function buildGuidance(
  toolName: string,
  params: Record<string, unknown>,
): string {
  const filePath =
    typeof params.file_path === "string"
      ? params.file_path
      : typeof params.path === "string"
        ? params.path
        : "<path>";

  const guides: Record<string, string> = {
    // Command execution
    exec: "Use openry_run with the shell command directly.",
    process: "Use openry_run with the shell command directly.",
    bash: "Use openry_run with the shell command directly.",

    // File operations
    read: `Use openry_run with "cat ${filePath}" to read files.`,
    write: `Use openry_run with shell redirection to write to ${filePath}.`,
    edit: `Use openry_run with "sed -i" to edit files in-place.`,
    apply_patch: 'Use openry_run with "patch <patchfile>" to apply patches.',

    // Browser
    browser:
      "Use openry_run with the appropriate CLI command for browser operations.",

    // Search & memory
    memory_search:
      "Use openry_run with grep/find or the memory CLI for search operations.",
    web_search: "Use openry_run with curl to perform web searches.",
    web_fetch: "Use openry_run with 'curl -sL <url>' to fetch web content.",

    // Session management (not for workers)
    sessions_spawn: "Not available in OpenRY worker mode.",
    sessions_send: "Not available in OpenRY worker mode.",
    sessions_list: "Not available in OpenRY worker mode.",
    sessions_history: "Not available in OpenRY worker mode.",
    subagents: "Not available in OpenRY worker mode.",
    session_status: "Not available in OpenRY worker mode.",
    agents_list: "Not available in OpenRY worker mode.",

    // Gateway / cron
    gateway: "Not available in OpenRY worker mode.",
    cron: "Not available in OpenRY worker mode.",
  };

  return (
    guides[toolName] ??
    `Tool "${toolName}" is not available in this session. ` +
      'Use "openry_run" for ALL operations, then call "openry_status" when done.'
  );
}

// ── Entry point ────────────────────────────────────────────────

export async function evaluateOpenryExecGate(event: {
  toolName: string;
  params: Record<string, unknown>;
}): Promise<{ allow: false; reason: string } | undefined> {
  const { toolName, params } = event;

  if (ALLOWED_TOOLS.has(toolName)) {
    return undefined; // allow
  }

  return {
    allow: false,
    reason: buildGuidance(toolName, params),
  };
}
