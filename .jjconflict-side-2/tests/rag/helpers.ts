import type { EmbeddingModel } from "ai";

/**
 * Create a deterministic mock embedding model for testing.
 * Uses a hash-based approach to produce consistent 3D vectors.
 * Implements the EmbeddingModelV3 spec required by AI SDK 6.
 */
export function createMockEmbeddingModel(): EmbeddingModel {
  function hashEmbed(text: string): number[] {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    const a = Math.sin(h) * 0.5 + 0.5;
    const b = Math.cos(h) * 0.5 + 0.5;
    const c = Math.sin(h * 2) * 0.5 + 0.5;
    // Normalize to unit vector
    const mag = Math.sqrt(a * a + b * b + c * c);
    return [a / mag, b / mag, c / mag];
  }

  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-embed",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    doEmbed: async (options: { values: string[] }) => ({
      embeddings: options.values.map((v) => hashEmbed(v)),
      usage: { tokens: 0 },
      warnings: [],
    }),
  } as unknown as EmbeddingModel;
}
