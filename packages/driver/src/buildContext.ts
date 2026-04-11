import type { OutputAccessor } from "./OutputAccessor.ts";
import type { OutputKey } from "./OutputKey.ts";
import type { SmithersCtx } from "./SmithersCtx.ts";
import { SmithersError } from "@smithers/errors";
import type { BuildContextOptions } from "./BuildContextOptions.ts";
import { buildCurrentScopes } from "./buildCurrentScopes.ts";
import { filterRowsByNodeId } from "./filterRowsByNodeId.ts";
import { normalizeInputRow } from "./normalizeInputRow.ts";
import { withLogicalIterationShortcuts } from "./withLogicalIterationShortcuts.ts";

type SafeParser = {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error?: unknown };
};

function resolveDrizzleName(table: any): string | undefined {
  if (!table || typeof table !== "object") return undefined;
  const tableMeta = table._;
  if (
    tableMeta &&
    typeof tableMeta === "object" &&
    typeof tableMeta.name === "string"
  ) {
    return tableMeta.name;
  }
  if (typeof table.name === "string") return table.name;
  return undefined;
}

export function buildContext<Schema>(
  opts: BuildContextOptions,
): SmithersCtx<Schema> {
  const {
    runId,
    iteration,
    iterations,
    input,
    auth,
    outputs,
    zodToKeyName,
    runtimeConfig,
  } = opts;
  const normalizedInput = normalizeInputRow(input);
  const normalizedIterations = withLogicalIterationShortcuts(iterations);
  const currentScopes = buildCurrentScopes(normalizedIterations);

  const outputsFn: any = (table: string) => outputs[table] ?? [];
  for (const [name, rows] of Object.entries(outputs)) {
    outputsFn[name] = rows;
  }

  function resolveTableName(table: any): string {
    if (typeof table === "string") return table;
    const zodKey = zodToKeyName?.get(table);
    if (zodKey) return zodKey;
    return resolveDrizzleName(table) ?? String(table);
  }

  function resolveRow(table: any, key: OutputKey): any | undefined {
    const tableName = resolveTableName(table);
    const rows = outputs[tableName] ?? [];
    const matching = filterRowsByNodeId(rows, key.nodeId, currentScopes);
    return matching.find((row) => {
      return (row.iteration ?? 0) === (key.iteration ?? iteration);
    });
  }

  return {
    runId,
    iteration,
    iterations: normalizedIterations,
    input: normalizedInput,
    auth: auth ?? null,
    __smithersRuntime: runtimeConfig ?? null,
    outputs: outputsFn as OutputAccessor<Schema>,
    output(table: any, key: OutputKey): any {
      const row = resolveRow(table, key);
      if (!row) {
        throw new SmithersError(
          "MISSING_OUTPUT",
          `Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`,
          { nodeId: key.nodeId, iteration: key.iteration ?? 0 },
        );
      }
      return row;
    },
    outputMaybe(table: any, key: OutputKey): any {
      return resolveRow(table, key);
    },
    latest(table: any, nodeId: string): any {
      const tableName = resolveTableName(table);
      const rows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(rows, nodeId, currentScopes);
      let best: any = undefined;
      let bestIteration = -Infinity;
      for (const row of matching) {
        const iter = Number.isFinite(Number(row.iteration))
          ? Number(row.iteration)
          : 0;
        if (!best || iter >= bestIteration) {
          best = row;
          bestIteration = iter;
        }
      }
      return best;
    },
    latestArray(value: unknown, schema: SafeParser): unknown[] {
      if (value == null) return [];
      let arr: unknown[];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          arr = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      } else {
        arr = Array.isArray(value) ? value : [value];
      }
      return arr.flatMap((item) => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    },
    iterationCount(table: any, nodeId: string): number {
      const tableName = resolveTableName(table);
      const rows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(rows, nodeId, currentScopes);
      const seen = new Set<number>();
      for (const row of matching) {
        const iter = Number.isFinite(Number(row.iteration))
          ? Number(row.iteration)
          : 0;
        seen.add(iter);
      }
      return seen.size;
    },
  };
}
