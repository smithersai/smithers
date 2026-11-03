/**
 * The one control that is not a brake.
 *
 * The cases fix three things, in the order the module cares about them: what
 * counts as half of the evidence, what counts as the other half, and what the
 * ordering between them has to be. The last is where a signal like this goes
 * wrong — a pair read off the wrong side of an edit reports a run's own
 * baseline back to it as proof — so the frame that also mutated is tested from
 * both ends.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as Sufficiency from "../src/Sufficiency.ts"
import * as UnresolvedFailure from "../src/UnresolvedFailure.ts"
import waveNine from "./fixtures/completionJournals.json" with { type: "json" }
import waveTen from "./fixtures/wave10Journals.json" with { type: "json" }

type Journal = typeof waveNine.journals[number]

const command = (text: string): Schema.Json => ({ mode: "unhermetic", command: text })

const ran = (
  text: string,
  options: {
    readonly failing?: boolean | undefined
    readonly passing?: boolean | undefined
    readonly stable?: boolean | undefined
  } = {}
): NarrowedCheck.Check => {
  const input = command(text)
  const recorded = NarrowedCheck.check({
    flow: "bash",
    signature: `bash:${JSON.stringify(input)}`,
    input,
    digest: "tree",
    failing: options.failing ?? false,
    passing: options.passing ?? false,
    stable: options.stable ?? true
  })
  if (recorded === undefined) throw new Error("the fixture input is not a check")
  return recorded
}

const failedAt = (text: string, epoch: number): Sufficiency.Ledger =>
  Sufficiency.remember([], { frame: [ran(text, { failing: true })], epoch })

describe("Sufficiency.remember", () => {
  it("records a failing check against the epoch it failed in", () => {
    const ledger = failedAt("check a/b.py", 0)

    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.epoch).toBe(0)
    expect(ledger[0]?.flow).toBe("bash")
    expect(ledger[0]?.label).toContain("check a/b.py")
  })

  it("records nothing for a check that reported no failure", () => {
    expect(Sufficiency.remember([], { frame: [ran("check a/b.py", { passing: true })], epoch: 0 })).toEqual([])
  })

  it("drops a failure watched in a frame that also changed the workspace", () => {
    // A frame's calls are not ordered against its edits in anything the harness
    // records, so this check might have failed before the change or after it —
    // and a failure stamped on the wrong side of an edit is the false
    // before-and-after this module exists to never manufacture.
    expect(
      Sufficiency.remember([], { frame: [ran("check a/b.py", { failing: true, stable: false })], epoch: 0 })
    ).toEqual([])
  })

  it("restamps a check that failed again over a later epoch", () => {
    const first = failedAt("check a/b.py", 0)
    const other = Sufficiency.remember(first, { frame: [ran("check c/d.py", { failing: true })], epoch: 0 })
    const again = Sufficiency.remember(other, { frame: [ran("check a/b.py", { failing: true })], epoch: 1 })

    expect(again.map((entry) => entry.epoch)).toEqual([0, 1])
    expect(again[1]?.label).toContain("check a/b.py")
  })

  it("forgets its oldest failures first once the bound is reached", () => {
    const many = Array.from(
      { length: Sufficiency.retained + 2 },
      (_, index) => ran(`check ${index}`, { failing: true })
    )

    const ledger = Sufficiency.remember([], { frame: many, epoch: 0 })

    expect(ledger).toHaveLength(Sufficiency.retained)
    expect(ledger[0]?.label).toContain("check 2")
  })
})

describe("Sufficiency.find", () => {
  it("names the pair when the same check failed before the change and passed after", () => {
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })

    expect(found?.failed.label).toContain("check a/b.py")
    expect(found?.passed.label).toContain("check a/b.py")
  })

  it("accepts a broader check passing than the one that failed", () => {
    // A broader reading passing is stronger evidence than the narrow one
    // passing, never weaker, so it is admitted as the other half.
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py -k one", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })

    expect(found?.failed.label).toContain("-k one")
    expect(found?.passed.label).not.toContain("-k one")
  })

  it("says nothing when the passing check asks about something else", () => {
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check c/d.py", { passing: true })],
      epoch: 1
    })).toBeUndefined()
  })

  it("does not pair test failures with broader lint readings of the same path", () => {
    const failed = NarrowedCheck.check({
      flow: "test",
      signature: "test:narrow",
      input: { path: "a/b.ts", filter: "case" },
      digest: "before",
      failing: true,
      stable: true
    })!
    const passed = NarrowedCheck.check({
      flow: "lint",
      signature: "lint:broad",
      input: { path: "a/b.ts" },
      digest: "after",
      passing: true,
      stable: true
    })!
    const ledger = Sufficiency.remember([], { frame: [failed], epoch: 0 })

    expect(NarrowedCheck.narrows(failed.terms, passed.terms)).toBe(true)
    expect(Sufficiency.find({ ledger, frame: [passed], epoch: 1 })).toBeUndefined()
    expect(
      Sufficiency.find({
        ledger,
        frame: [new NarrowedCheck.Check({ ...passed, flow: "test", signature: "test:broad" })],
        epoch: 1
      })?.failed
    ).toBe(ledger[0])
  })

  it("rejects a pass taken before an edit in the same frame", () => {
    // CellTurn stamps live readings from a mutating frame with stable: false
    // and passes the frame's closing epoch, even if the check preceded the edit.
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py", { passing: true, stable: false })],
      epoch: 1
    })).toBeUndefined()
  })

  it("accepts a stable passing reading attributed to a checkpoint after an edit", () => {
    // Checkpoint attribution is represented by stable: true; a checkpoint
    // reading has no live workspace digest.
    const passed = new NarrowedCheck.Check({
      ...ran("check a/b.py", { passing: true, stable: true }),
      digest: ""
    })

    expect(
      Sufficiency.find({
        ledger: failedAt("check a/b.py", 0),
        frame: [passed],
        epoch: 1
      })?.passed
    ).toBe(passed)
  })

  it("ignores an unstable broader pass when choosing the strongest evidence", () => {
    const ledger = failedAt("check a/b.py -k one", 0)
    const stable = ran("check a/b.py -k one", { passing: true })
    const unstable = ran("check a/b.py", { passing: true, stable: false })

    expect(Sufficiency.find({ ledger, frame: [unstable, stable], epoch: 1 })?.passed).toBe(stable)
    expect(Sufficiency.find({ ledger, frame: [stable, unstable], epoch: 1 })?.passed).toBe(stable)
  })

  it("says nothing when the check that answers reported no exit status at all", () => {
    // Silence is not a pass. Without this a file read would be half of a
    // completion signal, which is the shape of every hollow completion the
    // other controls exist to catch.
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py")],
      epoch: 1
    })).toBeUndefined()
  })

  it("says nothing while nothing has changed since the check failed", () => {
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 1),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })).toBeUndefined()
  })

  it("says nothing when the run has watched nothing fail", () => {
    expect(Sufficiency.find({ ledger: [], frame: [ran("check a/b.py", { passing: true })], epoch: 1 }))
      .toBeUndefined()
  })

  it("quotes the broadest passing check rather than the first one it finds", () => {
    const ledger = failedAt("check a/b.py -k one", 0)
    const narrow = ran("check a/b.py -k one", { passing: true })
    const broad = ran("check a/b.py", { passing: true })

    expect(Sufficiency.find({ ledger, frame: [narrow, broad], epoch: 1 })?.passed.label).toBe(broad.label)
    expect(Sufficiency.find({ ledger, frame: [broad, narrow], epoch: 1 })?.passed.label).toBe(broad.label)
  })

  it("quotes the most recent failure the passing check answers", () => {
    const older = failedAt("check a/b.py -k one", 0)
    const ledger = Sufficiency.remember(older, {
      frame: [ran("check a/b.py -k two", { failing: true })],
      epoch: 0
    })

    expect(Sufficiency.find({ ledger, frame: [ran("check a/b.py", { passing: true })], epoch: 1 })?.failed.label)
      .toContain("-k two")
  })

  it("says nothing in a frame that also watched a check fail", () => {
    // The shape one graded instance has lost to for six consecutive waves: the
    // narrow probe goes green and the broad check beside it stays red. The pair
    // is real, and it is at best half of what the frame is holding — so the
    // harness does not pick the good half out and hand it back as "evidence
    // held". It says nothing and lets the run finish reading.
    const ledger = failedAt("check a/b.py -k one", 0)
    const passed = ran("check a/b.py -k one", { passing: true })
    const suite = ran("check a/", { failing: true })

    expect(Sufficiency.find({ ledger, frame: [passed], epoch: 1 })).toBeDefined()
    expect(Sufficiency.find({ ledger, frame: [passed, suite], epoch: 1 })).toBeUndefined()
    expect(Sufficiency.find({ ledger, frame: [suite, passed], epoch: 1 })).toBeUndefined()
  })
})

describe("Sufficiency.observation", () => {
  it("quotes both readings, asks for nothing, and says it is written once", () => {
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })
    const text = Sufficiency.observation(found!)

    expect(text).toContain("check a/b.py")
    expect(text).toContain("failed, before the workspace changed")
    expect(text).toContain("passed, after it changed")
    // The whole point of the counterweight: it is not a demand, and it says so
    // in the same breath as it names the two things the run may do next.
    expect(text).toContain("Nothing is being asked of you and nothing has been refused")
    expect(text).toContain("complete now")
    expect(text).toContain("which reading is still missing")
    expect(text).toContain("written once per run")
  })
})

describe("Sufficiency.Ledger", () => {
  it("decodes an absent ledger as an empty one", () => {
    const Holder = Schema.Struct({ failures: Sufficiency.Ledger })

    expect(Effect.runSync(Schema.decodeUnknownEffect(Holder)({}))).toEqual({ failures: [] })
  })
})

/**
 * The signal, replayed over the ten runs two graded waves recorded.
 *
 * The fixtures are the same two `narrowing-journals.mjs` distillations the
 * completion demands replay, and the driver is the controller's own ordering:
 * a frame's checks are its successful non-writing calls, the epoch is the run's
 * count of frames that changed the workspace, and the observation is only ever
 * consulted on a frame that settled a `continue` — a run at its `complete`
 * transition has already decided, and that branch returns before this one.
 *
 * It says something to two of the ten, once each, and nothing to the other
 * eight. Wave 10's pytest instance is the one to watch: it closed its pair and
 * completed in the same frame, so the signal never reaches it and
 * `NarrowedCheck.findOnly` is what that completion hears.
 */
