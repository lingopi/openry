/**
 * KnowQL Knowledge — DB Schema
 *
 * clusters 表：存储语义 cluster 的向量和元数据。
 * 与 task_state 同库（~/.openry/openry.db）。
 */

export const CLUSTERS_DDL = `
CREATE TABLE IF NOT EXISTS clusters (
  core_id           TEXT PRIMARY KEY,
  display_labels    TEXT NOT NULL,          -- JSON array
  description       TEXT DEFAULT '',
  centroid_embedding BLOB NOT NULL,          -- float32 array, little-endian
  sum_embedding     BLOB NOT NULL,          -- float32 array, little-endian
  anchor_embedding  BLOB,                    -- float32 array, 锚点法核心；NULL = legacy centroid 数据
  member_count      INTEGER DEFAULT 1,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clusters_count ON clusters(member_count DESC);
`;

export function ensureClustersTable(db: any): void {
  db.exec(CLUSTERS_DDL);

  // 增量迁移：旧表补 anchor_embedding 列（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
  const cols = db.prepare(`PRAGMA table_info(clusters)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "anchor_embedding")) {
    db.exec(`ALTER TABLE clusters ADD COLUMN anchor_embedding BLOB`);
  }
}
