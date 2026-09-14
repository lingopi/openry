/**
 * KnowQL Knowledge — Clusterer（在线聚类）
 *
 * 两种算法并存，由 CLUSTERING_MODE 切换（Phase D v2，2026-09）：
 *
 *  A. 锚点法（默认，anchor）—— Phase D v2 新算法：
 *     1. embedding → 与所有 cluster 的"锚点向量"（建簇首条成员，永不更新）做 cos
 *     2. max_cos > ANCHOR_THRESHOLD(0.85) → 归入该簇（锚点冻结）
 *     3. 否则 → 创建新簇，x 自身成为锚点
 *     漂移被数学上根除（每个成员与锚点 cos 恒 ≥0.85），标签永远诚实。
 *
 *  B. 均值 centroid 法（legacy）：
 *     max_cos > CLUSTER_THRESHOLD(0.75) → 归入 → centroid = sum/count 滚动更新。
 *     保留用于回退与对照实验。
 *
 * 聚合同步执行，在 handleDistillComplete 中调用。
 */

import type Database from "better-sqlite3";
import { ensureClustersTable } from "./db-schema.js";
import { embed, cosineSimilarity, floatsToBlob, blobToFloats } from "./embedder.js";
import type { ClusterRecord, NormalizeResult } from "./types.js";

// ── 常量 ────────────────────────────────────────────────────────

/** 均值 centroid 法阈值（legacy） */
const CLUSTER_THRESHOLD = 0.75;

/** 锚点法阈值（Phase D v2）：成员与锚点 cos 的构造性下界 */
export const ANCHOR_THRESHOLD = 0.85;

/**
 * 聚类模式开关：
 *   "anchor"   — 锚点法（默认）
 *   "centroid" — 均值 centroid 法（回退）
 * 也可用环境变量 KNOWQL_CLUSTERING_MODE 覆盖。
 */
export type ClusteringMode = "anchor" | "centroid";
export const CLUSTERING_MODE: ClusteringMode =
  (process.env.KNOWQL_CLUSTERING_MODE as ClusteringMode) || "anchor";

// ── 公开 API ────────────────────────────────────────────────────

/**
 * 对新 concepts 组合做在线聚类归一化（按 CLUSTERING_MODE 分发）。
 * 调用时机：handleDistillComplete 中，蒸馏 agent 上报完成后。
 *
 * @returns { core_id, display_labels } 用于写入 task_state.payload
 */
export async function normalizeConcepts(
  db: Database.Database,
  rawConcepts: string[],
): Promise<NormalizeResult> {
  if (CLUSTERING_MODE === "centroid") {
    return normalizeConceptsCentroid(db, rawConcepts);
  }
  return normalizeConceptsAnchor(db, rawConcepts);
}

/**
 * 均值 centroid 法（legacy，保留用于回退与对照）。
 * centroid = sum/count 滚动更新，语义中心随数据漂移。
 */
export async function normalizeConceptsCentroid(
  db: Database.Database,
  rawConcepts: string[],
): Promise<NormalizeResult> {
  ensureClustersTable(db);

  // 去重排序，保证相同语义组合的 join 顺序一致
  const sorted = [...new Set(rawConcepts)].sort();
  const labelText = sorted.join(" ");

  // 1. 向量化
  const vec = await embed(labelText);

  // 2. 加载所有 cluster
  const rows = db.prepare(
    `SELECT core_id, display_labels, centroid_embedding, sum_embedding, member_count
     FROM clusters`
  ).all() as Array<{
    core_id: string;
    display_labels: string;
    centroid_embedding: Buffer;
    sum_embedding: Buffer;
    member_count: number;
  }>;

  // 3. 找最匹配的 cluster
  let bestCoreId: string | null = null;
  let bestLabels: string[] = [];
  let bestCos = -1;
  let bestSum: number[] = [];
  let bestCount = 0;

  for (const row of rows) {
    const centroid = blobToFloats(row.centroid_embedding);
    const sim = cosineSimilarity(vec, centroid);
    if (sim > bestCos) {
      bestCos = sim;
      bestCoreId = row.core_id;
      bestLabels = JSON.parse(row.display_labels) as string[];
      bestSum = blobToFloats(row.sum_embedding);
      bestCount = row.member_count;
    }
  }

  // 4. 判定
  if (bestCoreId && bestCos > CLUSTER_THRESHOLD) {
    // 归入已有 cluster，更新 centroid
    const newSum = bestSum.map((v, i) => v + vec[i]);
    const newCount = bestCount + 1;
    const norm = Math.sqrt(newSum.reduce((s, v) => s + v * v, 0));
    const newCentroid = newSum.map(v => v / norm);

    db.prepare(
      `UPDATE clusters
       SET sum_embedding = ?,
           centroid_embedding = ?,
           member_count = ?,
           updated_at = datetime('now')
       WHERE core_id = ?`
    ).run(floatsToBlob(newSum), floatsToBlob(newCentroid), newCount, bestCoreId);

    return { core_id: bestCoreId, display_labels: bestLabels };
  }

  // 5. 创建新 cluster
  const coreId = generateUUID();
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  const normalizedVec = vec.map(v => v / norm);

  db.prepare(
    `INSERT INTO clusters (core_id, display_labels, centroid_embedding, sum_embedding, member_count)
     VALUES (?, ?, ?, ?, 1)`
  ).run(coreId, JSON.stringify(sorted), floatsToBlob(normalizedVec), floatsToBlob(vec));

  return { core_id: coreId, display_labels: sorted };
}

