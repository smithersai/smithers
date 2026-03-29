import React from "react";
import { getTableName } from "drizzle-orm";
import type { SmithersCtx } from "./SmithersCtx";
import type { OutputKey } from "./OutputKey";
import { SmithersError } from "./utils/errors";

export type OutputSnapshot = {
  [tableName: string]: Array<any>;
};

export const SmithersContext = React.createContext<SmithersCtx<any> | null>(null);
SmithersContext.displayName = "SmithersContext";

function normalizeInputRow(input: any) {
  if (!input || typeof input !== "object") return input;
  if (!("payload" in input)) return input;
  const keys = Object.keys(input);
  const payloadOnly = keys.every((key) => key === "runId" || key === "payload");
  if (!payloadOnly) return input;
  const payload = (input as any).payload;
  if (payload == null) return {};
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

/**
 * Build the set of current scope suffixes from the iterations map.
 *
 * The iterations map contains scoped ralph IDs like "inner@@outer=0" where
 * the suffix "@@outer=0" describes the ancestor loop context. For the
 * current ancestor iteration (e.g. outer=1), we reconstruct the current
 * scope suffix by replacing ancestor iteration values in the scope patterns
 * we find.
 *
 * Example: iterations = {"outer": 1, "inner@@outer=0": 2, "inner@@outer=1": 0}
 * We find scope pattern "@@outer=N" from "inner@@outer=0" and "inner@@outer=1".
 * Current outer iteration is 1, so current suffix is "@@outer=1".
 */
function buildCurrentScopes(
  iterations?: Record<string, number>,
): Set<string> {
  const scopes = new Set<string>();
  if (!iterations) return scopes;

  // Collect current iterations for unscoped ralphs
  const unscopedIters: Record<string, number> = {};
  for (const [ralphId, iter] of Object.entries(iterations)) {
    if (!ralphId.includes("@@")) {
      unscopedIters[ralphId] = iter;
    }
  }

  // Find all scope patterns from scoped ralph IDs and rebuild with current iterations
  for (const ralphId of Object.keys(iterations)) {
    const atIdx = ralphId.indexOf("@@");
    if (atIdx < 0) continue;
    const suffix = ralphId.slice(atIdx + 2); // e.g. "outer=0" or "outer=0,middle=1"
    // Parse and rebuild with current iterations
    const parts = suffix.split(",");
    const rebuiltParts: string[] = [];
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) continue;
      const ancestorId = part.slice(0, eqIdx);
      const currentIter = unscopedIters[ancestorId];
      if (currentIter !== undefined) {
        rebuiltParts.push(`${ancestorId}=${currentIter}`);
      } else {
        rebuiltParts.push(part); // fallback to original
      }
    }
    if (rebuiltParts.length > 0) {
      scopes.add("@@" + rebuiltParts.join(","));
    }
  }

  return scopes;
}

/**
 * Filter rows matching a nodeId, considering loop scoping.
 * When looking up a logical (unscoped) ID like "innerTask", we match rows
 * whose nodeId is "innerTask@@<current_scope>" based on the current loop state.
 */
function filterRowsByNodeId(
  rows: any[],
  lookupNodeId: string,
  currentScopes: Set<string>,
): any[] {
  // Exact matches (for unscoped or already-scoped lookups)
  const exact = rows.filter((r) => r.nodeId === lookupNodeId);
  if (exact.length > 0 || lookupNodeId.includes("@@")) return exact;

  // Try current scope suffixes — most specific first (longest suffix)
  const sortedScopes = [...currentScopes].sort((a, b) => b.length - a.length);
  for (const scope of sortedScopes) {
    const scopedId = lookupNodeId + scope;
    const matched = rows.filter((r) => r.nodeId === scopedId);
    if (matched.length > 0) return matched;
  }

  return [];
}

export function buildContext<Schema>(opts: {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: any;
  outputs: OutputSnapshot;
  zodToKeyName?: Map<any, string>;
}): SmithersCtx<Schema> {
  const { runId, iteration, iterations, input, outputs, zodToKeyName } = opts;
  const normalizedInput = normalizeInputRow(input);
  const currentScopes = buildCurrentScopes(iterations);

  const outputsFn: any = (table: string) => {
    return outputs[table] ?? [];
  };

  for (const [name, rows] of Object.entries(outputs)) {
    outputsFn[name] = rows;
  }

  function resolveTableName(table: any): string {
    if (typeof table === "string") return table;
    // Zod schema — resolve via zodToKeyName map
    if (zodToKeyName) {
      const key = zodToKeyName.get(table);
      if (key) return key;
    }
    // Drizzle table object — extract snake_case table name
    try {
      const name = getTableName(table);
      if (name && typeof name === "string") return name;
    } catch {}
    return String(table);
  }

  function resolveRow<T>(table: any, key: OutputKey): T | undefined {
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
    iterations,
    input: normalizedInput,
    outputs: outputsFn,
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
      const tableRows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(tableRows, nodeId, currentScopes);
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
    latestArray(value: unknown, schema: import("zod").ZodType): any[] {
      if (value == null) return [];
      let arr: unknown[];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          arr = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      } else if (Array.isArray(value)) {
        arr = value;
      } else {
        arr = [value];
      }
      const result: any[] = [];
      for (const item of arr) {
        const parsed = schema.safeParse(item);
        if (parsed.success) {
          result.push(parsed.data);
        }
      }
      return result;
    },
    iterationCount(table: any, nodeId: string): number {
      const tableName = resolveTableName(table);
      const tableRows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(tableRows, nodeId, currentScopes);
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

export function createSmithersContext<Schema>() {
  const SmithersContext = React.createContext<SmithersCtx<Schema> | null>(null);
  SmithersContext.displayName = "SmithersContext";

  function useCtx(): SmithersCtx<Schema> {
    const ctx = React.useContext(SmithersContext);
    if (!ctx) {
      throw new SmithersError(
        "CONTEXT_OUTSIDE_WORKFLOW",
        "useCtx() must be called inside a <Workflow> created by createSmithers()",
      );
    }
    return ctx;
  }

  return { SmithersContext, useCtx };
}
