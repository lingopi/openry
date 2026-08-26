/**
 * 一次性实验脚本：用 0.75 / 0.85 两种阈值离线重放在线聚类
 * 与 clusterer.ts 使用完全相同的公式与 BGE-M3 embedding 参数。
 * 运行：node recluster-sim.mjs
 */
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { pipeline, env } from "@xenova/transformers";

env.remoteHost = "https://hf-mirror.com";

const HOME = os.homedir();
const db = new Database(path.join(HOME, ".openry", "openry.db"), { readonly: true });

// ── 1. 读数据（按到达顺序） ────────────────────────────────────
const rows = db
  .prepare(
    `SELECT run_id, created_at, payload, workflow, sub_step_id, big_step_ref, step_id FROM task_state
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
    try { p = JSON.parse(r.payload); } catch {}
    const raw = Array.isArray(p._raw_concepts) && p._raw_concepts.length
      ? p._raw_concepts
      : p.concepts || [];
    const combo = [...new Set(raw.filter((x) => typeof x === "string"))].sort();
    return {
      run_id: r.run_id,
      ts: r.created_at,
      combo,
      old_core: p._core_id || null,
      workflow: r.workflow || "",
      sub_step: r.sub_step_id || r.step_id || "",
      big_step: r.big_step_ref || "",
    };
  })
  .filter((d) => d.combo.length > 0);

console.log(`[sim] records=${records.length}`);

// ── 2. 模型 + embedding（与 embedder.ts 一致） ─────────────────
console.log("[sim] loading BGE-M3 (first run downloads ~2GB from hf-mirror.com)...");
const pipe = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "fp32" });
console.log("[sim] model ready");

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
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};

// ── 3. 重放在线聚类（与 clusterer.ts 相同逻辑） ────────────────
async function clusterAll(threshold) {
  const clusters = [];
  for (const rec of records) {
    const vec = await embedCached(rec.combo);
    let best = null, bestCos = -1;
    for (const c of clusters) {
      const s = cos(vec, c.centroid);
      if (s > bestCos) { bestCos = s; best = c; }
    }
    if (best && bestCos > threshold) {
      for (let i = 0; i < vec.length; i++) best.sum[i] += vec[i];
      best.count++;
      const n = Math.sqrt(best.sum.reduce((s, v) => s + v * v, 0));
      best.centroid = best.sum.map((v) => v / n);
      best.members.push(rec);
      rec.assigned = best.id;
      rec.joinCos = bestCos;
    } else {
      const id = clusters.length;
      const n = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      clusters.push({
        id,
        sum: [...vec],
        count: 1,
        centroid: vec.map((v) => v / n),
        labels: [...rec.combo], // 冻结为第一个成员（同 clusterer.ts）
        first: rec,
        members: [rec],
      });
      rec.assigned = id;
      rec.joinCos = 1;
    }
  }
  return clusters;
}

function summarize(tag, threshold, clusters) {
  console.log(`\n========== 阈值 ${threshold} (${tag}) ==========`);
  console.log(`cluster 数: ${clusters.length}`);
  const sorted = [...clusters].sort((a, b) => b.count - a.count);
  for (const c of sorted) {
    const oldCounts = {};
    for (const m of c.members) {
      const k = m.old_core ? m.old_core.slice(0, 8) : "(never-normalized)";
      oldCounts[k] = (oldCounts[k] || 0) + 1;
    }
    // 高频 distinct combo top5
    const freq = new Map();
    for (const m of c.members) freq.set(m.combo.join(","), (freq.get(m.combo.join(",")) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`\n[cluster#${c.id}] members=${c.count}  labels(first)=${JSON.stringify(c.labels)}`);
    console.log(`   首条: ${c.first.run_id} @ ${c.first.ts}  old_core=${c.first.old_core}`);
    console.log(`   来源分布: ${JSON.stringify(oldCounts)}`);
    for (const [k, v] of top) console.log(`   - x${v}  [${k}]`);
    // join cos 分布
    const joins = c.members.filter((m) => m.joinCos < 1).map((m) => m.joinCos);
    if (joins.length) {
      const mn = Math.min(...joins), mx = Math.max(...joins);
      const avg = joins.reduce((s, v) => s + v, 0) / joins.length;
      console.log(`   join cos: min=${mn.toFixed(3)} max=${mx.toFixed(3)} avg=${avg.toFixed(3)}`);
    }
  }
  // 0.75-0.85 边界带统计
  const band = [];
  for (const c of clusters) {
    for (const m of c.members) {
      if (m.joinCos < 1 && m.joinCos > 0.75 && m.joinCos <= 0.85) band.push(m);
    }
  }
  console.log(`\n>>> 边界带: ${band.length} 条记录在 0.75 阈值下以 cos∈(0.75,0.85] 被归并（0.85 阈值下会拒绝这些归并）`);
}

const clusters075 = await clusterAll(0.75);
summarize("0.75", 0.75, clusters075);

// 重置 assigned，再跑 0.85
for (const r of records) { delete r.assigned; delete r.joinCos; }
const clusters085 = await clusterAll(0.85);
summarize("0.85", 0.85, clusters085);

// ── 4. 0.85 明细：每个簇的成员来源 ─────────────────────────────
console.log("\n========== 0.85 成员明细 ==========");
for (const c of clusters085) {
  console.log(`\n=== cluster#${c.id} (${c.count}) labels=${JSON.stringify(c.labels)}`);
  for (const m of c.members) {
    console.log(`  ${m.ts.slice(0,16)} | ${m.workflow || "-"} | ${m.big_step || "-"} | ${m.sub_step || "-"} | ${m.run_id.slice(0,8)} | [${m.combo.join(",")}]`);
  }
}

