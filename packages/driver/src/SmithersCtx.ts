import type { z } from "zod";
import type { OutputAccessor } from "./OutputAccessor.ts";
import type { OutputKey } from "./OutputKey.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { RunAuthContext } from "./RunAuthContext.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";
import { SmithersError } from "@smithers/errors/SmithersError";
import { buildCurrentScopes } from "./buildCurrentScopes.ts";
import { filterRowsByNodeId } from "./filterRowsByNodeId.ts";
import { normalizeInputRow } from "./normalizeInputRow.ts";
import { withLogicalIterationShortcuts } from "./withLogicalIterationShortcuts.ts";

/**
 * Reverse-lookup: given Schema and a value type V, find the key K where Schema[K] extends V.
 * Used to narrow return types when passing Zod schema objects directly.
 */
type SchemaKeyForValue<Schema, V> = {
  [K in keyof Schema & string]: Schema[K] extends V ? K : never;
}[keyof Schema & string];

type InferRow<TTable> = TTable extends { $inferSelect: infer R } ? R : never;

type InferOutputEntry<T> = T extends z.ZodTypeAny
  ? z.infer<T>
  : T extends { $inferSelect: any }
    ? InferRow<T>
    : never;

type FallbackTableName<Schema> = [keyof Schema & string] extends [never]
  ? string
  : never;

type SafeParser = {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error?: unknown };
};

export type SmithersCtxOptions = {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: unknown;
  auth?: RunAuthContext | null;
  outputs: OutputSnapshot;
  zodToKeyName?: Map<any, string>;
  runtimeConfig?: SmithersRuntimeConfig;
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

export class SmithersCtx<Schema = unknown> {
  readonly runId: string;
  readonly iteration: number;
  readonly iterations?: Record<string, number>;
  readonly input: Schema extends { input: infer T }
    ? T extends z.ZodTypeAny
      ? z.infer<T>
      : T
    : any;
  readonly auth: RunAuthContext | null;
  readonly __smithersRuntime?: SmithersRuntimeConfig | null;
  readonly outputs: OutputAccessor<Schema>;

  private readonly _outputs: OutputSnapshot;
  private readonly _zodToKeyName?: Map<any, string>;
  private readonly _currentScopes: Set<string>;

  constructor(opts: SmithersCtxOptions) {
    this.runId = opts.runId;
    this.iteration = opts.iteration;
    this.iterations = withLogicalIterationShortcuts(opts.iterations);
    this.input = normalizeInputRow(opts.input) as any;
    this.auth = opts.auth ?? null;
    this.__smithersRuntime = opts.runtimeConfig ?? null;
    this._outputs = opts.outputs;
    this._zodToKeyName = opts.zodToKeyName;
    this._currentScopes = buildCurrentScopes(this.iterations);

    const outputsFn: any = (table: string) => opts.outputs[table] ?? [];
    for (const [name, rows] of Object.entries(opts.outputs)) {
      outputsFn[name] = rows;
    }
    this.outputs = outputsFn as OutputAccessor<Schema>;
  }

  output(table: FallbackTableName<Schema>, key: OutputKey): any;
  output<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V>
    : InferOutputEntry<V>;
  output<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]>;
  output(table: any, key: OutputKey): any {
    const row = this.resolveRow(table, key);
    if (!row) {
      throw new SmithersError(
        "MISSING_OUTPUT",
        `Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`,
        { nodeId: key.nodeId, iteration: key.iteration ?? 0 },
      );
    }
    return row;
  }

  outputMaybe(table: FallbackTableName<Schema>, key: OutputKey): any | undefined;
  outputMaybe<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;
  outputMaybe<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]> | undefined;
  outputMaybe(table: any, key: OutputKey): any {
    return this.resolveRow(table, key);
  }

  latest<V extends z.ZodTypeAny>(
    table: V,
    nodeId: string,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;
  latest<K extends keyof Schema & string>(
    table: K,
    nodeId: string,
  ): InferOutputEntry<Schema[K]> | undefined;
  latest(table: FallbackTableName<Schema>, nodeId: string): any | undefined;
  latest(table: any, nodeId: string): any {
    const tableName = this.resolveTableName(table);
    const rows = this._outputs[tableName] ?? [];
    const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
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
  }

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
  }

  iterationCount(table: any, nodeId: string): number {
    const tableName = this.resolveTableName(table);
    const rows = this._outputs[tableName] ?? [];
    const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
    const seen = new Set<number>();
    for (const row of matching) {
      const iter = Number.isFinite(Number(row.iteration))
        ? Number(row.iteration)
        : 0;
      seen.add(iter);
    }
    return seen.size;
  }

  private resolveTableName(table: any): string {
    if (typeof table === "string") return table;
    const zodKey = this._zodToKeyName?.get(table);
    if (zodKey) return zodKey;
    return resolveDrizzleName(table) ?? String(table);
  }

  private resolveRow(table: any, key: OutputKey): any | undefined {
    const tableName = this.resolveTableName(table);
    const rows = this._outputs[tableName] ?? [];
    const matching = filterRowsByNodeId(rows, key.nodeId, this._currentScopes);
    return matching.find((row) => {
      return (row.iteration ?? 0) === (key.iteration ?? this.iteration);
    });
  }
}
