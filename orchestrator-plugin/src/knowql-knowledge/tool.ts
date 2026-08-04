/**
 * KnowQL Knowledge — Plugin Tool 注册
 *
 * 在 index.ts 的 plugin.register() 中调用：
 *   import { registerKnowledgeTool } from "./knowql-knowledge";
 *   registerKnowledgeTool(api, db);
 *
 * 集成点（详见 INTEGRATION.md #1, #2）
 */

import { Type } from "typebox";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type Database from "better-sqlite3";
import { executeQuery } from "./executor.js";
import type { QueryKnowledgeRequest } from "./types.js";

// ── 注册 ────────────────────────────────────────────────────────

export function registerKnowledgeTool(
  api: { registerTool: (def: any) => void },
  getDb: () => Database.Database,
): void {
  api.registerTool((ctx: OpenClawPluginToolContext) => {
    return {
      name: "openry_knowledge_query",
      label: "OpenRY Knowledge Query",
      description:
        "Search through concepts and semantic labels from all previously run workflows. " +
        "Use this to find historical knowledge: how similar tasks were handled, what tools/APIs were used, " +
        "what risks were identified, etc. This searches the semantic index (concepts + 8 primitives), " +
        "not raw text. Provide a natural language description of what you want to find.",

      parameters: Type.Object({
        search: Type.String({
          description:
            "Natural language description of what you want to find. " +
            "Be specific. E.g. 'offboarding device lost asset management system' or " +
            "'previous server outage recovery procedure'.",
        }),
        primitives: Type.Optional(
          Type.String({
            description:
              'Optional primitive type filter. Format: "all:risk,rule" (must have ALL) ' +
              'or "any:risk,rule" (must have ANY). Note: returned records still include ALL their primitives.',
          })
        ),
        since: Type.Optional(
          Type.String({
            description: "Optional start date filter, e.g. '2026-07-01'.",
          })
        ),
        until: Type.Optional(
          Type.String({
            description: "Optional end date filter, e.g. '2026-07-31'.",
          })
        ),
        mode: Type.Optional(
          Type.String({
            description:
              '"best" (default, only the best-matching topic cluster) or ' +
              '"expand" (expand to secondary clusters if best has too few results).',
          })
        ),
        sort: Type.Optional(
          Type.String({
            description: '"desc" (default, newest first) or "asc" (oldest first).',
          })
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return. Default 5, max 20.",
          })
        ),
      }),

      async execute(_toolCallId: string, params: unknown) {
        const p = params as Record<string, unknown>;
        const search = (p.search as string) || "";
        if (!search.trim()) {
          return textResult("Error: --search is required", null);
        }

        // 解析 primitives
        let primitives: QueryKnowledgeRequest["primitives"];
        if (p.primitives) {
          const raw = p.primitives as string;
          const match = raw.match(/^(all|any):(.+)$/);
          if (match) {
            primitives = {
              mode: match[1] as "all" | "any",
              values: match[2].split(",").map(s => s.trim()).filter(Boolean),
            };
          }
        }

        const req: QueryKnowledgeRequest = {
          query: "knowledge",
          search,
          primitives,
          scope: {
            since: p.since as string | undefined,
            until: p.until as string | undefined,
          },
          mode: (p.mode as "best" | "expand") || "best",
          sort: (p.sort as "desc" | "asc") || "desc",
          limit: Math.min((p.limit as number) || 5, 20),
        };

        try {
          const db = getDb();
          const result = await executeQuery(db, req);
          return textResult(JSON.stringify(result, null, 2), null);
        } catch (err) {
          return textResult(
            `openry_knowledge_query error: ${String(err)}`,
            null
          );
        }
      },
    };
  });
}
