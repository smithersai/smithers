export type InferRow<TTable> = TTable extends { $inferSelect: infer R }
  ? R
  : never;
