/**
 * YAML 加载器 —— 读取 workflows/ 和 compositions/ 配置。
 * 与 Python openry/orchestrator/yaml_loader.py 逻辑一致。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";

export type BigStep = {
  name: string;
  version?: string;
  description?: string;
  timeout_minutes?: number;
  max_retries?: number;
  sub_steps: SubStep[];
};

export type ValidationRoutingEntry = {
  when?: Record<string, unknown>;
  when_any?: Record<string, unknown>[];
  on_match?: string;
  on_mismatch?: string;
  on_mismatch_message?: string;
};

export type SubStep = {
  id: string;
  kind?: string;
  description?: string;
  on_success?: string;
  on_failure?: string;
  max_sub_step_retries?: number;
  max_tool_calls?: number;
  max_output_tokens?: number;
  expect_payload?: boolean;
  payload_keys?: string[];
  inherit_payload?: boolean;
  command_policy?: unknown;
  validation?: unknown[];
  on_validation_fail?: string;
  on_output_overflow?: string;
  // Phase 3a
  on_payload_missing?: string;
  validation_routing?: ValidationRoutingEntry[];
};

export type Composition = {
  name: string;
  version?: string;
  description?: string;
  concurrency?: { max_parallel_instances?: number };
  big_steps: Array<{ ref: string; on_success?: string; on_failure?: string }>;
};

let _configDir: string | null = null;

export function setConfigDir(dir: string): void {
  _configDir = dir;
}

function getConfigDir(): string {
  if (_configDir) return _configDir;
  // 1. OPENRY_HOME env
  if (process.env.OPENRY_HOME) return process.env.OPENRY_HOME;
  // 2. Default: ~/.openry
  return path.join(os.homedir(), ".openry");
}

export function loadBigStep(name: string): BigStep {
  const configDir = getConfigDir();
  const yamlPath = path.join(configDir, "workflows", `${name}.yaml`);
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Workflow not found: ${yamlPath}`);
  }
  return yaml.load(fs.readFileSync(yamlPath, "utf-8")) as BigStep;
}

export function loadComposition(name: string): Composition {
  const configDir = getConfigDir();
  const yamlPath = path.join(configDir, "compositions", `${name}.yaml`);
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Composition not found: ${yamlPath}`);
  }
  return yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Composition;
}

export function getSubStepConfig(
  bigStep: BigStep,
  subStepId: string,
): SubStep | undefined {
  return bigStep.sub_steps.find((s) => s.id === subStepId);
}

export function getFirstSubStep(bigStep: BigStep): SubStep | undefined {
  return bigStep.sub_steps[0];
}

export function getNextSubStep(
  bigStep: BigStep,
  route: string,
): SubStep | undefined {
  if (route === "done" || route === "abort") return undefined;
  return getSubStepConfig(bigStep, route);
}
