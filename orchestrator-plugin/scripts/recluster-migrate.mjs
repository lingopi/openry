/**
 * recluster-migrate.mjs — Phase D v2 锚点法数据迁移（一次性）
 *
 * 与 clusterer.ts 的 normalizeConceptsAnchor 使用完全相同的公式与 BGE-M3 参数：
 *   锚点法 + 阈值 0.85，按 created_at 顺序重放全部带 concepts 的 task_state 行。
 *
 * 用法（在 orchestrator-plugin 目录下运行）：
 *   node scripts/recluster-migrate.mjs            # dry-run：只报告，不写库（默认）
 *   node scripts/recluster-migrate.mjs --apply    # 真正执行迁移
 *
 * 迁移步骤（--apply 时）：
 *   1. 旧 clusters 表改名 clusters_bak_<时间戳>（不删除，可回滚）
 *   2. 按锚点法 0.85 重建全部簇，写入新 clusters 表（含 anchor_embedding）
 *   3. 逐行改写 task_state.payload._core_id 指向新簇
 *   4. payload._raw_concepts 保留不变；原本没有的用原始 concepts 补上（供未来重聚类）
 */

import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline, env } from "@xenova/transformers";

env.remoteHost = "https://hf-mirror.com";

const APPLY = process.argv.includes("--apply");
const ANCHOR_THRESHOLD = 0.85;

const HOME = os.homedir();
const DB_PATH = path.join(HOME, ".openry", "openry.db");

// ── 打开数据库 ────────────────────────────────────────────────────
const db = new Database(DB_PATH);

console.log(`[migrate] db=${DB_PATH}`);
console.log(`[migrate] mode=${APPLY ? "APPLY (写入)" : "DRY-RUN (只报告)"}`);

// ── 1. 读数据（按到达顺序；_raw_concepts 优先，否则 concepts） ────
const rows = db
  .prepare(
    `SELECT run_id, created_at, payload FROM task_state
     WHERE (json_extract(payload, '$._raw_concepts') IS NOT NULL
            AND json_extract(payload, '$._raw_concepts') != '[]')
        OR (json_extract(payload, '$.concepts') IS NOT NULL
            AND json_extract(payload, '$.concepts') != '[]')
     ORDER BY created_at ASC, run_id ASC`
  )
  .all();

const records = rows
  .map((r) => {
    let p = {};
    try {
      p = JSON.parse(r.payload);
    } catch {
      /* 损坏 payload 跳过 */
    }
    const raw = Array.isArray(p._raw_concepts) && p._raw_concepts.length
      ? p._raw_concepts
      : p.concepts || [];
    const combo = [...new Set(raw.filter((x) => typeof x === "string"))].sort();
    return { run_id: r.run_id, ts: r.created_at, payload: p, combo };
  })
  .filter((d) => d.combo.length > 0);

console.log(`[migrate] records with concepts = ${records.length}`);

// 有 _core_id 但无 concepts 的行：无法重聚类，旧 core_id 将失效（只告警）
const orphanCount = db
  .prepare(
    `SELECT COUNT(*) AS n FROM task_state
     WHERE json_extract(payload, '$._core_id') IS NOT NULL
       AND (json_extract(payload, '$.concepts') IS NULL OR json_extract(payload, '$.concepts') = '[]')
       AND (json_extract(payload, '$._raw_concepts') IS NULL OR json_extract(payload, '$._raw_concepts') = '[]')`
  )
  .get().n;
if (orphanCount > 0) {
  console.log(`[migrate] ⚠ ${orphanCount} 行仅有 _core_id 而无 concepts，不会被重聚类（旧 core_id 将失效）`);
}

// ── 2. 模型 + embedding（与 embedder.ts 一致） ─────────────────────
console.log("[migrate] loading BGE-M3 (first run downloads ~2GB from hf-mirror.com)...");
const pipe = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "fp32" });
console.log("[migrate] model ready");

async function embed(text) {
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}
const cache = new Map();
async function embedCached(combo) {
  const key = combo.join(" ");
  if (!cache.has(key)) cache.set(key, await embed(key));
  return cache.get(key);
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};

