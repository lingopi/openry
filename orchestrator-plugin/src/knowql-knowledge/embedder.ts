/**
 * KnowQL Knowledge — Embedder
 *
 * 使用 BGE-M3 语义向量模型（1024 维）。
 * 首次调用 embed() 时自动下载 ONNX 模型（~2GB），缓存至 ~/.cache/huggingface/。
 *
 * 后备信号：searchCoverage() 分词重叠率，作为语义匹配的辅助补充。
 */

import type { FeatureExtractionPipeline } from "@xenova/transformers";

// ── 常量 ────────────────────────────────────────────────────────

const MODEL_NAME = "Xenova/bge-m3";
const EMBED_DIM = 1024;            // BGE-M3 输出维度

/** 综合分数权重：纯 BGE-M3 语义向量 */
export const EMBED_WEIGHT = 1.0;
export const COVERAGE_WEIGHT = 0.0;

// ── 模型单例 ────────────────────────────────────────────────────

let _pipeline: FeatureExtractionPipeline | null = null;
let _pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipeline) return _pipeline;
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // 国内用 HF 镜像，避免被墙
      env.remoteHost = "https://hf-mirror.com";
      console.log(`[embedder] Loading BGE-M3 model (first call, ~2GB download from hf-mirror.com)...`);
      const pipe = await pipeline("feature-extraction", MODEL_NAME);
      console.log(`[embedder] BGE-M3 loaded.`);
      _pipeline = pipe;
      return pipe;
    })();
  }
  return _pipelinePromise;
}

// ── 公开 API ────────────────────────────────────────────────────

/**
 * 文本 → BGE-M3 语义向量（1024 维，L2 归一化）
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const result = await pipe(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(result.data as Float32Array);
}

/**
 * 余弦相似度（通用，不限定维度）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (normA > 0 && normB > 0) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ── 分词 ────────────────────────────────────────────────────────

/** 文本 → 单词列表（按下划线、空格、连字符分词） */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s_\-]+/).filter(w => w.length > 0);
}

// ── 搜索匹配度（供 planner 直接调用）─────────────────────────

/**
 * 搜索词覆盖率：搜索文本中有多少单词出现在目标标签中。
 *
 * 例如 search="email reply draft" vs labels="email_reply_automation draft_creation"
 * → 搜索词 ["email","reply","draft"]，labels 词 ["email","reply","automation","draft","creation"]
 * → 交集 {"email","reply","draft"} = 3，搜索词总数 = 3 → 覆盖率 = 1.0
 *
 * 语义向量主导匹配（80% 权重），覆盖率作为精确词匹配的辅助信号（20% 权重）。
 */
export function searchCoverage(searchText: string, labelText: string): number {
  const searchWords = new Set(tokenize(searchText));
  const labelWords = new Set(tokenize(labelText));
  if (searchWords.size === 0) return 0;
  const matched = [...searchWords].filter(w => labelWords.has(w)).length;
  return matched / searchWords.size;
}

// ── 序列化 ──────────────────────────────────────────────────────

/**
 * float32 数组 → BLOB（little-endian）
 */
export function floatsToBlob(floats: number[]): Buffer {
  const buf = Buffer.alloc(floats.length * 4);
  for (let i = 0; i < floats.length; i++) {
    buf.writeFloatLE(floats[i], i * 4);
  }
  return buf;
}

/**
 * BLOB → float32 数组
 */
export function blobToFloats(blob: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < blob.length; i += 4) {
    floats.push(blob.readFloatLE(i));
  }
  return floats;
}
