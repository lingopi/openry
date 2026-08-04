/**
 * KnowQL Knowledge — 实验性语义检索模块
 *
 * 本模块为独立实验单元，与核心 orchestration 代码解耦。
 * 唯一公开 API 通过本文件暴露。
 *
 * 如需废弃：删除本目录 + 按 INTEGRATION.md 移除集成点。
 */

// ── 公开 API ────────────────────────────────────────────────────

export { normalizeConcepts } from "./clusterer.js";
export { registerKnowledgeTool } from "./tool.js";
export type { QueryKnowledgeRequest, QueryKnowledgeResponse } from "./types.js";
