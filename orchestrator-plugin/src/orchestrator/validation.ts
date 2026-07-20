/**
 * 硬代码验证引擎 — 对 completed 的 sub_step 执行验证规则。
 *
 * 与 Python openry/orchestrator/validation.py 逻辑完全一致。
 */
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

export type ValidationRule =
  | { type: "payload_has_key"; key: string }
  | { type: "payload_value_matches"; key: string; regex: string }
  | { type: "payload_values_equal"; key_a: string; key_b: string }
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; contains: string }
  | { type: "command"; run: string }
  | { type: "command_output_contains"; run: string; contains: string }
  | { type: "db_query"; query: string };

export type StepConfig = {
  expect_payload?: boolean;
  payload_keys?: string[];
  validation?: ValidationRule[];
  on_validation_fail?: string;
};

export function validateStep(
  db: Database.Database,
  runId: string,
  stepConfig: StepConfig,
): { passed: boolean; reason: string } {
  const state = db
    .prepare("SELECT payload FROM task_state WHERE run_id = ?")
    .get(runId) as { payload: string } | undefined;

  let payload: Record<string, unknown> = {};
  if (state) {
    try {
      payload = JSON.parse(state.payload);
    } catch {
      // keep empty
    }
  }

  // 1. expect_payload check
  if (stepConfig.expect_payload && Object.keys(payload).length === 0) {
    logValidation(db, runId, "expect_payload", null, false, "no payload provided");
    return { passed: false, reason: "expect_payload=True but no payload provided" };
  }

  // 2. payload_keys check (implicit validation)
  for (const key of stepConfig.payload_keys ?? []) {
    if (!(key in payload)) {
      logValidation(db, runId, "payload_has_key", key, false, `missing key: ${key}`);
      return { passed: false, reason: `missing required payload key: ${key}` };
    }
  }

  // 3. Explicit validation rules
  for (const rule of stepConfig.validation ?? []) {
    const ruleParams = JSON.stringify(
      Object.fromEntries(Object.entries(rule).filter(([k]) => k !== "type")),
    );
    let passed = true;
    let reason = "";

    switch (rule.type) {
      case "payload_has_key":
        passed = rule.key in payload;
        reason = passed ? "" : `missing key: ${rule.key}`;
        break;

      case "payload_value_matches": {
        const val = String(payload[rule.key] ?? "");
        passed = new RegExp(rule.regex).test(val);
        reason = passed ? "" : `value mismatch: ${rule.key}=${val}`;
        break;
      }

      case "payload_values_equal":
        passed = payload[rule.key_a] === payload[rule.key_b];
        reason = passed
          ? ""
          : `values not equal: ${rule.key_a} != ${rule.key_b}`;
        break;

      case "file_exists":
        passed = fs.existsSync(rule.path);
        reason = passed ? "" : `file not found: ${rule.path}`;
        break;

      case "file_contains":
        if (!fs.existsSync(rule.path)) {
          passed = false;
          reason = `file not found: ${rule.path}`;
        } else {
          const content = fs.readFileSync(rule.path, "utf-8");
          passed = content.includes(rule.contains);
          reason = passed ? "" : `missing content: ${rule.contains}`;
        }
        break;

      case "command": {
        try {
          execSync(rule.run, { timeout: 60_000, encoding: "utf-8" });
          passed = true;
        } catch (err: unknown) {
          passed = false;
          const code =
            err && typeof err === "object" && "status" in err
              ? (err as { status: number }).status
              : "error";
          reason = `exit_code=${code}`;
        }
        break;
      }

      case "command_output_contains": {
        try {
          const output = execSync(rule.run, {
            timeout: 60_000,
            encoding: "utf-8",
          });
          passed = output.includes(rule.contains);
          reason = passed ? "" : `output missing: ${rule.contains}`;
        } catch {
          passed = false;
          reason = "command failed";
        }
        break;
      }

      case "db_query": {
        try {
          const row = db.prepare(rule.query).get();
          passed = row !== undefined;
          reason = passed ? "" : "db query returned no rows";
        } catch {
          passed = false;
          reason = "db query failed";
        }
        break;
      }

      default:
        passed = true;
    }

    logValidation(db, runId, rule.type, ruleParams, passed, reason);

    if (!passed) {
      return { passed: false, reason };
    }
  }

  return { passed: true, reason: "" };
}

function logValidation(
  db: Database.Database,
  runId: string,
  ruleType: string,
  ruleParams: string | null,
  passed: boolean,
  message: string,
): void {
  db.prepare(
    `INSERT INTO validation_results (run_id, rule_type, rule_params, passed, message)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, ruleType, ruleParams, passed ? 1 : 0, message);
}
