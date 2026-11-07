// The windows remote flows start in, and their once-a-window start (worker/Flows.ts), which `ops/SpendAlert`
// (worker/ModelSpend.ts) and `ops/DatabaseLoad` (worker/flows/DatabaseLoad.ts) use. Starts go to a `FlowStarter` that
// records each one, or fails as the host refusing it; the clock is `TestClock`.
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import * as Flows from "./Flows.vibe"
import * as Pause from "./flows/Pause.vibe"

describe("windows", () => {
  test("lie end to end from the epoch", () => {
    const window = Duration.minutes(15)
    expect(Flows.windowAt(0, window)).toEqual({ from: 0, until: 900_000 })
    expect(Flows.windowAt(899_999, window)).toEqual({ from: 0, until: 900_000 })
    expect(Flows.windowAt(900_000, window)).toEqual({ from: 900_000, until: 1_800_000 })
  })
})

/** A start of `probe/Pause` for each window, named by it. */
const pauseFor = (window: Flows.Window): Flows.WindowStart => ({
  flow: Pause.Pause,
  executionId: `pause-${window.from}`,
  payload: { label: String(window.from), pauseMs: 0 },
})

/** Runs `use` with a start of a minute's windows over `starter`, on the test clock; returns what `notStarted` got. */
const withStarts = (
  starter: Flows.FlowStarter["Service"],
  use: (start: Effect.Effect<void>) => Effect.Effect<void>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const notStarted: Array<string> = []
      const start = yield* Flows.startEachWindow(
        Duration.minutes(1),
        pauseFor,
        (errorCode) => Effect.sync(() => void notStarted.push(errorCode)),
      )
      yield* use(start.pipe(Effect.provideService(Flows.FlowStarter, starter)))
      return notStarted
    }).pipe(Effect.provide(TestClock.layer())),
  )

/** A starter that records each start's execution id, and answers with `answer` for the start at that index. */
const recording = (answer: (index: number) => Effect.Effect<void, Flows.StartConflict | Flows.StartUnavailable> = () =>
  Effect.void) => {
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  const starter = Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) =>
      Effect.suspend(() => {
        starts.push({ flow: flow._tag, executionId, payload })
        return answer(starts.length - 1)
      }),
  })
  return { starts, starter }
}

describe("a start once a window", () => {
  test("starts the window's execution once, with its payload, then the next window's once it begins", async () => {
    const { starts, starter } = recording()
    const notStarted = await withStarts(starter, (start) =>
      Effect.gen(function* () {
        yield* start
        yield* TestClock.adjust("59 seconds")
        yield* start
        yield* TestClock.adjust("1 second")
        yield* start
        yield* start
      }))
    expect(starts).toEqual([
      { flow: "probe/Pause", executionId: "pause-0", payload: { label: "0", pauseMs: 0 } },
      { flow: "probe/Pause", executionId: "pause-60000", payload: { label: "60000", pauseMs: 0 } },
    ])
    expect(notStarted).toEqual([])
  })

  test("a start that finds the window's execution started already counts as started", async () => {
    const { starts, starter } = recording(() => Effect.fail(new Flows.StartConflict()))
    const notStarted = await withStarts(starter, (start) => Effect.andThen(start, start))
    expect(starts.map((each) => each.executionId)).toEqual(["pause-0"])
    expect(notStarted).toEqual([])
  })

  test("a start the host refuses or that dies is reported by its code, never its message; the next starts it", async () => {
    const { starts, starter } = recording((index) =>
      index === 0
        ? Effect.fail(new Flows.StartUnavailable({ errorCode: "object_unreachable" }))
        : index === 1
        ? Effect.die(new Error("the object said something private"))
        : Effect.void
    )
    const notStarted = await withStarts(starter, (start) => Effect.all([start, start, start, start]))
    expect(notStarted).toEqual(["object_unreachable", "unknown"])
    // The third run started it; the fourth found it started in this window.
    expect(starts.map((each) => each.executionId)).toEqual(["pause-0", "pause-0", "pause-0"])
  })

  test("each start keeps its own windows: two of them start the same window once each", async () => {
    const { starts, starter } = recording()
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Flows.startEachWindow(Duration.minutes(1), pauseFor, () => Effect.void)
        const second = yield* Flows.startEachWindow(Duration.minutes(1), pauseFor, () => Effect.void)
        yield* Effect.all([first, first, second, second]).pipe(Effect.provideService(Flows.FlowStarter, starter))
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(starts.map((each) => each.executionId)).toEqual(["pause-0", "pause-0"])
  })
})
