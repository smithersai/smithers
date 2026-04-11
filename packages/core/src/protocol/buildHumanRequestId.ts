export function buildHumanRequestId(
  runId: string,
  nodeId: string,
  iteration: number,
): string {
  return `human:${runId}:${nodeId}:${iteration}`;
}
