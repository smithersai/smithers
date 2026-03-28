import { createSmithers, type AgentLike, type SmithersWorkflow } from "smithers-orchestrator";
import { z } from "zod";

export type ExampleApprovalDecision = {
  nodeId: string;
  action: "approve" | "deny";
  note?: string;
  by?: string;
};

export type ExampleManifestEntry = {
  id: string;
  workflow: SmithersWorkflow<any>;
  input: Record<string, unknown>;
  approvals?: ExampleApprovalDecision[];
};

export const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

export function createExampleSmithers<
  Schemas extends Record<string, z.ZodObject<any>>,
>(schemas: Schemas) {
  return createSmithers(schemas, { dbPath: ":memory:" });
}

export function latest<T>(values: T[] | undefined) {
  return values?.[values.length - 1];
}

export function asArray<T>(values: T[] | undefined | null) {
  return values ?? [];
}

export function sumBy<T>(values: T[] | undefined, select: (value: T) => number) {
  return asArray(values).reduce((sum, value) => sum + select(value), 0);
}

export function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function countBy<T>(values: T[] | undefined, keyOf: (value: T) => string) {
  const counts: Record<string, number> = {};
  for (const value of asArray(values)) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export function percentDelta(current: number, baseline: number) {
  if (baseline === 0) {
    return current === 0 ? 0 : 100;
  }
  return ((current - baseline) / baseline) * 100;
}

export function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function makeAgent<Row>(
  id: string,
  build: (args: { prompt: string }) => Row | Promise<Row>,
  tools?: Record<string, any>,
): AgentLike {
  return {
    id,
    tools,
    async generate(args) {
      return { output: await build({ prompt: args.prompt }) };
    },
  };
}
