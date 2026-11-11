import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Event } from "../src/index.ts"
import { apply, empty, initialConfig, parseLine, renderEvent, renderState, replay } from "../src/index.ts"
import { play, standard } from "./support/Scenario.ts"

const events: ReadonlyArray<readonly [string, Event]> = [
  ["enqueue 3 5", { _tag: "enqueue", id: 3, priority: 5 }],
  ["withdraw 3", { _tag: "withdraw", id: 3 }],
  ["result 2 1 pass 30", { _tag: "result", run: 2, check: 1, verdict: "pass", duration: 30 }],
  ["result 2 1 fail 0", { _tag: "result", run: 2, check: 1, verdict: "fail", duration: 0 }],
  ["fixed 3 1", { _tag: "fixed", id: 3, attempt: 1 }],
  ["gaveup 3 1 needs a rewrite", { _tag: "gaveUp", id: 3, attempt: 1, detail: "needs a rewrite" }],
  ["foreign 9", { _tag: "foreign", id: 9 }],
  ["start 2", { _tag: "start", count: 2 }],
  ["push 0", { _tag: "push", run: 0 }],
  ["land 0", { _tag: "land", run: 0 }],
  ["blame 0", { _tag: "blame", run: 0 }],
  ["cancel 0", { _tag: "cancel", run: 0 }]
]

describe("parseLine and renderEvent", () => {
  it.each(events)("%s round-trips", (text, event) => {
    expect(parseLine(text)).toEqual({ _tag: "event", event })
    expect(renderEvent(event)).toBe(text)
  })

  it("reads a verdict with no words as an empty detail", () => {
    expect(parseLine("gaveup 3 1")).toEqual({ _tag: "event", event: { _tag: "gaveUp", id: 3, attempt: 1, detail: "" } })
  })

  it("reads plan and config lines", () => {
    expect(parseLine("plan")).toEqual({ _tag: "plan" })
    expect(parseLine("config")).toEqual({ _tag: "config", config: initialConfig })
    expect(parseLine("config required=4,5 maxAttempts=2 maxBatch=3 maxRuns=4 window=5 defaultDuration=6")).toEqual({
      _tag: "config",
      config: { required: [4, 5], maxAttempts: 2, maxBatch: 3, maxRuns: 4, window: 5, defaultDuration: 6 }
    })
    expect(parseLine("config required=")).toEqual({ _tag: "config", config: initialConfig })
  })

  it.each([
    "",
    "bogus",
    "bogus 1",
    "bogus 1 2",
    "plan now",
    "enqueue 1",
    "enqueue x 2",
    "enqueue 1 2 3",
    "withdraw",
    "withdraw -1",
    "land 1.5",
    "result 0 1 maybe 3",
    "result 0 1 pass",
    "result x 1 pass 3",
    "result 0 x pass 3",
    "result 0 1 pass x",
    "result 0 1 pass 3 4",
    "gaveup x 1 words",
    "gaveup 1 x words",
    "gaveup 1",
    "config required",
    "config required=1,x",
    "config maxRuns=x",
    "config maxRuns=x window=1",
    "config unknown=1",
    "config a=b=c"
  ])("refuses %j", (text) => {
    expect(parseLine(text)).toBeUndefined()
  })
})

describe("renderState", () => {
  it("shows every field of the state and everything derived from it", () => {
    const { config, state } = play(
      "config required=1,2 maxAttempts=1 maxBatch=2 maxRuns=2 window=3 defaultDuration=60",
      "enqueue 10 5",
      "enqueue 11 5",
      "enqueue 12 9",
      "plan",
      "plan",
      "result 0 1 pass 30",
      "result 0 2 pass 50",
      "plan",
      "land 0",
      "result 1 1 fail 10",
      "plan"
    )
    expect(renderState(config, state)).toBe(
      "main=12.0,10.0 | changes=10:p5:s0:r0:a0:merged;11:p5:s1:r0:a1:fixing(1);12:p9:s2:r0:a0:merged"
        + " | runs=1:/12.0,10.0,11.0:1f | next=2,3 | pushing=- | landed=0:/12.0,10.0:1p,2p | history=1:30,2:50,1:10"
        + " | ready= | plan=wait | ci=1@50:2 | fix=11.0#1:1:"
    )
  })

  it("shows an unmergeable change's reason, a withdrawn change and who is ahead of a fix", () => {
    const { config, state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "enqueue 3 0",
      "start 1",
      "result 0 1 fail 4",
      "blame 0",
      "gaveup 1 1 needs a rewrite",
      "withdraw 2",
      "enqueue 4 9",
      "cancel 0",
      "start 1",
      "result 1 2 fail 4",
      "blame 1",
      "enqueue 5 9",
      "foreign 77"
    )
    expect(renderState(config, state)).toBe(
      "main=77.0 | changes=1:p0:s0:r0:a1:unmergeable(agentVerdict;1;1;needs a rewrite);2:p0:s1:r0:a0:withdrawn;"
        + "3:p0:s2:r0:a0:queued;4:p9:s3:r0:a1:fixing(1);5:p9:s4:r0:a0:queued;77:p0:s5:r0:a0:merged"
        + " | runs=1:/4.0:2f | next=2,6 | pushing=- | landed=foreign:/77.0 | history=1:4,2:4 | ready=5,3"
        + " | plan=start 2 | ci=1@4:1 | fix=4.0#1:2:"
    )
  })
})

describe("apply and replay", () => {
  it("a config line restarts the queue from empty", () => {
    const { config, state } = play(standard, "enqueue 1 0", "config required=7")
    expect(state).toEqual(empty)
    expect(config.required).toEqual([7])
  })

  it("plan with nothing to decide leaves the state as it is", () => {
    const { config, state } = play(standard)
    expect(apply(config, state, { _tag: "plan" })).toEqual([config, state])
  })

  it("replay prints one line per input line and `error` for a line it cannot read", () => {
    expect(replay(["enqueue 1 0", "bogus", "plan"])).toEqual([
      "main= | changes=1:p0:s0:r0:a0:queued | runs= | next=0,1 | pushing=- | landed= | history= | ready=1"
      + " | plan=start 1 | ci= | fix=",
      "error",
      "main= | changes=1:p0:s0:r0:a0:queued | runs=0:/1.0: | next=1,1 | pushing=- | landed= | history= | ready=1"
      + " | plan=wait | ci= | fix="
    ])
  })
})

describe("scenarios the reference printed", () => {
  it.each(["land-and-fix", "bisect", "moved-target"])("%s matches the Lean reference line for line", (name) => {
    const read = (kind: string) =>
      readFileSync(new URL(`./fixtures/${name}.${kind}`, import.meta.url), "utf8").split("\n").slice(0, -1)
    expect(replay(read("trace"))).toEqual(read("expected"))
  })
})
