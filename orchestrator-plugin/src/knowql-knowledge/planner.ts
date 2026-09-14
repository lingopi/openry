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

/**
 * 查询地板阈值（Phase D v2）：只拦域外查询。
 * 实测：Q1 域外查询 top1=0.696，0.70 恰好拦截；0.75 太严（压死真实多簇命中）。
 */
export const QUERY_FLOOR = 0.70;

/** 返回的候选簇数量上限（Phase D v2） */
export const QUERY_TOP_N = 3;

/** gap 截止：若第 k 名与第 1 名 cos 差距 > 此值则截断到 k-1 名（自适应宽度） */
export const QUERY_GAP_CUTOFF = 0.15;

/** LLM 消歧义触发阈值：#1 与 #2 差距小于此值时二选一 */
const GAP_THRESHOLD = 0.05;

/** legacy 阈值（centroid 时代与聚类共用 0.75，现仅保留导出兼容） */
export const ABS_THRESHOLD = 0.75;

export interface PlanResult {
  /** 选中的 core_id 列表（mode=best 只有 1 个；expand 最多 QUERY_TOP_N 个） */
  coreIds: string[];
  /** 每个 core_id 的 cos 和排名 */
  rankings: Array<{ core_id: string; cos: number; rank: number }>;
  /** 判定方法 */
  method: "vector" | "llm";
}

/**
 * 规划查询：search → embedding → cos vs 全部簇锚点（fallback centroid）→
 * 地板 0.70 → Top-N + gap 截止 → 选出 core_id(s)
 */
export async function planQuery(
  db: Database.Database,
  search: string,
  mode: "best" | "expand",
): Promise<PlanResult> {
  const queryVec = await embed(search);

  // 加载所有 cluster（锚点优先，legacy 行 fallback 到 centroid）
  const rows = db.prepare(
    `SELECT core_id, anchor_embedding, centroid_embedding, display_labels FROM clusters`
  ).all() as Array<{
    core_id: string;
    anchor_embedding: Buffer | null;
    centroid_embedding: Buffer;
    display_labels: string;
  }>;

  // 计算相似度，地板过滤，降序排列（纯 BGE-M3 语义向量）
  const scored = rows
    .map(row => {
      const labels = JSON.parse(row.display_labels) as string[];
      const anchorBlob = row.anchor_embedding ?? row.centroid_embedding;
      if (!anchorBlob) return null;
      const cos = cosineSimilarity(queryVec, blobToFloats(anchorBlob));
      return { core_id: row.core_id, cos, labels };
    })
    .filter((s): s is { core_id: string; cos: number; labels: string[] } => s !== null)
    .filter(s => s.cos >= QUERY_FLOOR)
    .sort((a, b) => b.cos - a.cos);

  if (scored.length === 0) {
    return { coreIds: [], rankings: [], method: "vector" };
  }

  // Top-N + gap 截止（自适应宽度：Q6 greeting 返回 1 簇，Q3 失败路由返回 3 簇）
  let keep = Math.min(QUERY_TOP_N, scored.length);
  for (let k = 1; k < keep; k++) {
    if (scored[0].cos - scored[k].cos > QUERY_GAP_CUTOFF) {
      keep = k;
      break;
    }
  }
  const topCandidates = scored.slice(0, keep);

  // 判定
  let method: "vector" | "llm" = "vector";
  let selectedCoreIds: string[] = [];

  if (mode === "expand") {
    // expand：按排名直接返回 Top-N，不跑 LLM（修复：旧逻辑 expand 下 LLM 白跑一次）
    selectedCoreIds = topCandidates.map(s => s.core_id);
  } else {
    // best：Top-1；top1/top2 gap < 0.05 时 LLM 二选一
    if (
      topCandidates.length >= 2 &&
      topCandidates[0].cos - topCandidates[1].cos < GAP_THRESHOLD
    ) {
      method = "llm";
      const chosen = await llmDisambiguate(search, topCandidates[0], topCandidates[1]);
      selectedCoreIds = [chosen.core_id];
    } else {
      selectedCoreIds = [topCandidates[0].core_id];
    }
  }

  const rankings = topCandidates.map((s, i) => ({
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
