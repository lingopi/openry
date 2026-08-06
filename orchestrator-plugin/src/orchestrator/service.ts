/**
 * Orchestrator Service — Phase 2B 巡查循环入口。
 * 在 OpenClaw Plugin 中注册为后台长跑服务。
 */
import * as path from "node:path";
import * as os from "node:os";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { openDb, getDbPath, ensureCommandLogColumns } from "./db-client.js";
import { PatrolLoop, type PatrolConfig } from "./patrol.js";
/** Runtime config, populated by service start(). Read by index.ts for command timeout. */
export const orchestratorConfig = {
  commandTimeoutMs: 600_000,
};
import { setConfigDir } from "./yaml-loader.js";
/** Resolve plugin config from openclaw.json, with defaults */
function resolveOrchestratorConfig(ctx: OpenClawPluginServiceContext): {
  maxWorkers: number;
  patrolIntervalMs: number;
  zombieTimeoutMinutes: number;
  graceShutdownSeconds: number;
  commandTimeoutSeconds: number;
} {
  const defaults = {
    maxWorkers: 3,
    patrolIntervalMs: 5000,
    zombieTimeoutMinutes: 10,
    graceShutdownSeconds: 10,
    commandTimeoutSeconds: 600,
  };
  try {
    const cfg = ctx.config as Record<string, unknown>;
    const plugins = cfg["plugins"] as Record<string, unknown> | undefined;
    const entries = plugins?.["entries"] as Record<string, unknown> | undefined;
    const ours = entries?.["orchestrator-plugin"] as Record<string, unknown> | undefined;
    const ourCfg = ours?.["config"] as Record<string, unknown> | undefined;
    if (!ourCfg) return defaults;
    return {
      maxWorkers: typeof ourCfg["maxWorkers"] === "number" ? ourCfg["maxWorkers"] as number : defaults.maxWorkers,
      patrolIntervalMs: typeof ourCfg["patrolIntervalMs"] === "number" ? ourCfg["patrolIntervalMs"] as number : defaults.patrolIntervalMs,
      zombieTimeoutMinutes: typeof ourCfg["zombieTimeoutMinutes"] === "number" ? ourCfg["zombieTimeoutMinutes"] as number : defaults.zombieTimeoutMinutes,
      graceShutdownSeconds: typeof ourCfg["graceShutdownSeconds"] === "number" ? ourCfg["graceShutdownSeconds"] as number : defaults.graceShutdownSeconds,
      commandTimeoutSeconds: typeof ourCfg["commandTimeoutSeconds"] === "number" ? ourCfg["commandTimeoutSeconds"] as number : defaults.commandTimeoutSeconds,
    };
  } catch {
    return defaults;
  }
}

function resolveOpenryDir(ctx: OpenClawPluginServiceContext): string {
  // 1. OPENRY_HOME env var (explicit override)
  if (process.env.OPENRY_HOME) return process.env.OPENRY_HOME;

  // 2. Plugin config in openclaw.json
  try {
    const cfg = ctx.config as Record<string, unknown>;
    const plugins = cfg["plugins"] as Record<string, unknown> | undefined;
    const entries = plugins?.["entries"] as Record<string, unknown> | undefined;
    const ours = entries?.["orchestrator-plugin"] as Record<string, unknown> | undefined;
    const ourCfg = ours?.["config"] as Record<string, unknown> | undefined;
    if (typeof ourCfg?.["openryDir"] === "string") return ourCfg["openryDir"] as string;
  } catch { /* fall through */ }

  // 3. Default: ~/.openry
  return path.join(os.homedir(), ".openry");
}

export function createOrchestratorService() {
  let patrol: PatrolLoop | null = null;
  /** Exposed so index.ts can read commandTimeoutSeconds for openry_run */
  let _orchestratorConfig: ReturnType<typeof resolveOrchestratorConfig> | null = null;

  return {
    id: "openry-orchestrator",

    async start(ctx: OpenClawPluginServiceContext) {
      try {
        const openryDir = resolveOpenryDir(ctx);
        setConfigDir(openryDir);
        const dbPath = getDbPath(openryDir);
        console.log("[orchestrator-plugin] starting, db=", dbPath);
        const db = openDb(dbPath);

        // Phase 3c: ensure commands_log schema is up to date
        ensureCommandLogColumns(db);

        // Resolve openclaw path (might not be in Gateway's minimal PATH)
        const openclawPath = process.env.OPENCLAW_BIN || "openclaw";

        // Read config from openclaw.json plugin config
        const orchCfg = resolveOrchestratorConfig(ctx);
        _orchestratorConfig = orchCfg;
        orchestratorConfig.commandTimeoutMs = orchCfg.commandTimeoutSeconds * 1000;

        // Start patrol in CLI mode immediately — don't block Gateway startup
        const config: PatrolConfig = {
          maxWorkers: orchCfg.maxWorkers,
          patrolIntervalMs: orchCfg.patrolIntervalMs,
          zombieTimeoutMinutes: orchCfg.zombieTimeoutMinutes,
          graceShutdownSeconds: orchCfg.graceShutdownSeconds,
          openclawPath,
          agentId: "openry-worker",
        };
        patrol = new PatrolLoop(db, config);
        patrol.start();
        console.log("[orchestrator-plugin] Patrol STARTED (CLI spawn mode)");
      } catch (err) {
        console.log("[orchestrator-plugin] start FAILED:", err);
      }
    },

    async stop(_ctx: OpenClawPluginServiceContext) {
      if (patrol) {
        patrol.stop();
        patrol = null;
      }
      console.log("[orchestrator-plugin] Patrol stopped");
    },

    /** Get the resolved orchestrator config (e.g. commandTimeoutSeconds) */
    getConfig() {
      return _orchestratorConfig;
    },
  };
}

