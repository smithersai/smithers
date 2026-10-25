import { Effect, Logger, Metric } from "effect"
import { expect, test } from "vitest"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { routeTiming } from "./timing"

test("route timing records content-free stages, keeps concurrent attempts separate and renders once", async () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const snapshots = await Effect.runPromise(Effect.gen(function* () {
    const timing = yield* routeTiming
    const first = yield* timing.begin
    yield* first.record("inspection", "start")
    yield* Effect.sleep("20 millis")
    yield* first.record("inspection", "ready", 3)
    yield* first.rendered
    yield* first.rendered
    const second = yield* timing.begin
    yield* first.record("changes", "rows", 1)
    yield* second.rendered
    return yield* Metric.snapshot
  }).pipe(
    Effect.provide(Logger.layer([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ))
  const first = logs[0]!.annotations.routeAttempt
  const second = logs[4]!.annotations.routeAttempt
  expect(first).toMatch(/^[0-9a-f-]{36}$/)
  expect(second).toMatch(/^[0-9a-f-]{36}$/)
  expect(first).not.toBe(second)
  expect(logs[2]!.annotations.elapsedMs).toBeGreaterThanOrEqual(10)
  const histograms = snapshots.flatMap((snapshot) => snapshot.id === "smithers_run_route_ms" && snapshot.type === "Histogram"
    ? [{ attributes: snapshot.attributes, state: snapshot.state }] : [])
  expect(histograms.reduce((sum, histogram) => sum + histogram.state.count, 0)).toBe(logs.length)
  expect(histograms.reduce((sum, histogram) => sum + histogram.state.sum, 0)).toBeGreaterThanOrEqual(30)
  for (const histogram of histograms) expect(Object.keys(histogram.attributes ?? {}).sort()).toEqual(["phase", "stage"])
  expect(JSON.stringify(histograms)).not.toContain(first)
  expect(JSON.stringify(histograms)).not.toContain(second)
  expect(logs.map(({ annotations: a }) => [a.routeAttempt, a.stage, a.phase, a.rows])).toEqual([
    [first, "match", "start", undefined], [first, "inspection", "start", undefined], [first, "inspection", "ready", 3],
    [first, "render", "ready", undefined], [second, "match", "start", undefined], [first, "changes", "rows", 1], [second, "render", "ready", undefined],
  ])
  for (const log of logs) {
    expect(log.message).toBe("run.route.stage")
    expect(log.annotations.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Object.keys(log.annotations).sort()).toEqual((log.annotations.rows === undefined
      ? ["feature", "routeAttempt", "stage", "phase", "elapsedMs"]
      : ["feature", "routeAttempt", "stage", "phase", "elapsedMs", "rows"]).sort())
    for (const field of Object.keys(log.annotations)) expect(BROWSER_TELEMETRY.fields).toContain(field)
  }
  expect(BROWSER_TELEMETRY.records).toContain("run.route.stage")
  expect(BROWSER_TELEMETRY.records).toContain("smithers_run_route_ms")
})
