export function newRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}
