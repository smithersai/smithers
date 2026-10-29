import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Metric } from "effect"

export interface InitialSnapshot {
  readonly preload: Effect.Effect<void, Collection.LoadFailed>
  readonly currentApplied: Effect.Effect<void>
}
export type LayoutSource = "item-summaries" | "github-sync" | "triage-settings" | "github-writes" | "todos"
export const initialSnapshots = Metric.counter("smithers_shape_initial_applied", { description: "Initial shape snapshots installed, by source", incremental: true })

/** Observe the real decoding/persistence barrier; a download alone never certifies installed controls. */
export const observeInitialApplied = (shape: InitialSnapshot, source: LayoutSource, repository: string) =>
  Effect.gen(function* () {
    yield* shape.preload
    yield* shape.currentApplied
    yield* Metric.update(Metric.withAttributes(initialSnapshots, { source }), 1)
    yield* Effect.logInfo("shape.initial.applied").pipe(Effect.annotateLogs({ source, repository }))
  }).pipe(Effect.withSpan("shape.initial.apply"), Effect.ignore)

export const SHAPE_APPLIED_TELEMETRY = {
  records: ["shape.initial.applied", "shape.initial.apply", "smithers_shape_initial_applied"],
  fields: ["source", "repository"],
} as const
