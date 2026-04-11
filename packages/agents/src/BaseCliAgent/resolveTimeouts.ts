type TimeoutInput = number | { totalMs?: number; idleMs?: number } | undefined;

export function resolveTimeouts(
  timeout: TimeoutInput,
  fallback?: { totalMs?: number; idleMs?: number },
): { totalMs?: number; idleMs?: number } {
  if (typeof timeout === "number") {
    return { totalMs: timeout };
  }
  if (timeout && typeof timeout === "object") {
    return {
      totalMs: typeof timeout.totalMs === "number" ? timeout.totalMs : fallback?.totalMs,
      idleMs: typeof timeout.idleMs === "number" ? timeout.idleMs : fallback?.idleMs,
    };
  }
  return {
    totalMs: fallback?.totalMs,
    idleMs: fallback?.idleMs,
  };
}
