/**
 * The narrowing ledger, as a relation and as a replay of the wave it was read
 * off.
 *
 * The unit cases fix the relation: what counts as a check, what counts as
 * narrowing one, and which of several candidates a demand names. The replay at
 * the end is the case that decides whether the relation is worth having — it
 * runs the detector over five real journals, four of which resolved their
 * instance and must be left alone, and one which did not and must be stopped
 * exactly once.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import journals from "./fixtures/narrowingJournals.json" with { type: "json" }

const command = (text: string): Schema.Json => ({ mode: "unhermetic", command: text })

const ran = (flow: string, input: Schema.Json, digest: string): NarrowedCheck.Check => {
  const recorded = NarrowedCheck.check({
    flow,
    signature: `${flow}:${JSON.stringify(input)}`,
    input,
    digest
  })
  if (recorded === undefined) throw new Error("the fixture input is not a check")
  return recorded
}

describe("NarrowedCheck.terms", () => {
  it("lexes a whole canonical input, keys included, and de-duplicates", () => {
    expect(NarrowedCheck.terms(command("check src/a.py src/a.py"))).toEqual([
      "check",
      "command",
      "mode",
      "src/a.py",
      "unhermetic"
    ])
  })

  it("keeps a path and a flag whole, and cuts a selector off the target it names", () => {
    // The lexer is the module's only assumption about text, and everything the
    // relation decides rests on it: a path that came apart at its slash would
    // read as several conditions rather than one target, and a test id kept
    // whole would hide that selecting one case out of a file is a narrowing.
    expect(NarrowedCheck.terms(command("check -rA a/b.py::test_x -k \"one or two\""))).toEqual(
      expect.arrayContaining(["a/b.py", "test_x", "-rA", "-k", "one", "or", "two"])
    )
    expect(NarrowedCheck.narrows(
      NarrowedCheck.terms(command("check a/b.py::test_x")),
      NarrowedCheck.terms(command("check a/b.py"))
    )).toBe(true)
  })
})

describe("NarrowedCheck.check", () => {
  it("records a check with its terms, its tree, and a readable label", () => {
    const recorded = ran("bash", command("check suite"), "tree-1")

    expect(recorded.flow).toBe("bash")
    expect(recorded.digest).toBe("tree-1")
    expect(recorded.terms).toContain("suite")
    expect(recorded.label).toBe("{\"command\":\"check suite\",\"mode\":\"unhermetic\"}")
  })

  it("elides a label that would not fit and says where to recover it", () => {
    const recorded = ran("bash", command(`check ${"a".repeat(400)}`), "tree-1")

    expect(recorded.label).toContain("… [+")
    expect(recorded.label).toContain("the issuing cell in the run record has the whole input")
  })

  it("measures a multibyte label in UTF-8 bytes without splitting a character", () => {
    const emoji = "😀".repeat(100)
    const whole = `{"command":"check ${emoji}","mode":"unhermetic"}`
    const recorded = ran("bash", command(`check ${emoji}`), "tree-1")
    const kept = recorded.label.slice(0, recorded.label.indexOf("… [+"))
    const missing = new TextEncoder().encode(whole).byteLength - new TextEncoder().encode(kept).byteLength

    expect(whole.length).toBeLessThan(320)
    expect(new TextEncoder().encode(whole).byteLength).toBeGreaterThan(320)
    expect(recorded.label).toContain(`… [+${missing}b,`)
    expect(new TextDecoder().decode(new TextEncoder().encode(recorded.label))).toBe(recorded.label)
  })

  it("refuses an input that is content rather than a question", () => {
    // A patch, a generated file, a document: nothing re-runs one of these with
    // an added filter, and storing its terms would store the payload twice.
    const payload = Array.from({ length: NarrowedCheck.maxTerms + 1 }, (_, index) => `term${index}`).join(" ")

    expect(NarrowedCheck.check({ flow: "write", signature: "s", input: command(payload), digest: "t" }))
      .toBeUndefined()
  })

  it("records an input carrying exactly the term bound, which is a question and not content", () => {
    // `command`, `mode` and `unhermetic` are terms of the document itself, so
    // three fewer words land the input on the bound rather than past it.
    const payload = Array.from({ length: NarrowedCheck.maxTerms - 3 }, (_, index) => `term${index}`).join(" ")
    const input = command(payload)

    expect(NarrowedCheck.terms(input)).toHaveLength(NarrowedCheck.maxTerms)
    expect(NarrowedCheck.check({ flow: "write", signature: "s", input, digest: "t" })?.terms)
      .toHaveLength(NarrowedCheck.maxTerms)
  })
})

describe("NarrowedCheck.narrows", () => {
  const of = (text: string) => NarrowedCheck.terms(command(text))

  it("holds when the later call repeats every term and adds a condition", () => {
    expect(NarrowedCheck.narrows(of("check suite -k one"), of("check suite"))).toBe(true)
  })

  it("fails when the later call dropped a term the earlier one carried", () => {
    expect(NarrowedCheck.narrows(of("check -k one"), of("check suite"))).toBe(false)
  })

  it("fails on an identical call, which is a repetition and not a narrowing", () => {
    expect(NarrowedCheck.narrows(of("check suite"), of("check suite"))).toBe(false)
  })

  it("fails when the added term names a target, because that is a broader question", () => {
    // Running two files where one ran before covers more, not less. Reading it
    // as a narrowing would demand a check the run has already superseded.
    expect(NarrowedCheck.narrows(of("check a.py b.py"), of("check a.py"))).toBe(false)
    expect(NarrowedCheck.narrows(of("check a.py sub/b"), of("check a.py"))).toBe(false)
  })
})

describe("NarrowedCheck.find", () => {
  const broad = ran("bash", command("check suite"), "tree-1")
  const narrow = ran("bash", command("check suite -k one"), "tree-2")

  it("names the earlier check when the tree moved under it", () => {
    const found = NarrowedCheck.find({ ledger: [broad], frame: [narrow], digest: "tree-2" })

    expect(found?.earlier.label).toBe(broad.label)
    expect(found?.later.label).toBe(narrow.label)
  })

  it("says nothing when the frame had no complete measurement", () => {
    expect(NarrowedCheck.find({ ledger: [broad], frame: [narrow], digest: "" })).toBeUndefined()
  })

  it("says nothing when the earlier check ran over the tree the frame closed on", () => {
    expect(NarrowedCheck.find({ ledger: [broad], frame: [narrow], digest: "tree-1" })).toBeUndefined()
  })

  it("says nothing when the earlier check itself was recorded unmeasured", () => {
    const unmeasured = ran("bash", command("check suite"), "")

    expect(NarrowedCheck.find({ ledger: [unmeasured], frame: [narrow], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when this frame re-ran the earlier check", () => {
    const rerun = ran("bash", command("check suite"), "tree-2")

    expect(NarrowedCheck.find({ ledger: [broad], frame: [rerun, narrow], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the narrowing call named a different flow", () => {
    const elsewhere = ran("search", command("check suite -k one"), "tree-2")

    expect(NarrowedCheck.find({ ledger: [broad], frame: [elsewhere], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when this frame's calls narrow nothing the run already ran", () => {
    const unrelated = ran("bash", command("read the log"), "tree-2")

    expect(NarrowedCheck.find({ ledger: [broad], frame: [unrelated], digest: "tree-2" })).toBeUndefined()
  })

  it("names the broadest stale check rather than the first one it finds", () => {
    // Several checks can be narrowed by one call. The one worth naming is the
    // least constrained, because it is the one covering the most ground the
    // completion has not re-measured.
    const middle = ran("bash", command("check suite -k one or two"), "tree-1")
    const later = ran("bash", command("check suite -k one"), "tree-2")

    expect(NarrowedCheck.find({ ledger: [middle, broad], frame: [later], digest: "tree-2" })?.earlier.label)
      .toBe(broad.label)
    expect(NarrowedCheck.find({ ledger: [broad, middle], frame: [later], digest: "tree-2" })?.earlier.label)
      .toBe(broad.label)
  })
})

describe("NarrowedCheck.demand", () => {
  it("names both checks, asks for one of two answers, and claims nothing further", () => {
    const text = NarrowedCheck.demand({
      earlier: ran("bash", command("check suite"), "tree-1"),
      later: ran("bash", command("check suite -k one"), "tree-2")
    })

    expect(text).toContain("check suite")
    expect(text).toContain("-k")
    // Re-run it, or say why it no longer applies: two ways out, stated as
    // equals, in the shape the read-only demand already uses.
    expect(text).toContain("byte for byte")
    expect(text).toContain("why that check no longer applies")
    // The harness does not re-run anything, and says so.
    expect(text).toContain("Nothing re-runs it for you")
  })
})

describe("NarrowedCheck.names", () => {
  it("accepts a term a reader can recognize and rejects what a glob leaves behind", () => {
    // The stricter reading of `targeting`. Both callers ask which term a call
    // is *about*, and for that question a term nobody can read is worse than
    // no term: `**/*.py` lexes to `/` and `.py`, and neither names anything.
    expect(NarrowedCheck.names("tests/test_a.py")).toBe(true)
    expect(NarrowedCheck.names("django.contrib.admin.sites")).toBe(true)
    expect(NarrowedCheck.names(".py")).toBe(false)
    expect(NarrowedCheck.names("/")).toBe(false)
    expect(NarrowedCheck.names("/testbed")).toBe(false)
    expect(NarrowedCheck.names("-rA")).toBe(false)
  })
})

describe("NarrowedCheck.conditions", () => {
  it("keeps the value-terms and drops targets, the input's own keys, and magnitudes", () => {
    // The three exclusions are about how a call is written: `command` and
    // `timeoutMs` are the input's shape, `120000` is a quantity, and the
    // paths are what the call is about. `-q` is the one term left that could
    // be a condition somebody added.
    expect(NarrowedCheck.conditions({
      command: "/bin/python -q a/b.py",
      mode: "unhermetic",
      timeoutMs: 120000
    })).toEqual(["-q", "unhermetic"])
  })

  it("reads keys at any depth, and an input that is no object has none", () => {
    expect(NarrowedCheck.conditions({ nested: [{ flag: "flag" }] })).toEqual([])
    expect(NarrowedCheck.conditions("run the suite")).toEqual(["run", "suite", "the"])
  })
})

describe("NarrowedCheck.findOnly", () => {
  const target = "testing/test_collection.py"
  // The shape the wave lost on: one filtered reading of one file, and a
  // container path that every other command in the run also names.
  const filtered = ran("bash", command(`/bin/python -m check ${target} -k "one or two"`), "tree-2")
  const searched = ran("grep", { pattern: "one", globs: [target] }, "tree-1")
  const compiled = ran("bash", command("/bin/python -m compile src/a.py"), "tree-2")

  const found = (
    frame: ReadonlyArray<NarrowedCheck.Check>,
    ledger: ReadonlyArray<NarrowedCheck.Check>,
    taught: ReadonlyArray<string> = []
  ) => NarrowedCheck.findOnly({ ledger, before: [], frame, taught })

  it("names the frame's last check when the run holds no other reading of its subjects", () => {
    const only = found([compiled, filtered], [searched, compiled, filtered])

    expect(only?.later.label).toBe(filtered.label)
    expect(only?.targets).toEqual(["/bin/python", target])
  })

  it("says nothing when the frame ran no check at all", () => {
    expect(found([], [searched])).toBeUndefined()
  })

  it("says nothing when the last check names no subject", () => {
    const anonymous = ran("bash", command("check everything"), "tree-2")

    expect(found([anonymous], [searched, anonymous])).toBeUndefined()
  })

  it("says nothing when the check is nothing but its subjects", () => {
    // Nothing to remove is nothing to demand: a call whose every term is a
    // target carries no condition that could be hiding anything.
    const bare = ran("bash", [target], "tree-2")
    const elsewhere = ran("grep", { globs: [target], pattern: "x" }, "tree-1")

    expect(found([bare], [elsewhere, bare])).toBeUndefined()
  })

  it("says nothing when the run had already issued this exact call", () => {
    // A replayed call is the run's own baseline re-run byte for byte, which is
    // the discipline the contract asks for rather than the failure this names.
    expect(
      NarrowedCheck.findOnly({
        ledger: [searched, compiled, filtered],
        before: [filtered.signature],
        frame: [filtered],
        taught: []
      })
    ).toBeUndefined()
  })

  it("says nothing when another check covers every subject it names", () => {
    const covering = ran("bash", command(`/bin/python -m check ${target}`), "tree-1")

    expect(found([filtered], [covering, filtered])).toBeUndefined()
  })

  it("says nothing when a subject appears nowhere else in the run", () => {
    // A scratch path a single command creates and uses is not a subject the
    // run is working on, and demanding an unconditioned reading of one would
    // be the harness asking about its own scaffolding.
    expect(found([filtered], [filtered])).toBeUndefined()
  })

  it("says nothing about a check that names one subject, whatever the run did with it", () => {
    // The floor the two conditions leave, stated as a case because it is the
    // shape a reader will ask about. One subject read elsewhere is one subject
    // covered; one subject read nowhere else has nothing to corroborate it. A
    // single filtered file therefore goes unremarked, and the alternative —
    // demanding it — fired on the two best rounds this harness has scored.
    const single = ran("bash", command("check a/b.py -k one"), "tree-2")
    const read = ran("read", { path: "a/b.py" }, "tree-1")

    expect(found([single], [read, single])).toBeUndefined()
    expect(found([single], [single])).toBeUndefined()
  })

  it("does name an unconditioned check whose phrasing is the run's own, and that is the price", () => {
    // The other side of the floor, stated so a reader is not surprised by it.
    // The harness cannot read a flag, so it cannot tell this unfiltered run of
    // one file from the filtered run of one file above; what it can see is
    // that the run has never read the interpreter and the file together, and
    // that `-m` and `check` are phrasing this run was neither taught nor used
    // anywhere else. The demand costs such a run one frame, it is capped at
    // one, and the second answer — "it carries no condition and the reading is
    // already whole" — is accepted exactly as written. Every weaker condition
    // tried against three graded waves fired on one or both of the two best
    // rounds this harness scored.
    const probe = ran("bash", command("/bin/python -c import a"), "tree-1")
    const read = ran("read", { path: "a/b.py" }, "tree-1")
    const whole = ran("bash", command("/bin/python -m check a/b.py"), "tree-2")

    expect(found([whole], [probe, read, whole])?.targets).toEqual(["/bin/python", "a/b.py"])
  })

  it("says nothing when every condition the check carries was taught to the run", () => {
    // The r97 false positives, in miniature: the task text says "runs its
    // tests with `check -rA`", the run does exactly that over a module it has
    // read, and `-m` is how its own other commands reach the interpreter. A
    // run doing as it was told has added nothing a demand could ask to see
    // removed — and each of the three runs this fired on answered by
    // re-issuing the identical completion, so the demand bought one wasted
    // full-context frame and no information.
    const read = ran("read", { path: target }, "tree-1")
    const whole = ran("bash", command(`/bin/python -m check -rA ${target}`), "tree-2")
    const taught = NarrowedCheck.terms("This repository runs its tests with `check -rA`.")

    expect(found([compiled, whole], [read, compiled, whole], taught)).toBeUndefined()
    // The same completion with a filter phrase of the run's own still fires:
    // `-k` and its argument are in neither the taught text nor any other
    // check, which is exactly what separates the two shapes in the record.
    expect(found([compiled, filtered], [read, compiled, filtered], taught)?.targets)
      .toEqual(["/bin/python", target])
  })

  it("says nothing when the check is its subjects plus its own shape", () => {
    // Keys and magnitudes are how the call is written, not conditions on what
    // it covers: an input carrying only paths, its own key names, and a
    // timeout has nothing a demand could ask to see removed, however the run
    // came to hold its subjects.
    const read = ran("read", { path: target }, "tree-1")
    const versioned = ran("bash", { command: "/bin/python --version" }, "tree-1")
    const shaped = ran("bash", { command: `/bin/python ${target}`, timeoutMs: 120000 }, "tree-2")

    expect(found([shaped], [read, versioned, shaped])).toBeUndefined()
  })
})

describe("NarrowedCheck.demandOnly", () => {
  it("quotes the check, names its subjects, and claims nothing about a filter", () => {
    const text = NarrowedCheck.demandOnly({
      later: ran("bash", command("check a/b.py -k one"), "tree-2"),
      targets: ["a/b.py"]
    })

    expect(text).toContain("check a/b.py -k one")
    expect(text).toContain("a/b.py")
    // It cannot read a flag, so it says what a condition is and lets the run
    // answer whether it has one — including by saying it has none.
    expect(text).toContain("a filter, a selector, a subset of cases")
    expect(text).toContain("it carries no condition")
    expect(text).toContain("Nothing re-runs it for you")
  })
})

describe("NarrowedCheck.remember", () => {
  it("moves a repeated check to the newest position and restamps its tree", () => {
    const first = ran("bash", command("check suite"), "tree-1")
    const other = ran("bash", command("read the log"), "tree-1")
    const again = ran("bash", command("check suite"), "tree-2")

    const ledger = NarrowedCheck.remember(NarrowedCheck.remember([], [first, other]), [again])

    expect(ledger.map((entry) => entry.digest)).toEqual(["tree-1", "tree-2"])
    expect(ledger[1]?.label).toBe(first.label)
  })

  it("forgets its oldest checks first once the bound is reached", () => {
    const many = Array.from(
      { length: NarrowedCheck.retained + 2 },
      (_, index) => ran("bash", command(`check ${index}`), "tree-1")
    )

    const ledger = NarrowedCheck.remember([], many)

    expect(ledger).toHaveLength(NarrowedCheck.retained)
    expect(ledger[0]?.label).toBe(many[2]?.label)
  })
})

describe("NarrowedCheck.Ledger", () => {
  it("decodes an absent ledger as an empty one", () => {
    const Holder = Schema.Struct({ checks: NarrowedCheck.Ledger })

    expect(Effect.runSync(Schema.decodeUnknownEffect(Holder)({}))).toEqual({ checks: [] })
  })
})

/**
 * The detector, replayed over the wave it was designed against.
 *
 * The fixture is five real journals distilled to what the detector reads: every
 * settled call's flow, input and outcome, and the digest each frame closed on.
 * Four of those runs resolved their instance, and the demand must be silent on
 * all four — a completion whose broad check is current is a completion that
 * proved itself, and bouncing it would cost a correct run a frame and a model
 * call for nothing. The fifth resolved nothing: its graded patch passed both
 * target tests and 144 of 145 neighbours, and the neighbour it broke was inside
 * the 68 tests its final `-k` filter deselected.
 */
describe("NarrowedCheck over the recorded wave", () => {
  const replay = (frames: typeof journals.journals[number]["frames"]) => {
    let ledger: ReadonlyArray<NarrowedCheck.Check> = []
    let demands = 0
    const fired: Array<{ readonly seq: number; readonly narrowing: NarrowedCheck.Narrowing }> = []
    for (const frame of frames) {
      const digest = frame.basis === "observed" ? frame.digest : ""
      const checks = frame.calls.flatMap((call) =>
        !call.ok || call.mutates ? [] : [
          ran(call.flow, call.input as Schema.Json, digest)
        ]
      )
      if (frame.transition === "complete" && demands === 0) {
        const narrowing = NarrowedCheck.find({ ledger, frame: checks, digest })
        if (narrowing !== undefined) {
          demands += 1
          fired.push({ seq: frame.transitionSeq ?? 0, narrowing })
        }
      }
      ledger = NarrowedCheck.remember(ledger, checks)
    }
    return fired
  }

  it.each(journals.journals.filter((journal) => journal.instance !== "pytest-dev__pytest-6197"))(
    "demands nothing of $instance, which resolved",
    ({ frames }) => {
      expect(replay(frames)).toEqual([])
    }
  )

  it("demands the deselected surface exactly once of pytest-dev__pytest-6197", () => {
    const journal = journals.journals.find((entry) => entry.instance === "pytest-dev__pytest-6197")
    const fired = replay(journal!.frames)

    expect(fired).toHaveLength(1)
    // The completing frame: `transition-applied` at seq 664, one event after
    // the `mutation-observed` that recorded the run's last edit.
    expect(fired[0]?.seq).toBe(664)
    // The broader check is the full file, run at seq 491 over the tree as it
    // stood before the final two edits; the narrower one is the same command
    // with a `-k` filter, which reported "4 passed, 68 deselected".
    expect(fired[0]?.narrowing.earlier.label).toContain("pytest -rA testing/test_collection.py'")
    expect(fired[0]?.narrowing.later.label).toContain("-k ")
    expect(fired[0]?.narrowing.earlier.digest).not.toBe(fired[0]?.narrowing.later.digest)
  })
})