/**
 * 锚点法（Phase D v2，默认）。
 *
 * 核心：每簇保存"锚点向量"（anchor_embedding）——建簇首条成员的向量，永不更新。
 * 归入判定只与锚点比 cos；新成员不移动锚点、不移动 centroid 语义中心。
 * 因此每个成员与锚点的 cos 永远 ≥ ANCHOR_THRESHOLD（构造性保证），漂移被根除。
 *
 * 兼容性：
 *  - 读取时 anchor_embedding 为 NULL 的 legacy 行 fallback 到 centroid_embedding；
 *  - 归入时仍同步维护 sum_embedding/member_count，保证 centroid 法随时可回退。
 */
export async function normalizeConceptsAnchor(
  db: Database.Database,
  rawConcepts: string[],
): Promise<NormalizeResult> {
  ensureClustersTable(db);

  const sorted = [...new Set(rawConcepts)].sort();
  const labelText = sorted.join(" ");

  // 1. 向量化
  const vec = await embed(labelText);

  // 2. 加载所有 cluster（锚点优先，legacy 行 fallback 到 centroid）
  const rows = db.prepare(
    `SELECT core_id, display_labels, anchor_embedding, centroid_embedding, sum_embedding, member_count
     FROM clusters`
  ).all() as Array<{
    core_id: string;
    display_labels: string;
    anchor_embedding: Buffer | null;
    centroid_embedding: Buffer;
    sum_embedding: Buffer;
    member_count: number;
  }>;

  // 3. 与所有锚点算 cos，取 argmax
  let bestCoreId: string | null = null;
  let bestLabels: string[] = [];
  let bestCos = -1;
  let bestSum: number[] = [];
  let bestCount = 0;

  for (const row of rows) {
    const anchorBlob = row.anchor_embedding ?? row.centroid_embedding;
    if (!anchorBlob) continue;
    const sim = cosineSimilarity(vec, blobToFloats(anchorBlob));
    if (sim > bestCos) {
      bestCos = sim;
      bestCoreId = row.core_id;
      bestLabels = JSON.parse(row.display_labels) as string[];
      bestSum = blobToFloats(row.sum_embedding);
      bestCount = row.member_count;
    }
  }

  // 4. 判定：max > 0.85 归入（锚点冻结）；否则建新簇
  if (bestCoreId && bestCos > ANCHOR_THRESHOLD) {
    // 锚点不动；仍维护 sum/count 以便 centroid 模式回退与 medoid 治理
    const newSum = bestSum.map((v, i) => v + vec[i]);
    const newCount = bestCount + 1;

    db.prepare(
      `UPDATE clusters
       SET sum_embedding = ?,
           member_count = ?,
           updated_at = datetime('now')
       WHERE core_id = ?`
    ).run(floatsToBlob(newSum), newCount, bestCoreId);

    return { core_id: bestCoreId, display_labels: bestLabels };
  }

  // 5. 创建新 cluster：x 自身成为锚点
  const coreId = generateUUID();
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  const normalizedVec = vec.map(v => v / norm);

  db.prepare(
    `INSERT INTO clusters (core_id, display_labels, centroid_embedding, sum_embedding, anchor_embedding, member_count)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(
    coreId,
    JSON.stringify(sorted),
    floatsToBlob(normalizedVec),
    floatsToBlob(vec),
    floatsToBlob(normalizedVec),
  );

  return { core_id: coreId, display_labels: sorted };
}

// ── 工具 ────────────────────────────────────────────────────────

function generateUUID(): string {
  // crypto.randomUUID() 在 Node 19+ 可用
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 降级：v4 UUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
