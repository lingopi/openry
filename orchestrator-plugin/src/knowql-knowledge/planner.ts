/**
 * KnowQL Knowledge — Planner（向量匹配 + LLM 兜底）
 */

import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { embed, cosineSimilarity, blobToFloats } from "./embedder.js";
import type { ClusterRecord } from "./types.js";

// ── 常量 ────────────────────────────────────────────────────────

export const ABS_THRESHOLD = 0.75;   // 纯 BGE-M3 语义相似度阈值
const GAP_THRESHOLD = 0.05;

export interface PlanResult {
  /** 选中的 core_id 列表（mode=best 只有 1 个；expand 可能有多个） */
  coreIds: string[];
  /** 每个 core_id 的 cos 和排名 */
  rankings: Array<{ core_id: string; cos: number; rank: number }>;
  /** 判定方法 */
  method: "vector" | "llm";
}

/**
 * 规划查询：search → embedding → cos vs 全部 cluster → 选出 core_id(s)
 */
export async function planQuery(
  db: Database.Database,
  search: string,
  mode: "best" | "expand",
): Promise<PlanResult> {
  const queryVec = await embed(search);

  // 加载所有 cluster
  const rows = db.prepare(
    `SELECT core_id, centroid_embedding, display_labels FROM clusters`
  ).all() as Array<{ core_id: string; centroid_embedding: Buffer; display_labels: string }>;

  // 计算相似度并排序（纯 BGE-M3 语义向量）
  const scored = rows
    .map(row => {
      const labels = JSON.parse(row.display_labels) as string[];
      const cos = cosineSimilarity(queryVec, blobToFloats(row.centroid_embedding));
      return { core_id: row.core_id, cos, labels };
    })
    .filter(s => s.cos >= ABS_THRESHOLD)
    .sort((a, b) => b.cos - a.cos);

  if (scored.length === 0) {
    return { coreIds: [], rankings: [], method: "vector" };
  }

  // 判定是否需要 LLM
  let method: "vector" | "llm" = "vector";
  let selectedCoreIds: string[] = [];

  if (scored.length >= 2 && (scored[0].cos - scored[1].cos) < GAP_THRESHOLD) {
    // LLM 二选一消歧义
    method = "llm";
    const chosen = await llmDisambiguate(search, scored[0], scored[1]);
    selectedCoreIds = [chosen.core_id];
  } else {
    selectedCoreIds = [scored[0].core_id];
  }

  // mode=expand：取所有阈值以上的 core_id
  if (mode === "expand") {
    selectedCoreIds = scored.map(s => s.core_id);
  }

  const rankings = scored.map((s, i) => ({
    core_id: s.core_id,
    cos: s.cos,
    rank: i + 1,
  }));

  return { coreIds: selectedCoreIds, rankings, method };
}

// ── LLM 消歧义 ─────────────────────────────────────────────────

interface Candidate {
  core_id: string;
  cos: number;
  labels: string[];
}

/**
 * 当 #1 和 #2 的 cos 差距 < 0.05 时，调用 LLM 做二选一。
 *
 * 使用 openclaw agent CLI 做一次性简短推理（与蒸馏 agent 同模式）。
 * 整个调用链：嵌入向量选不出 → LLM 读 labels 语义 → 返回选择。
 */
async function llmDisambiguate(
  search: string,
  a: Candidate,
  b: Candidate,
): Promise<Candidate> {
  const prompt = [
    "You are a concept classifier. Given a search query and two concept clusters,",
    "choose the one that BEST matches the semantic intent of the search.",
    "",
    `Search: "${search}"`,
    "",
    `Cluster A: [${a.labels.join(", ")}]`,
    `Cluster B: [${b.labels.join(", ")}]`,
    "",
    "Reply with ONLY the letter 'A' or 'B'. No explanation.",
  ].join("\n");

  const openclawPath = process.env.OPENCLAW_PATH || "openclaw";
  const agentId = "openry-worker";

  try {
    const stdout = execSync(
      `${openclawPath} agent --agent ${agentId} --message "${prompt.replace(/"/g, '\\"')}" --json --timeout 30`,
      {
        env: {
          ...process.env,
          PATH: [
            process.env.PATH || "/usr/bin:/bin",
            "/usr/local/bin",
            `${process.env.HOME}/bin`,
            `${process.env.HOME}/.local/bin`,
            "/opt/homebrew/bin",
          ].join(":"),
        },
        timeout: 35_000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      },
    );

    // 解析 LLM 输出的第一个非空字符
    const trimmed = stdout.trim().toUpperCase();
    if (trimmed.startsWith("B")) {
      return b;
    }
    return a; // 默认 A（包括解析失败的情况）
  } catch (err) {
    console.error("[knowql-knowledge] LLM disambiguation failed:", err);
    return a; // 降级：取 #1
  }
}
