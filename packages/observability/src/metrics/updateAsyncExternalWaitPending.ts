import { Effect, Metric } from "effect";
import { asyncExternalWaitCounts } from "./_asyncExternalWaitCounts";
import { externalWaitAsyncPending } from "./externalWaitAsyncPending";

export function updateAsyncExternalWaitPending(
  kind: "approval" | "event",
  delta: number,
): Effect.Effect<void> {
  return Effect.sync(() => {
    asyncExternalWaitCounts[kind] = Math.max(
      0,
      asyncExternalWaitCounts[kind] + delta,
    );
    return asyncExternalWaitCounts[kind];
  }).pipe(
    Effect.flatMap((value) =>
      Metric.set(Metric.tagged(externalWaitAsyncPending, "kind", kind), value),
    ),
  );
}
