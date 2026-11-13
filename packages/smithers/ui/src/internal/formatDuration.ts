/** Format elapsed seconds, carrying rounded values across unit boundaries. */
export function formatDuration(durationSeconds: number, precision: "seconds" | "milliseconds" = "seconds"): string {
  if (precision === "milliseconds") {
    const milliseconds = Math.round(durationSeconds * 1000);
    if (milliseconds < 1000) return `${milliseconds}ms`;
    const tenths = Math.round(durationSeconds * 10);
    if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  }
  const seconds = Math.round(durationSeconds);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
