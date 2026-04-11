// TODO type should be type StateKey = `${string}::${number}` and then we should update anything that depends on it to also be the more specific type
export function buildStateKey(nodeId: string, iteration: number): string {
  return `${nodeId}::${iteration}`;
}
