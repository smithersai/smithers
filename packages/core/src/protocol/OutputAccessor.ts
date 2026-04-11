import type { InferOutputEntry } from "./InferOutputEntry";

export type { InferRow } from "./InferRow";
export type { InferOutputEntry } from "./InferOutputEntry";

type FallbackTableName<Schema> = [keyof Schema & string] extends [never]
  ? string
  : never;

export type OutputAccessor<Schema> = {
  (table: FallbackTableName<Schema>): Array<any>;
  <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
} & {
  [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};
