/**
 * preload-model.mjs — 预下载 BGE-M3 向量模型
 *
 * 在安装时执行，避免首次运行时用户等待 2GB 下载。
 * 使用 hf-mirror.com（国内 HF 镜像）加速。
 *
 * 用法: node scripts/preload-model.mjs
 */

import { env, pipeline } from "@xenova/transformers";

env.remoteHost = "https://hf-mirror.com";
env.localModelPath = undefined; // use default cache ~/.cache/huggingface/

const MODEL = "Xenova/bge-m3";

console.log(`[preload-model] Downloading ${MODEL} from ${env.remoteHost} ...`);
console.log(`[preload-model] This may take a few minutes (~2GB).`);

try {
  const pipe = await pipeline("feature-extraction", MODEL);
  // Quick warm-up: embed a test string
  const result = await pipe("test warmup", { pooling: "mean", normalize: true });
  console.log(`[preload-model] ✓ BGE-M3 ready (${result.data.length} dims)`);
} catch (err) {
  console.error(`[preload-model] ✗ Failed: ${err.message}`);
  console.error(`[preload-model] Model will be downloaded on first use instead.`);
  process.exit(1);
}