// ── 5. 文件域小簇两两 centroid cos ─────────────────────────────
const fileIds = clusters085
  .filter((c) => /file|demo|content|summary|statistics|report/.test(c.labels.join(" ")))
  .map((c) => c.id);
console.log("\n========== 文件域簇 pairwise cos ==========");
for (const i of fileIds) {
  const line = [];
  for (const j of fileIds) {
    if (i === j) { line.push("   -   "); continue; }
    line.push(cos(clusters085[i].centroid, clusters085[j].centroid).toFixed(3).padStart(6));
  }
  console.log(`#${i} (${clusters085[i].count}) [${clusters085[i].labels.join(",").slice(0,40)}]  ${line.join(" ")}`);
}
console.log("列顺序: " + fileIds.map((i) => `#${i}`).join(" "));

// ── 6. Leader 聚类（首条锚点固定，不更新质心） ─────────────────
async function clusterLeader(threshold) {
  const clusters = [];
  for (const rec of records) {
    const vec = await embedCached(rec.combo);
    let best = null, bestCos = -1;
    for (const c of clusters) {
      const s = cos(vec, c.anchor);
      if (s > bestCos) { bestCos = s; best = c; }
    }
    if (best && bestCos > threshold) {
      best.members.push(rec);
      rec.assigned = best.id;
      rec.joinCos = bestCos;
    } else {
      const id = clusters.length;
      clusters.push({ id, anchor: [...vec], labels: [...rec.combo], first: rec, members: [rec] });
      rec.assigned = id;
      rec.joinCos = 1;
    }
  }
  return clusters;
}

function summarizeLeader(tag, threshold, clusters) {
  console.log(`\n========== Leader 锚点法 阈值 ${threshold} (${tag}) ==========`);
  console.log(`cluster 数: ${clusters.length}`);
  const sorted = [...clusters].sort((a, b) => b.members.length - a.members.length);
  for (const c of sorted) {
    const freq = new Map();
    for (const m of c.members) freq.set(m.combo.join(","), (freq.get(m.combo.join(",")) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`\n[leader#${c.id}] members=${c.members.length}  anchor=${JSON.stringify(c.labels)}  首条: ${c.first.workflow || "-"}/${c.first.sub_step || "-"} @ ${c.first.ts.slice(0,16)}`);
    for (const [k, v] of top) console.log(`   - x${v}  [${k}]`);
  }
}

// 0.85 leader
for (const r of records) { delete r.assigned; delete r.joinCos; }
const leaders085 = await clusterLeader(0.85);
summarizeLeader("0.85", 0.85, leaders085);

// ── 7. 漂移证据：均值法下，成员与"最终 centroid"的距离 ─────────
console.log("\n========== 漂移证据 ==========");
console.log("[均值法 0.85] 各簇: 成员 vs 最终centroid 的 min cos（min 越小说明早期成员被抛得越远）:");
for (const c of clusters085) {
  if (c.members.length < 2) continue;
  let mn = 2;
  for (const m of c.members) {
    const s = cos(await embedCached(m.combo), c.centroid);
    if (s < mn) mn = s;
  }
  console.log(`  #${c.id} (${c.count}) labels=[${c.labels.join(",").slice(0,45)}]  min_cos_to_final_centroid=${mn.toFixed(3)}`);
}
console.log("[锚点法 0.85] 各簇: 成员 vs 锚点 的 min cos（理论上永远 >= 0.85）:");
for (const c of leaders085) {
  if (c.members.length < 2) continue;
  let mn = 2;
  for (const m of c.members) {
    const s = cos(await embedCached(m.combo), c.anchor);
    if (s < mn) mn = s;
  }
  console.log(`  leader#${c.id} (${c.members.length}) anchor=[${c.labels.join(",").slice(0,45)}]  min_cos_to_anchor=${mn.toFixed(3)}`);
}

// ── 8. 查询侧实测：自然语言查询 vs 锚点/质心 ───────────────────
const QUERIES = [
  ["Q1", "offboarding device lost asset check"],                          // 域外查询（设计文档示例）
  ["Q2", "loop workflow that processes files and computes text statistics"],
  ["Q3", "how did previous workflow handle failure routing and on_failure jump"],
  ["Q4", "check whether a file exists and read its content"],
  ["Q5", "workflow yaml configuration generation for loop bootstrap"],
  ["Q6", "the greeting step that says hello world"],
];

function topK(vec, centers, k = 5) {
  return centers
    .map((c) => ({ id: c.id, size: c.members.length, labels: c.labels, cos: cos(vec, c.anchor !== undefined ? c.anchor : c.centroid) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, k);
}

console.log("\n========== 查询实测：锚点法(36簇) vs 均值法(25簇) ==========");
for (const [tag, q] of QUERIES) {
  const qv = await embed(q);
  console.log(`\n### ${tag}: "${q}"`);
  const lTop = topK(qv, leaders085);
  const mTop = topK(qv, clusters085);
  console.log("  锚点法 top5:");
  for (const t of lTop) {
    console.log(`    cos=${t.cos.toFixed(3)} size=${t.size} [${t.labels.join(",").slice(0,50)}]`);
  }
  console.log("  均值法 top5:");
  for (const t of mTop) {
    console.log(`    cos=${t.cos.toFixed(3)} size=${t.size} [${t.labels.join(",").slice(0,50)}]`);
  }
  // 阈值敏感性：多少个簇过 0.75 / 0.65 / 0.55
  for (const th of [0.75, 0.65, 0.55]) {
    const passL = leaders085.map((c) => cos(qv, c.anchor)).filter((s) => s >= th).length;
    const passM = clusters085.map((c) => cos(qv, c.centroid)).filter((s) => s >= th).length;
    console.log(`  阈值>=${th}: 锚点法过线簇数=${passL}, 均值法过线簇数=${passM}`);
  }
}