describe("Sufficiency over the recorded waves", () => {
  const replay = (journal: Journal): ReadonlyArray<{ readonly frame: number; readonly passed: string }> => {
    let failures: Sufficiency.Ledger = []
    let mutations = 0
    let stated = false
    const fired: Array<{ readonly frame: number; readonly passed: string }> = []
    let index = 0
    for (const frame of journal.frames) {
      index = index + 1
      const digest = frame.basis === "observed" ? frame.digest : ""
      // `CellTurn` stamps a check stable when it read the tree the frame closed
      // on, and the frame's calls settle in order, so the answer is where the
      // check sits relative to the frame's last standing write. A frame that
      // moved with nothing declaring it places nothing.
      const standingAt = frame.calls.map((call) => call.mutates && (call.ok || frame.basis !== "observed"))
      const lastStandingWrite = standingAt.lastIndexOf(true)
      const unattributed = frame.mutated && lastStandingWrite === -1
      const checks = frame.calls.flatMap((call, position) => {
        if (!call.ok || call.mutates) return []
        const result = ("exit" in call ? { exitCode: call.exit } : {}) as Schema.Json
        const probe = "probe" in call
        const recorded = NarrowedCheck.check({
          flow: call.flow,
          signature: `${call.flow}:${JSON.stringify(call.input)}`,
          input: call.input as Schema.Json,
          digest,
          failing: !probe && UnresolvedFailure.failed(result),
          passing: !probe && UnresolvedFailure.passed(result),
          stable: !unattributed && position > lastStandingWrite
        })
        return recorded === undefined ? [] : [recorded]
      })
      const epoch = mutations + (frame.mutated ? 1 : 0)
      const remembered = Sufficiency.remember(failures, { frame: checks, epoch: mutations })
      if (!stated && frame.transition === "continue") {
        const found = Sufficiency.find({ ledger: remembered, frame: checks, epoch })
        if (found !== undefined) {
          stated = true
          fired.push({ frame: index, passed: found.passed.label })
        }
      }
      failures = remembered
      mutations = epoch
    }
    return fired
  }

  const fires = [
    // Frame 11 both edits and, after the edit, re-runs the check that was red:
    // the loop a real agent runs, and the frame the pair completes in.
    ["wave 9", waveNine.journals, "pytest-dev__pytest-6197", 11],
    ["wave 10", waveTen.journals, "astropy__astropy-8707", 8]
  ] as const

  for (const [wave, runs, instance, frame] of fires) {
    it(`says so once to ${wave}'s ${instance}, on frame ${frame}`, () => {
      const journal = runs.find((entry) => entry.instance === instance)
      if (journal === undefined) throw new Error(`the ${wave} fixture is missing ${instance}`)

      expect(replay(journal as Journal).map((found) => found.frame)).toEqual([frame])
    })

    it(`says nothing to the rest of ${wave}`, () => {
      for (const journal of runs) {
        if (journal.instance === instance) continue
        expect(replay(journal as Journal), journal.instance).toEqual([])
      }
    })
  }
})
