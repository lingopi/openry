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

// Phase 3b: prompt_blocks
export type PromptBlock =
  | { type: "text"; content: string; label?: string }
  | { type: "file"; path: string; label?: string };

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
  // Phase 3c: command_policy supports named presets, file references, or inline config
  command_policy?: string | CommandPolicyObject;
  validation?: unknown[];
  on_validation_fail?: string;
  on_output_overflow?: string;
  // Phase 3a
  on_payload_missing?: string;
  validation_routing?: ValidationRoutingEntry[];
  // Phase 3b: prompt_blocks
  prompt_blocks?: PromptBlock[];
  // Phase 3b: KnowQL
  allow_payload_query?: boolean;
  payload_query_scope?: {
    compositions?: string | string[];
    max_queries?: number;
    allow_search?: boolean;
    allowed_intents?: string[];
  };
  // Phase D: 语义蒸馏开关（默认 true，设为 false 则跳过 concepts 产出和聚类）
  semantic_reporting?: boolean;
  // Phase 3b: kind=shell
  command?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  overflow_strategy?: "truncate" | "workflow" | "fail";
  payload_keys_on_error?: "abort" | "fallback";
  payload_from?: string;
};

// ── Phase 3c: command_policy types ─────────────────────────────

export type CommandPolicyObject = {
  mode: "unrestricted" | "allowlist" | "blocklist";
  commands?: string[];
  patterns?: PatternRule[];
  params?: ParamRule[];
};

export type PatternRule = {
  regex: string;
  description: string;
};

export type ParamRule = {
  command: string;
  allowed_flags?: string[];
  blocked_flags?: string[];
  blocked_flag_patterns?: string[];
  allowed_subcommands?: string[];
  blocked_subcommands?: string[];
  allowed_scripts?: string[];
  blocked_scripts?: string[];
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
  // 搜索顺序：workflows/（用户自定义优先）→ system/（内置默认）
  const userPath = path.join(configDir, "workflows", `${name}.yaml`);
  const systemPath = path.join(configDir, "system", `${name}.yaml`);
  const yamlPath = fs.existsSync(userPath) ? userPath
    : fs.existsSync(systemPath) ? systemPath
    : userPath; // 都不存在时用 userPath，方便报错信息指向用户目录
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
  const comp = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Composition;

  // Phase 3b: 验证 step_id 在 composition 内全局唯一
  validateStepIdUniqueness(comp);

  return comp;
}

/**
 * 验证 composition 内所有 big_step 的 sub_step.id 全局唯一。
 * KnowQL 依赖此约束实现跨 big_step 直接用 step_id 定位。
 */
function validateStepIdUniqueness(comp: Composition): void {
  const seen = new Map<string, string>(); // step_id → big_step_ref
  for (const bs of comp.big_steps) {
    let bigStep: BigStep;
    try {
      bigStep = loadBigStep(bs.ref);
    } catch {
      continue; // 无法加载的 big_step 跳过（loadBigStep 会抛异常）
    }
    for (const ss of bigStep.sub_steps) {
      if (seen.has(ss.id)) {
        throw new Error(
          `Step ID "${ss.id}" 在 composition "${comp.name}" 中重复：` +
          `big_step "${seen.get(ss.id)}" 和 "${bs.ref}" 都定义了此 ID。` +
          `KnowQL 要求 composition 内 step_id 全局唯一。`,
        );
      }
      seen.set(ss.id, bs.ref);
    }
  }
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
