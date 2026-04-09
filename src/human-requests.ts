export const HUMAN_REQUEST_KINDS = ["ask", "confirm", "select", "json"] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];

export const HUMAN_REQUEST_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "expired",
] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];

export function buildHumanRequestId(
  runId: string,
  nodeId: string,
  iteration: number,
): string {
  return `human:${runId}:${nodeId}:${iteration}`;
}

export function isHumanTaskMeta(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(meta?.humanTask);
}

export function getHumanTaskPrompt(
  meta: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  const prompt = meta?.prompt;
  return typeof prompt === "string" && prompt.trim().length > 0
    ? prompt
    : fallback;
}
