export function parseStateKey(key: string): {
  readonly nodeId: string;
  readonly iteration: number;
} {
  const separator = key.lastIndexOf("::");
  if (separator < 0) {
    return { nodeId: key, iteration: 0 };
  }
  const iteration = Number(key.slice(separator + 2));
  return {
    nodeId: key.slice(0, separator),
    iteration: Number.isFinite(iteration) ? iteration : 0,
  };
}
