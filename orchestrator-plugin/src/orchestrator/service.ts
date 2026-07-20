/**
 * Orchestrator Service — Phase 2B 巡查循环入口。
 * 在 OpenClaw Plugin 中注册为后台长跑服务。
 */
import * as path from "node:path";
import * as os from "node:os";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { openDb, getDbPath } from "./db-client.js";
import { PatrolLoop, type PatrolConfig } from "./patrol.js";
import { setConfigDir } from "./yaml-loader.js";

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

  return {
    id: "openry-orchestrator",

    async start(ctx: OpenClawPluginServiceContext) {
      try {
        const openryDir = resolveOpenryDir(ctx);
        setConfigDir(openryDir);
        const dbPath = getDbPath(openryDir);
        console.log("[orchestrator-plugin] starting, db=", dbPath);
        const db = openDb(dbPath);

        // Resolve openclaw path (might not be in Gateway's minimal PATH)
        const openclawPath = process.env.OPENCLAW_BIN || "openclaw";

        const config: PatrolConfig = {
          maxWorkers: 3,
          patrolIntervalMs: 5000,
          zombieTimeoutMinutes: 30,
          graceShutdownSeconds: 10,
          openclawPath,
          agentId: "openry-worker",
        };

        patrol = new PatrolLoop(db, config);
        patrol.start();
        console.log("[orchestrator-plugin] Patrol STARTED (workers=" + config.maxWorkers + ")");
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
  };
}

