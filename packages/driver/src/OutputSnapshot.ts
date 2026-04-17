export type OutputSnapshot<TFallback = unknown> = {
  [tableName: string]: Array<TFallback>;
};
