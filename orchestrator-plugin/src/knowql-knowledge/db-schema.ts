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
  member_count      INTEGER DEFAULT 1,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clusters_count ON clusters(member_count DESC);
`;

export function ensureClustersTable(db: any): void {
  db.exec(CLUSTERS_DDL);
}
