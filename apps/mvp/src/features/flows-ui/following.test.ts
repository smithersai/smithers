// How the flows tab follows a draft's rounds on this device's engine (./following.ts): an engine's refusal to read a
// run, Draft again's round, and which reads of the shown round are shown. The engine is given as what it answers.
import { BrowserEngine } from "@smthrs/platform-browser"
import { Effect, Option } from "effect"
import { describe, expect, test } from "vitest"
import { nextRound, readRound, refusedRead } from "./following.vibe"
import type { RunStatus } from "./round"

/** An engine that holds `runs` by id, and can't be read for the ids in `unreadable`. */
const engine = (runs: Readonly<Record<string, RunStatus>>, unreadable: ReadonlyArray<string> = []) => {
  const asked: Array<string> = []
  const statusOf = (runId: string) =>
    Effect.sync(() => {
      asked.push(runId)
      return unreadable.includes(runId) ? Option.none<RunStatus>() : Option.some(runs[runId] ?? "absent")
    })
  return { statusOf, asked }
}

describe("refusedRead", () => {
  test("a run the engine never held is absent; any other refusal or failure is unreadable", () => {
    expect(refusedRead(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })))
      .toEqual(Option.some("absent"))
    expect(refusedRead(new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/Other" })))
      .toEqual(Option.none())
    expect(refusedRead(new Error("worker gone"))).toEqual(Option.none())
  })
})

describe("nextRound", () => {
  test("starts the first round after the draft's that this engine holds no run of", async () => {
    const e = engine({ "d:0": "failed" })
    expect(await Effect.runPromise(nextRound(e.statusOf, "d", 0))).toEqual({ _tag: "Start", round: 1 })
    expect(e.asked).toEqual(["d:1"])
  })

  test("skips rounds whose runs here failed or stopped", async () => {
    const e = engine({ "d:1": "failed", "d:2": "cancelled" })
    expect(await Effect.runPromise(nextRound(e.statusOf, "d", 0))).toEqual({ _tag: "Start", round: 3 })
  })

  test("a later round started here and still going, or done with its row on the way, is pending: nothing starts", async () => {
    for (const status of ["pending", "running", "suspended", "completed"] as const) {
      expect([status, await Effect.runPromise(nextRound(engine({ "d:2": "failed", "d:3": status }).statusOf, "d", 1))])
        .toEqual([status, { _tag: "Pending", round: 3 }])
    }
  })

  test("an engine that can't be read says so", async () => {
    expect(await Effect.runPromise(nextRound(engine({}, ["d:1"]).statusOf, "d", 0))).toEqual({ _tag: "Unreadable" })
  })
})

describe("readRound", () => {
  const reading = (shown: Array<string | null>, e: ReturnType<typeof engine>) => {
    const written: Array<[string | null, RunStatus]> = []
    const effect = readRound({
      shownRunId: Effect.sync(() => (shown.length > 1 ? shown.shift()! : shown[0]!)),
      statusOf: e.statusOf,
      write: (runId, status) => Effect.sync(() => void written.push([runId, status])),
    })
    return { run: () => Effect.runPromise(effect), written }
  }

  test("writes what this engine says of the shown round, and absent when no round shows", async () => {
    const shown = reading(["d:0"], engine({ "d:0": "cancelled" }))
    await shown.run()
    expect(shown.written).toEqual([["d:0", "cancelled"]])
    const none = reading([null], engine({}))
    await none.run()
    expect(none.written).toEqual([[null, "absent"]])
  })

  test("an engine that can't be read writes nothing; nor does a read for a round the card stopped showing", async () => {
    const unreadable = reading(["d:0"], engine({}, ["d:0"]))
    await unreadable.run()
    expect(unreadable.written).toEqual([])
    // Another draft opened while the read waited.
    const moved = reading(["a:0", "b:0"], engine({ "a:0": "failed" }))
    await moved.run()
    expect(moved.written).toEqual([])
  })
})
