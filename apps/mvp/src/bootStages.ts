import { Effect, Metric } from "effect"

// The page's boot, as stages on its timeline (docs/decisions/0108-first-load.md): when each happened, in milliseconds
// from the page's start, marked once with `performance.mark` so DevTools, a test or the first-load benchmark
// (bench/first-load.ts) reads it, and recorded once the page renders as one `boot.stages` log and a histogram point per
// stage. Only stage names and times: no content.

/**
 * The stages, in the order a cold boot passes them:
 * - `page`: the app's bundle has loaded and runs (src/main.tsx);
 * - `worker`: this tab started its engine worker;
 * - `activation`: the device's owner check answered, so the device store may open or the page runs on memory;
 * - `store`: the device store opened, or failed and the page keeps its rows in memory;
 * - `services`: every layer the page renders with is built (src/boot.ts);
 * - `render`: the page rendered.
 */
export const BOOT_STAGES = ["page", "worker", "activation", "store", "services", "render"] as const

/** One of {@link BOOT_STAGES}. */
export type BootStage = (typeof BOOT_STAGES)[number]

/** The prefix of a stage's mark on the page's timeline: `smithers.boot.render`. */
export const STAGE_MARK = "smithers.boot."

/** Where stages are marked: the page's `performance`, or a test's. */
export type Timeline = Pick<Performance, "mark" | "getEntriesByName">

/** Marks `stage` on `timeline` the first time it is reached; a later pass, such as a second open, keeps the first. */
export const markStage = (timeline: Timeline, stage: BootStage): void => {
  if (timeline.getEntriesByName(STAGE_MARK + stage, "mark").length === 0) timeline.mark(STAGE_MARK + stage)
}

/** The stages marked so far, each in whole milliseconds from the page's start. */
export const stageTimes = (timeline: Timeline): Partial<Record<BootStage, number>> =>
  Object.fromEntries(
    BOOT_STAGES.flatMap((stage) => {
      const [mark] = timeline.getEntriesByName(STAGE_MARK + stage, "mark")
      return mark === undefined ? [] : [[stage, Math.round(mark.startTime)]]
    }),
  )

/** Milliseconds from the page's start to each boot stage, by `stage`. */
export const bootStageTime = Metric.histogram("smithers_web_boot_stage_ms", {
  description: "Milliseconds from page start to each boot stage",
  boundaries: Metric.exponentialBoundaries({ start: 50, factor: 2, count: 10 }),
})

/** Logs the stages marked on `timeline` as `boot.stages` and records each in `smithers_web_boot_stage_ms`. */
export const recordStages = (timeline: Timeline) =>
  Effect.gen(function* () {
    const times = stageTimes(timeline)
    for (const [stage, ms] of Object.entries(times)) {
      yield* Metric.update(Metric.withAttributes(bootStageTime, { stage }), ms)
    }
    yield* Effect.logInfo("boot.stages").pipe(Effect.annotateLogs(times))
  })