// ── 3. 重放：锚点法 0.85（与 normalizeConceptsAnchor 相同逻辑） ────
console.log("[migrate] replaying anchor clustering (threshold=0.85)...");
const clusters = []; // { id, anchor, sums, count, labels }
for (const rec of records) {
  const vec = await embedCached(rec.combo);
  let best = null, bestCos = -1;
  for (const c of clusters) {
    const s = cos(vec, c.anchor);
    if (s > bestCos) {
      bestCos = s;
      best = c;
    }
  }
  if (best && bestCos > ANCHOR_THRESHOLD) {
    for (let i = 0; i < vec.length; i++) best.sums[i] += vec[i];
    best.count++;
    rec.assigned = best.id;
    rec.joinCos = bestCos;
  } else {
    const id = clusters.length;
    clusters.push({
      id,
      anchor: [...vec],
      sums: [...vec],
      count: 1,
      labels: [...rec.combo],
    });
    rec.assigned = id;
    rec.joinCos = 1;
  }
}

console.log(`[migrate] clusters = ${clusters.length}`);
const sortedClusters = [...clusters].sort((a, b) => b.count - a.count);
console.log("\n── 新簇 Top 10 ──");
for (const c of sortedClusters.slice(0, 10)) {
  console.log(`  #${c.id}  members=${c.count}  anchor=[${c.labels.join(", ")}]`);
}
const singletons = clusters.filter((c) => c.count === 1).length;
console.log(`  ... singletons=${singletons}`);
const joins = records.filter((r) => r.joinCos < 1).map((r) => r.joinCos);
if (joins.length) {
  const mn = Math.min(...joins), mx = Math.max(...joins);
  console.log(`\n[migrate] join cos: min=${mn.toFixed(3)} max=${mx.toFixed(3)}`);
}

// ── 4. 写库（仅 --apply） ─────────────────────────────────────────
if (!APPLY) {
  console.log("\n[migrate] DRY-RUN 完成，未写任何数据。确认无误后运行: node scripts/recluster-migrate.mjs --apply");
  db.close();
  process.exit(0);
}

function floatsToBlob(floats) {
  const buf = Buffer.alloc(floats.length * 4);
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4);
  return buf;
}

const migrateAll = db.transaction(() => {
  // 4.1 旧表改名备份（时间戳后缀，避免冲突）
  const hasOld = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='clusters'`)
    .get();
  if (hasOld) {
    const bakName = `clusters_bak_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
    db.exec(`ALTER TABLE clusters RENAME TO ${bakName}`);
    console.log(`[migrate] old clusters → ${bakName}`);
  }

  // 4.2 建新表（与 db-schema.ts CLUSTERS_DDL 一致）
  db.exec(`
CREATE TABLE IF NOT EXISTS clusters (
  core_id           TEXT PRIMARY KEY,
  display_labels    TEXT NOT NULL,
  description       TEXT DEFAULT '',
  centroid_embedding BLOB NOT NULL,
  sum_embedding     BLOB NOT NULL,
  anchor_embedding  BLOB,
  member_count      INTEGER DEFAULT 1,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clusters_count ON clusters(member_count DESC);
`);

  // 4.3 插入新簇（锚点 = 建簇首条成员）
  const insert = db.prepare(
    `INSERT INTO clusters (core_id, display_labels, centroid_embedding, sum_embedding, anchor_embedding, member_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const newCoreIds = new Array(clusters.length);
  for (const c of clusters) {
    const coreId = crypto.randomUUID();
    newCoreIds[c.id] = coreId;
    const norm = Math.sqrt(c.sums.reduce((s, v) => s + v * v, 0));
    const centroid = c.sums.map((v) => v / norm);
    insert.run(
      coreId,
      JSON.stringify(c.labels),
      floatsToBlob(centroid),
      floatsToBlob(c.sums),
      floatsToBlob(c.anchor),
      c.count,
    );
  }
  console.log(`[migrate] inserted ${clusters.length} clusters`);

  // 4.4 逐行改写 payload._core_id（_raw_concepts 保留；缺失则用原始 concepts 补上）
  const update = db.prepare(`UPDATE task_state SET payload = ? WHERE run_id = ?`);
  let rewritten = 0;
  for (const rec of records) {
    const p = rec.payload;
    p._core_id = newCoreIds[rec.assigned];
    if (!Array.isArray(p._raw_concepts) || p._raw_concepts.length === 0) {
      p._raw_concepts = [...rec.combo];
    }
    update.run(JSON.stringify(p), rec.run_id);
    rewritten++;
  }
  console.log(`[migrate] rewritten _core_id for ${rewritten} rows`);
});

try {
  migrateAll();
  console.log("\n[migrate] ✅ 迁移完成。旧表已备份为 clusters_bak_*，可回滚。");
} catch (err) {
  console.error("[migrate] ❌ 迁移失败（事务已回滚）:", err);
  db.close();
  process.exit(1);
}

db.close();
