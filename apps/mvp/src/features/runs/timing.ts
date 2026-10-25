import { Clock, Effect, Metric } from "effect"

/** Content-free stages of a run navigation. Attempts are random navigation identifiers, never run or repository identifiers. */
type Stage = "match" | "page" | "inspection" | "changes" | "repo-runs" | "render"
type Phase = "start" | "ready" | "rows" | "loaded" | "failed" | "reused"
const elapsed = Metric.histogram("smithers_run_route_ms", {
  description: "Elapsed milliseconds from run route match, by stage and phase",
  boundaries: [0, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
})

/** One attempt keeps its clock even when another navigation starts. */
export const routeTiming = Effect.gen(function* () {
  return {
    begin: Effect.gen(function* () {
      const routeAttempt = crypto.randomUUID()
      const started = yield* Clock.currentTimeMillis
      const record = (stage: Stage, phase: Phase, rows?: number) => Effect.gen(function* () {
        const elapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - started)
        yield* Metric.update(Metric.withAttributes(elapsed, { stage, phase }), elapsedMs)
        yield* Effect.logInfo("run.route.stage").pipe(Effect.annotateLogs({
          feature: "runs", routeAttempt, stage, phase, elapsedMs, ...(rows === undefined ? {} : { rows }),
        }))
      }).pipe(Effect.withSpan("run.route.stage"))
      let rendered = false
      yield* record("match", "start")
      return {
        record,
        rendered: Effect.gen(function* () {
          if (rendered) return
          rendered = true
          yield* record("render", "ready")
        }),
      }
    }),
  }
})
export type RouteTiming = Effect.Success<Effect.Success<typeof routeTiming>["begin"]>
