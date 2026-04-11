import type { z } from "zod";
import type { OutputAccessor } from "./OutputAccessor.ts";
import type { OutputKey } from "./OutputKey.ts";
import type { RunAuthContext } from "./RunAuthContext.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";

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

export interface SmithersCtx<Schema> {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: Schema extends { input: infer T }
    ? T extends z.ZodTypeAny
      ? z.infer<T>
      : T
    : any;
  auth: RunAuthContext | null;
  __smithersRuntime?: SmithersRuntimeConfig | null;
  outputs: OutputAccessor<Schema>;

  output(table: FallbackTableName<Schema>, key: OutputKey): any;

  // Overload: pass Zod schema value directly -> narrowed return type
  output<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V>
    : InferOutputEntry<V>;

  // Overload: pass string key -> narrowed via K
  output<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]>;

  outputMaybe(
    table: FallbackTableName<Schema>,
    key: OutputKey,
  ): any | undefined;

  // Overload: pass Zod schema value directly -> narrowed return type
  outputMaybe<V extends z.ZodTypeAny>(
    table: V,
    key: OutputKey,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;

  // Overload: pass string key -> narrowed via K
  outputMaybe<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]> | undefined;

  // Overload: pass Zod schema value directly -> narrowed return type
  latest<V extends z.ZodTypeAny>(
    table: V,
    nodeId: string,
  ): SchemaKeyForValue<Schema, V> extends never
    ? InferOutputEntry<V> | undefined
    : InferOutputEntry<V> | undefined;

  // Overload: pass string key -> narrowed via K
  latest<K extends keyof Schema & string>(
    table: K,
    nodeId: string,
  ): InferOutputEntry<Schema[K]> | undefined;

  latest(
    table: FallbackTableName<Schema>,
    nodeId: string,
  ): any | undefined;

  latestArray(value: unknown, schema: z.ZodType): any[];

  iterationCount(table: any, nodeId: string): number;
}
