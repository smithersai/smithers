/**
 * The proof that was already true before anything changed.
 *
 * The cases fix three things: what a pristine-tree pass is, what a stored
 * verification is, and the one rule that connects them — the stored call has to
 * be the *same* call, by the controller's own signature, or the run is standing
 * on something else entirely. The last section replays the whole r92
 * full-benchmark wave, because a signal that reads a run's own state has to be
 * shown saying nothing to forty-four runs before it is worth hearing on the
 * forty-fifth.
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.vibe"
import * as Sufficiency from "../src/Sufficiency.vibe"
import * as UnresolvedFailure from "../src/UnresolvedFailure.vibe"
import * as VacuousVerification from "../src/VacuousVerification.vibe"
import wave from "./fixtures/vacuousJournals.json" with { type: "json" }

type Journal = typeof wave.journals[number]

const signatureOf = (flow: string, input: Schema.Json): string => `${flow}:${CanonicalJson.stringify(input)}`

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
    signature: signatureOf("bash", input),
    input,
    digest: "tree",
    failing: options.failing ?? false,
    passing: options.passing ?? true,
    stable: options.stable ?? true
  })
  if (recorded === undefined) throw new Error("the fixture input is not a check")
  return recorded
}

const pristine = (text: string): VacuousVerification.Ledger =>
  VacuousVerification.remember([], { frame: [ran(text)], epoch: 0, failed: [] })

describe("VacuousVerification.remember", () => {
  it("records a check that passed over the tree the run was handed", () => {
    const ledger = pristine("check a/b.py")

    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.flow).toBe("bash")
    expect(ledger[0]?.label).toContain("check a/b.py")
    expect(ledger[0]?.signature).toBe(signatureOf("bash", command("check a/b.py")))
  })

  it("records nothing once some earlier frame has changed the workspace", () => {
    // A pass taken after an edit says nothing about the tree the run was
    // handed, which is the only tree this ledger is about.
    expect(VacuousVerification.remember([], { frame: [ran("check a/b.py")], epoch: 1, failed: [] })).toEqual([])
  })

  it("records nothing from a frame that changed the workspace itself", () => {
    // A frame's calls are not ordered against its edits in anything the harness
    // records, so this check might have passed on either side of the change.
    // `Sufficiency` refuses the same stamp from the other direction.
    expect(
      VacuousVerification.remember([], { frame: [ran("check a/b.py", { stable: false })], epoch: 0, failed: [] })
    ).toEqual([])
  })

  it("records nothing for a check that reported no passing exit status", () => {
    // Silence is not a pass: a read or a search reports nothing about a
    // subject, and a run whose file reads counted as green proofs would be told
    // its verification was vacuous every time it stored one.
    expect(
      VacuousVerification.remember([], { frame: [ran("check a/b.py", { passing: false })], epoch: 0, failed: [] })
    ).toEqual([])
    expect(
      VacuousVerification.remember([], {
        frame: [ran("check a/b.py", { passing: false, failing: true })],
        epoch: 0,
        failed: []
      })
    ).toEqual([])
  })

  it("keeps the first entry when the same check passes again", () => {
    const first = pristine("check a/b.py")
    const again = VacuousVerification.remember(first, {
      frame: [ran("check a/b.py"), ran("check c/d.py")],
      epoch: 0,
      failed: []
    })

    expect(again.map((entry) => entry.label)).toEqual([first[0]?.label, ran("check c/d.py").label])
  })

  it("forgets its oldest passes first once the bound is reached", () => {
    const many = Array.from({ length: VacuousVerification.retained + 2 }, (_, index) => ran(`check ${index}`))

    const ledger = VacuousVerification.remember([], { frame: many, epoch: 0, failed: [] })

    expect(ledger).toHaveLength(VacuousVerification.retained)
    expect(ledger[0]?.label).toContain("check 2")
  })

  it("records nothing for a check this run has already watched fail on that same tree", () => {
    // The reading that takes the observation back. A command the run watched
    // exit non-zero before any edit is a command it has done the contract's
    // work on; a later green reading of it at the same epoch says the command
    // is unsteady, not that no red was ever seen. Admitting it would let the
    // harness tell a run its proof "was already green" in a sentence the run's
    // own journal refutes.
    expect(
      VacuousVerification.remember([], {
        frame: [ran("check a/b.py")],
        epoch: 0,
        failed: [signatureOf("bash", command("check a/b.py"))]
      })
    ).toEqual([])
  })

  it("forgets a pass it had already recorded once the same check is watched failing", () => {
    // The two readings can arrive in either order, and the refusal has to hold
    // in both. Here the pass came first.
    const first = pristine("check a/b.py")
    expect(first).toHaveLength(1)

    expect(
      VacuousVerification.remember(first, {
        frame: [ran("check a/b.py", { passing: false, failing: true })],
        epoch: 0,
        failed: [signatureOf("bash", command("check a/b.py"))]
      })
    ).toEqual([])
  })

  it("keeps the passes a pre-edit failure says nothing about", () => {
    const ledger = VacuousVerification.remember([], {
      frame: [ran("check a/b.py"), ran("check c/d.py")],
      epoch: 0,
      failed: [signatureOf("bash", command("check c/d.py"))]
    })

    expect(ledger.map((entry) => entry.signature)).toEqual([signatureOf("bash", command("check a/b.py"))])
  })
})

describe("VacuousVerification.stored", () => {
  it("reads the flow and input a cell stored under verification", () => {
    expect(VacuousVerification.stored({ verification: { flow: "bash", input: command("check a/b.py") } }))
      .toEqual({ flow: "bash", input: command("check a/b.py") })
  })

  it("reads a verification whose input is any JSON the flow accepts", () => {
    expect(VacuousVerification.stored({ verification: { flow: "test", input: null } }))
      .toEqual({ flow: "test", input: null })
  })

  it("reads nothing out of a state that stored no verification at all", () => {
    for (
      const state of [
        null,
        "verification",
        ["verification"],
        {},
        { verification: null },
        { verification: "check a/b.py" },
        { verification: ["bash", "check a/b.py"] },
        { verification: { input: command("check a/b.py") } },
        { verification: { flow: 7, input: command("check a/b.py") } },
        { verification: { flow: "bash" } }
      ] as ReadonlyArray<Schema.Json>
    ) {
      expect(VacuousVerification.stored(state), JSON.stringify(state)).toBeUndefined()
    }
  })
})

describe("VacuousVerification.find", () => {
  it("names the pass a stored verification is standing on", () => {
    const found = VacuousVerification.find({
      ledger: pristine("check a/b.py"),
      signature: signatureOf("bash", command("check a/b.py")),
      stated: []
    })

    expect(found?.label).toContain("check a/b.py")
  })

  it("says nothing when the stored check is not the one that passed", () => {
    // The contract asks a run to reuse its baseline byte for byte, so a
    // broadened or narrowed command is a different call and a different
    // question. Reading it as this failure would be the harness guessing.
    for (const stored of ["check a/b.py -k one", "check a/", "check c/d.py"]) {
      expect(
        VacuousVerification.find({
          ledger: pristine("check a/b.py"),
          signature: signatureOf("bash", command(stored)),
          stated: []
        }),
        stored
      ).toBeUndefined()
    }
  })

  it("says nothing when the same flow name carries a different input", () => {
    expect(VacuousVerification.find({
      ledger: pristine("check a/b.py"),
      signature: signatureOf("test", command("check a/b.py")),
      stated: []
    })).toBeUndefined()
  })

  it("says nothing a second time about the same verification", () => {
    const signature = signatureOf("bash", command("check a/b.py"))

    expect(VacuousVerification.find({ ledger: pristine("check a/b.py"), signature, stated: [signature] }))
      .toBeUndefined()
    expect(VacuousVerification.find({ ledger: pristine("check a/b.py"), signature, stated: ["something else"] }))
      .toBeDefined()
  })

  it("says nothing when the run watched no pristine pass at all", () => {
    expect(VacuousVerification.find({
      ledger: [],
      signature: signatureOf("bash", command("check a/b.py")),
      stated: []
    })).toBeUndefined()
  })
})

describe("VacuousVerification.observation", () => {
  it("quotes the check, names what it cannot show, and asks for nothing", () => {
    const found = VacuousVerification.find({
      ledger: pristine("check a/b.py"),
      signature: signatureOf("bash", command("check a/b.py")),
      stated: []
    })
    const text = VacuousVerification.observation(found!)

    expect(text).toContain("check a/b.py")
    expect(text).toContain("already watched PASS on the unmodified tree")
    expect(text).toContain("cannot show your change did anything")
    expect(text).toContain("a check you have watched FAIL")
    // A fact, not a gate. It says so in the same breath as it names the way out
    // for a task whose only observable really was green before the fix.
    expect(text).toContain("Nothing is being asked of you and nothing has been refused")
    expect(text).toContain("keep it and say in your output that it never failed")
    expect(text).toContain("once per distinct verification")
  })
})

describe("VacuousVerification.Ledger", () => {
  it("decodes an absent ledger as an empty one", () => {
    const Holder = Schema.Struct({ pristineChecks: VacuousVerification.Ledger })

    expect(Effect.runSync(Schema.decodeUnknownEffect(Holder)({}))).toEqual({ pristineChecks: [] })
  })
})

/**
 * The signal, replayed over the whole r92 full-benchmark wave.
 *
 * The driver is the controller's own ordering: a frame's checks are its
 * successful non-writing calls, the epoch is the run's count of frames that
 * changed the workspace before this one, the pristine ledger stops growing at
 * the first of those, and the reading is taken on every transition that settled
 * with durable state — a `continue` or a `complete`, which is where the
 * controller takes it too.
 *
 * It speaks to three of the forty-five, once each, and those three are the
 * whole argument for stating a fact rather than refusing a frame.
 *
 * `django__django-14351` is the run it was written for, and the only one of the
 * three that lost its verdict. Its journal is unambiguous: one verification
 * script settled at frame 5 with nothing yet changed and exited 0, the same
 * script settled again at frame 14 after the edit and exited 0, and the frame
 * that completed stored it as `state.verification`. The report that lost that
 * verdict twice calls it an empty proof; this is the reading that says so from
 * the record.
 *
 * `django__django-11299` **resolved**, and it resolved by fixing this itself.
 * At frame 3 it stored a script it had watched exit 0 on the untouched tree,
 * then went on working, found a command that failed before its edit and passed
 * after it, stored that instead, and completed on it at frame 10. A harness
 * that had refused frame 3 would have bounced a run that was already correcting
 * itself; one sentence on frame 4 costs it nothing.
 *
 * `django__django-12741` **resolved**, and it was right to complete on a check
 * that had always been green: the task is a signature change with no bug to
 * reproduce, so no command in that tree can fail before the edit and pass
 * after. The fact is still true and the notice still says it — and the escape
 * it names, *keep it and say in your output that it never failed and why*, is
 * this run's case exactly. It is the reason this is not a gate.
 */
