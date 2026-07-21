/**
 * Phase 3a: 条件路由引擎 — when / when_any 短路求值。
 *
 * 与 Python openry/orchestrator/router.py 逻辑完全一致。
 */
import Database from "better-sqlite3";
import type { ValidationRoutingEntry } from "./yaml-loader.js";
import { validateCondition, type ValidationRule } from "./validator.js";

// ── Types ──────────────────────────────────────────────────────

export type RoutingResult = {
  action: "route" | "fallthrough";
  target: string;
  message: string;
};

// ── Valid targets ──────────────────────────────────────────────

const VALID_TARGETS = new Set(["done", "abort", "retry_current", "continue"]);

function isValidTarget(t: string): boolean {
  if (VALID_TARGETS.has(t)) return true;
  return t !== "" && t != null;
}

// ── Build context ──────────────────────────────────────────────

function loadPayload(db: Database.Database, runId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT payload FROM task_state WHERE run_id = ?")
    .get(runId) as { payload: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.payload);
  } catch {
    return {};
  }
}

// ── Main entry ─────────────────────────────────────────────────

export async function evaluateRouting(
  db: Database.Database,
  runId: string,
  stepConfig: { on_success?: string; on_failure?: string; validation_routing?: ValidationRoutingEntry[] },
): Promise<RoutingResult> {
  const entries = stepConfig.validation_routing ?? [];
  if (entries.length === 0) {
    return { action: "fallthrough", target: "", message: "no validation_routing entries" };
  }

  const payload = loadPayload(db, runId);
  let errorCount = 0;

  for (const entry of entries) {
    const hasWhen = "when" in entry && entry.when;
    const hasWhenAny = "when_any" in entry && entry.when_any;

    if (!hasWhen && !hasWhenAny) {
      errorCount += 1;
      continue;
    }

    let result: RoutingResult;
    try {
      if (hasWhenAny) {
        result = await evaluateWhenAny(payload, entry);
      } else {
        result = await evaluateWhen(payload, entry);
      }
    } catch {
      errorCount += 1;
      continue;
    }

    if (result.action === "route") {
      if (result.target === "continue") continue; // internal pass signal
      return result; // real routing decision (mismatch or match → direct route)
    }
    // fallthrough → let Phase 2 handle
    return result;
  }

  if (errorCount === entries.length) {
    return { action: "fallthrough", target: "", message: "all validation_routing entries errored" };
  }

  const onSuccess = stepConfig.on_success ?? "done";
  return { action: "route", target: onSuccess, message: "all validation_routing entries passed" };
}

// ── Entry evaluators ───────────────────────────────────────────

function evaluateWhen(
  payload: Record<string, unknown>,
  entry: ValidationRoutingEntry,
): Promise<RoutingResult> {
  const condition = entry.when as ValidationRule;
  return validateCondition(payload, condition).then((result) => {
    if (result.passed) {
      const onMatch = entry.on_match ?? "continue";
      if (onMatch === "continue") {
        return { action: "route" as const, target: "continue", message: "condition passed, continue" };
      }
      if (isValidTarget(onMatch)) {
        return { action: "route" as const, target: onMatch, message: result.message || "condition passed" };
      }
      return { action: "fallthrough" as const, target: "", message: `unknown on_match target: ${onMatch}` };
    }

    const onMismatch = entry.on_mismatch ?? "abort";
    const msg = entry.on_mismatch_message ?? result.message;
    if (isValidTarget(onMismatch)) {
      return { action: "route" as const, target: onMismatch, message: msg };
    }
    return { action: "fallthrough" as const, target: "", message: `unknown on_mismatch target: ${onMismatch}` };
  });
}

async function evaluateWhenAny(
  payload: Record<string, unknown>,
  entry: ValidationRoutingEntry,
): Promise<RoutingResult> {
  const conditions = (entry.when_any ?? []) as ValidationRule[];
  if (conditions.length === 0) {
    const onMismatch = entry.on_mismatch ?? "abort";
    const msg = entry.on_mismatch_message ?? "empty when_any group";
    if (isValidTarget(onMismatch)) {
      return { action: "route", target: onMismatch, message: msg };
    }
    return { action: "fallthrough", target: "", message: `unknown on_mismatch target: ${onMismatch}` };
  }

  const errors: string[] = [];
  for (const condition of conditions) {
    try {
      const result = await validateCondition(payload, condition);
      if (result.passed) {
        // OR: first pass wins
        const onMatch = entry.on_match ?? "continue";
        if (onMatch === "continue") {
          return { action: "route", target: "continue", message: "when_any: condition passed" };
        }
        if (isValidTarget(onMatch)) {
          return { action: "route", target: onMatch, message: "when_any: condition passed" };
        }
        return { action: "fallthrough", target: "", message: `unknown on_match target: ${onMatch}` };
      }
      errors.push(result.message);
    } catch (err) {
      errors.push(String(err));
    }
  }

  // All conditions failed
  const onMismatch = entry.on_mismatch ?? "abort";
  const msg = entry.on_mismatch_message ?? `when_any: no conditions matched (${errors.join("; ")})`;
  if (isValidTarget(onMismatch)) {
    return { action: "route", target: onMismatch, message: msg };
  }
  return { action: "fallthrough", target: "", message: `unknown on_mismatch target: ${onMismatch}` };
}
