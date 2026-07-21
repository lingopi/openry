/**
 * sessionKey 编解码 —— 将 run_id / workflow / step_id 编码到
 * OpenClaw sessionKey 中，或从其中解码。
 *
 * 格式：
 *   openry:wf:{composition}:step:{sub_step_id}:run:{run_id}
 *
 * OpenClaw 自动在前面加 agent:{agentId}: 前缀。
 */
export function parseSessionKey(sessionKey?: string): {
  run_id: string;
  workflow: string;
  step_id: string;
} {
  const fallback = { run_id: "unknown", workflow: "unknown", step_id: "unknown" };
  if (!sessionKey) return fallback;

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

export function buildSessionKey(
  workflow: string,
  stepId: string,
  runId: string,
  agentId?: string,
): string {
  const suffix = `openry:wf:${workflow}:step:${stepId}:run:${runId}`;
  // Include agent prefix so Gateway validates agentId correctly
  return agentId ? `agent:${agentId}:${suffix}` : suffix;
}
