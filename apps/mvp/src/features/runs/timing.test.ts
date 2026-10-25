import { Effect, Logger } from "effect"
import { expect, test } from "vitest"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { routeTiming } from "./timing"

test("route timing records content-free stages, keeps concurrent attempts separate and renders once", async () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  await Effect.runPromise(Effect.gen(function* () {
    const timing = yield* routeTiming
    const first = yield* timing.begin
    yield* first.record("inspection", "start")
    yield* first.record("inspection", "ready", 3)
    yield* first.rendered
    yield* first.rendered
    const second = yield* timing.begin
    yield* first.record("changes", "rows", 1)
    yield* second.rendered
  }).pipe(Effect.provide(Logger.layer([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))]))))
  expect(logs.map(({ annotations: a }) => [a.routeAttempt, a.stage, a.phase, a.rows])).toEqual([
    [1, "match", "start", undefined], [1, "inspection", "start", undefined], [1, "inspection", "ready", 3],
    [1, "render", "ready", undefined], [2, "match", "start", undefined], [1, "changes", "rows", 1], [2, "render", "ready", undefined],
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
