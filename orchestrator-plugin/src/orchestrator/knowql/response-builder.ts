/**
 * Response Builder — 将查询结果序列化为 agent 友好的 JSON 字符串。
 */
import type { KnowQLResponse } from "./types.js";

export function buildResponse(result: KnowQLResponse): string {
  return JSON.stringify(result, null, 2);
}

export function buildErrorResponse(message: string, hint?: string): string {
  return JSON.stringify({ error: message, ...(hint ? { hint } : {}) }, null, 2);
}
