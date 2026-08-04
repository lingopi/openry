/**
 * KnowQL Knowledge — Clusterer（在线聚类）
 *
 * 新 concepts 组合到达时：
 *   1. embedding → 与所有 cluster centroid 做 cos
 *   2. max_cos > THRESHOLD → 归入该 cluster，更新 centroid
 *   3. 否则 → 创建新 cluster
 *
 * 聚合同步执行，在 handleDistillComplete 中调用。
 */

import type Database from "better-sqlite3";
import { ensureClustersTable } from "./db-schema.js";
import { embed, cosineSimilarity, floatsToBlob, blobToFloats } from "./embedder.js";
import type { ClusterRecord, NormalizeResult } from "./types.js";

// ── 常量 ────────────────────────────────────────────────────────

const CLUSTER_THRESHOLD = 0.75;  // 纯 BGE-M3 语义相似度，与 planner 一致

// ── 公开 API ────────────────────────────────────────────────────

/**
 * 对新 concepts 组合做在线聚类归一化。
 * 调用时机：handleDistillComplete 中，蒸馏 agent 上报完成后。
 *
 * @returns { core_id, display_labels } 用于写入 task_state.payload
 */
export async function normalizeConcepts(
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
