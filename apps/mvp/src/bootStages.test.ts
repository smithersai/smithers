import { Effect, Logger, Metric } from "effect"
import { afterEach, expect, test } from "vitest"
import { BOOT_STAGES, bootStageTime, markStage, recordStages, STAGE_MARK, stageTimes } from "./bootStages"

// The boot's stages on a real timeline: Node's `performance`, as the page's.

afterEach(() => performance.clearMarks())

test("marks a stage the first time it is reached and keeps that mark when it is reached again", () => {
  markStage(performance, "store")
  const [first] = performance.getEntriesByName(`${STAGE_MARK}store`, "mark")
  markStage(performance, "store")
  expect(performance.getEntriesByName(`${STAGE_MARK}store`, "mark")).toEqual([first])
})

test("reads the stages marked so far, in whole milliseconds from the page's start, leaving out the rest", () => {
  markStage(performance, "render")
  markStage(performance, "page")
  const times = stageTimes(performance)
  expect(Object.keys(times)).toEqual(["page", "render"])
  expect(times.page).toBe(Math.round(performance.getEntriesByName(`${STAGE_MARK}page`, "mark")[0]!.startTime))
  expect(Number.isInteger(times.render)).toBe(true)
  // Marked in that order: the timeline keeps when each was marked, the read keeps the stages' order.
  expect(times.render! <= times.page!).toBe(true)
  expect(BOOT_STAGES).toEqual(["page", "worker", "activation", "store", "services", "render"])
})

test("records each marked stage once as a histogram point by stage, and logs them together", async () => {
  markStage(performance, "page")
  markStage(performance, "render")
  const logged: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const counts = await Effect.runPromise(
    recordStages(performance).pipe(
      Effect.andThen(Effect.all([
        Metric.value(Metric.withAttributes(bootStageTime, { stage: "page" })),
        Metric.value(Metric.withAttributes(bootStageTime, { stage: "render" })),
        Metric.value(Metric.withAttributes(bootStageTime, { stage: "store" })),
      ])),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void logged.push(Logger.formatStructured.log(options)))])),
    ),
  )
  expect(counts.map((value) => value.count)).toEqual([1, 1, 0])
  expect(logged.map(({ message, annotations }) => ({ message, annotations }))).toEqual([
    { message: "boot.stages", annotations: stageTimes(performance) },
  ])
})
