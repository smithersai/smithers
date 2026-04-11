export function stripAutoColumns(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } =
    payload as Record<string, unknown>;
  return rest;
}
