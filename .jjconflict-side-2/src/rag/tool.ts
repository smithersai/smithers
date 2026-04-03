import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { RagPipeline } from "./types";

// ---------------------------------------------------------------------------
// RAG tool options
// ---------------------------------------------------------------------------

export type RagToolOptions = {
  name?: string;
  description?: string;
  defaultTopK?: number;
};

// ---------------------------------------------------------------------------
// createRagTool — exposes a RAG pipeline as an AI SDK tool
// ---------------------------------------------------------------------------

export function createRagTool(
  pipeline: RagPipeline,
  opts?: RagToolOptions,
): ReturnType<typeof tool> {
  const name = opts?.name ?? "rag_search";
  const description =
    opts?.description ?? "Search the knowledge base for relevant documents";
  const defaultTopK = opts?.defaultTopK ?? 5;

  return tool({
    description,
    inputSchema: zodSchema(
      z.object({
        query: z.string().describe("The search query"),
        topK: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of results to return"),
      }),
    ),
    execute: async ({
      query,
      topK,
    }: {
      query: string;
      topK?: number;
    }) => {
      const results = await pipeline.retrieve(query, {
        topK: topK ?? defaultTopK,
      });
      return {
        results: results.map((r) => ({
          content: r.chunk.content,
          score: r.score,
          metadata: r.metadata ?? undefined,
        })),
      };
    },
  }) as any;
}