describe("VacuousVerification over the r92 wave", () => {
  /**
   * What a distilled frame stored under `state.verification`.
   *
   * The frame object *is* the transition's durable state as far as this key is
   * concerned, so the production reader runs over it directly rather than over
   * a re-derivation of it.
   */
  const storedBy = (
    frame: Journal["frames"][number]
  ): { readonly flow: string; readonly input: Schema.Json } | undefined =>
    VacuousVerification.stored(frame as unknown as Schema.Json)

  const replay = (journal: Journal): ReadonlyArray<{ readonly frame: number; readonly check: string }> => {
    let ledger: VacuousVerification.Ledger = []
    // The failing half of the same fold, kept exactly as `CellTurn` keeps it,
    // because the refusal this module makes is read off it and a replay that
    // derived it some other way would be measuring a different controller.
    let failing: Sufficiency.Ledger = []
    let mutations = 0
    let stated: Array<string> = []
    const fired: Array<{ readonly frame: number; readonly check: string }> = []
    let index = 0
    for (const frame of journal.frames) {
      index = index + 1
      const digest = frame.basis === "observed" ? frame.digest : ""
      const checks = frame.calls.flatMap((call) => {
        if (!call.ok || call.mutates) return []
        const result = ("exit" in call ? { exitCode: call.exit } : {}) as Schema.Json
        const probe = "probe" in call
        const recorded = NarrowedCheck.check({
          flow: call.flow,
          signature: signatureOf(call.flow, call.input as Schema.Json),
          input: call.input as Schema.Json,
          digest,
          failing: !probe && UnresolvedFailure.failed(result),
          passing: !probe && UnresolvedFailure.passed(result),
          stable: !frame.mutated
        })
        return recorded === undefined ? [] : [recorded]
      })
      failing = Sufficiency.remember(failing, { frame: checks, epoch: mutations })
      const remembered = VacuousVerification.remember(ledger, {
        frame: checks,
        epoch: mutations,
        failed: failing.filter((entry) => entry.epoch === 0).map((entry) => entry.signature)
      })
      const declared = storedBy(frame)
      if (declared !== undefined && (frame.transition === "continue" || frame.transition === "complete")) {
        const found = VacuousVerification.find({
          ledger: remembered,
          signature: signatureOf(declared.flow, declared.input),
          stated
        })
        if (found !== undefined) {
          stated = [...stated, found.signature]
          fired.push({ frame: index, check: found.label })
        }
      }
      ledger = remembered
      mutations = mutations + (frame.mutated ? 1 : 0)
    }
    return fired
  }

  it("carries every instance of the wave", () => {
    expect(wave.journals).toHaveLength(45)
  })

  const journalOf = (instance: string): Journal => {
    const journal = wave.journals.find((entry) => entry.instance === instance)
    if (journal === undefined) throw new Error(`the r92 fixture is missing ${instance}`)
    return journal as Journal
  }

  it("says so once to django__django-14351, on the frame that completed", () => {
    const journal = journalOf("django__django-14351")

    const fired = replay(journal)
    expect(fired.map((found) => found.frame)).toEqual([14])
    expect(journal.frames[13]?.transition).toBe("complete")
    // The stored proof is a script rather than a command line, and what makes
    // the pair empty is that this exact input had already exited 0 with the
    // tree untouched.
    expect(fired[0]?.check).toContain("settings.configure(")
    expect(fired[0]?.check).toContain("django--django-14351")
  })

  it("says so once to django__django-11299, four frames before it resolved on a real proof", () => {
    const journal = journalOf("django__django-11299")

    const fired = replay(journal)
    expect(fired.map((found) => found.frame)).toEqual([3])
    // The frame that heard it continued, and the run kept working: the
    // completion at frame 10 stores a different command, one it watched fail
    // and then pass around its own edit. Refusing frame 3 would have bounced a
    // run that was already correcting itself.
    expect(journal.frames[2]?.transition).toBe("continue")
    expect(journal.frames[9]?.transition).toBe("complete")
    expect(storedBy(journal.frames[9]!)).not.toEqual(storedBy(journal.frames[2]!))
  })

  it("says so once to django__django-12741, whose green check was the only one there was", () => {
    const journal = journalOf("django__django-12741")

    const fired = replay(journal)
    expect(fired.map((found) => found.frame)).toEqual([3])
    // Frame 2 stored the same command with a `timeoutMs` the frame 1 call did
    // not carry, so by the controller's own signature it is a different call
    // and nothing is said about it. Exact means exact, in both directions: the
    // rule the contract states is to reuse the baseline byte for byte, and a
    // harness that matched approximately here would be inventing the reuse.
    expect(journal.frames[1]?.transition).toBe("complete")
    expect(JSON.stringify(storedBy(journal.frames[1]!))).toContain("timeoutMs")
    expect(JSON.stringify(storedBy(journal.frames[2]!))).not.toContain("timeoutMs")
  })

  it("says nothing to the other forty-two runs of the wave", () => {
    const spoken = ["django__django-14351", "django__django-11299", "django__django-12741"]
    for (const journal of wave.journals) {
      if (spoken.includes(journal.instance)) continue
      expect(replay(journal as Journal), journal.instance).toEqual([])
    }
  })

  it("says nothing twice to a run that stores the same verification again", () => {
    // The bound that keeps one fact from becoming a standing complaint. 11299
    // carried its vacuous verification forward on three consecutive frames;
    // 14351 stored four verifications and is told about the one that was
    // vacuous; 12741 stored two.
    for (const instance of ["django__django-11299", "django__django-14351", "django__django-12741"]) {
      const journal = journalOf(instance)
      const stored = journal.frames.filter((frame) => storedBy(frame) !== undefined)

      expect(stored.length, instance).toBeGreaterThan(1)
      expect(replay(journal), instance).toHaveLength(1)
    }
  })
})
