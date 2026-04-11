import { Effect } from "effect";

export function ignoreSyncError(
  _label: string,
  fn: () => void,
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      fn();
    } catch {
      // Best-effort cleanup intentionally swallows failures.
    }
  });
}
