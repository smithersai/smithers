/**
 * The unanswered-failure relation: what counts as a failure, what counts as
 * going back to it, and which pair a demand names.
 *
 * The cases that matter most are the refusals. This demand is one step from a
 * rule that would fire on every run that ever saw a red check and moved on —
 * which is a rule about whose failures matter, and the harness does not get to
 * decide that. So the relation is pinned in both directions: it holds when the
 * run returned to the subject that failed, and it declines when the run walked
 * away from it, when the failing reading was stamped by a frame that also
 * edited, when the flow said its own call was broken, and when the tree the
 * check ran over is not the tree being submitted.
 */
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as UnresolvedFailure from "../src/UnresolvedFailure.ts"

const command = (text: string): Schema.Json => ({ mode: "unhermetic", command: text })

/** A check the run declared as its own unless a case says otherwise (#3994). */
const ran = (
  text: string,
  digest: string,
  overrides: {
    readonly failing?: boolean
    readonly stable?: boolean
    readonly flow?: string
    readonly declared?: boolean
  } = {}
): NarrowedCheck.Check => {
  const input = command(text)
  const recorded = NarrowedCheck.check({
    flow: overrides.flow ?? "bash",
    signature: `${overrides.flow ?? "bash"}:${text}`,
    input,
    digest,
    failing: overrides.failing ?? false,
    stable: overrides.stable ?? true,
    declared: overrides.declared ?? true
  })
  if (recorded === undefined) throw new Error("the fixture input is not a check")
  return recorded
}

describe("UnresolvedFailure.failed", () => {
  it("reads a non-zero exit status off the reserved key", () => {
    expect(UnresolvedFailure.failed({ exitCode: 1 })).toBe(true)
    expect(UnresolvedFailure.failed({ exitCode: -1 })).toBe(true)
  })

  it("reads a zero exit status as no failure", () => {
    expect(UnresolvedFailure.failed({ exitCode: 0, stdout: "ok" })).toBe(false)
  })

  it("reads a result that declares no exit status as neither", () => {
    // A flow that does not report an exit status has said nothing about
    // success or failure, and reading its silence either way is an assumption.
    expect(UnresolvedFailure.failed({ matches: [] })).toBe(false)
    expect(UnresolvedFailure.failed({ exitCode: "1" })).toBe(false)
    expect(UnresolvedFailure.failed(null)).toBe(false)
    expect(UnresolvedFailure.failed(["exitCode", 1])).toBe(false)
    expect(UnresolvedFailure.failed("exitCode: 1")).toBe(false)
  })
})

describe("UnresolvedFailure.revisits", () => {
  it("holds when the later call names every target the earlier one named", () => {
    expect(UnresolvedFailure.revisits(ran("check a/b.py::one", "t"), ran("check a/b.py", "t"))).toBe(true)
  })

  it("holds when the later call adds targets of its own", () => {
    // The relation `NarrowedCheck.narrows` refuses this, because adding a
    // target is a broader question. Here the question is only whether the run
    // came back to the same ground, and a compound command that diffs two
    // source files before re-running the suite did.
    expect(
      UnresolvedFailure.revisits(ran("diff x/y.py && check a/b.py::one", "t"), ran("check a/b.py", "t"))
    ).toBe(true)
  })

  it("fails when the later call never names what the earlier one was about", () => {
    // The case that separates a run which answered its failing check from one
    // which walked away from it, and the reason this is not "some check
    // failed": walking away is a different failure and this demand does not
    // claim to catch it.
    expect(UnresolvedFailure.revisits(ran("check other/thing.py", "t"), ran("check a/b.py", "t"))).toBe(false)
  })

  it("fails on the same call, which is a re-run and not a substitution", () => {
    expect(UnresolvedFailure.revisits(ran("check a/b.py", "t"), ran("check a/b.py", "t"))).toBe(false)
  })

  it("fails across flows, because two flows do not answer each other", () => {
    expect(
      UnresolvedFailure.revisits(ran("check a/b.py", "t", { flow: "search" }), ran("check a/b.py", "t"))
    ).toBe(false)
  })

  it("fails when the earlier call named no target at all", () => {
    // A reading with no subject has nothing to come back to, and treating it
    // as revisited by any later call of the same flow makes the relation
    // vacuous.
    expect(UnresolvedFailure.revisits(ran("check all -k one", "t"), ran("check all", "t"))).toBe(false)
  })
})

describe("UnresolvedFailure.find", () => {
  const failed = ran("check a/b.py", "tree-2", { failing: true })
  const instead = ran("check a/b.py::one", "tree-2")

  it("names the failing check and the reading that displaced it", () => {
    const found = UnresolvedFailure.find({ ledger: [failed, instead], digest: "tree-2" })

    expect(found?.failed.label).toBe(failed.label)
    expect(found?.instead.label).toBe(instead.label)
  })

  it("says nothing when the reading that failed was not the run's declared check", () => {
    // A `grep` that matched nothing exits 1, and a later read of the same file
    // goes back to it. That is a search and a read, not a check stepped
    // around: only the check the run declared can hold its completion (#3994).
    const searched = ran("grep -n missing a/b.py", "tree-2", { failing: true, declared: false })
    const read = ran("sed -n 1,20p a/b.py", "tree-2", { declared: false })

    expect(UnresolvedFailure.find({ ledger: [searched, read], digest: "tree-2" })).toBeUndefined()
    expect(
      UnresolvedFailure.find({ ledger: [{ ...failed, declared: false } as typeof failed, instead], digest: "tree-2" })
    ).toBeUndefined()
  })

  it("says nothing when the frame had no complete measurement", () => {
    expect(UnresolvedFailure.find({ ledger: [failed, instead], digest: "" })).toBeUndefined()
  })

  it("says nothing when the failing check ran over a tree that has since moved", () => {
    // Its result is a statement about a tree that no longer exists, so it is
    // not evidence about the one being submitted — for or against.
    const stale = ran("check a/b.py", "tree-1", { failing: true })

    expect(UnresolvedFailure.find({ ledger: [stale, instead], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the run never went back to what failed", () => {
    const elsewhere = ran("check other/thing.py", "tree-2")

    expect(UnresolvedFailure.find({ ledger: [failed, elsewhere], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the reading that revisits it came first", () => {
    // Order is the whole claim: a narrow reading taken before the broad one
    // failed was not taken in its place.
    expect(UnresolvedFailure.find({ ledger: [instead, failed], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the check reported no failure", () => {
    const passed = ran("check a/b.py", "tree-2")

    expect(UnresolvedFailure.find({ ledger: [passed, instead], digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the failing check was stamped by a frame that also edited", () => {
    // Such a frame cannot say whether its check ran before or after its edit,
    // so the tree stamped on the check is a guess in one direction. Carrying a
    // failure on that stamp would attribute a pre-edit result to a post-edit
    // tree: the recorded wave holds a reproduction run in the same frame as
    // the edit that fixed it, still reporting the bug.
    const mixed = ran("check a/b.py", "tree-2", { failing: true, stable: false })

    expect(UnresolvedFailure.find({ ledger: [mixed, instead], digest: "tree-2" })).toBeUndefined()
  })

  it("names the most recent failing check when several qualify", () => {
    // The completion is standing closest to the last reading it took, so that
    // is the one worth naming.
    const older = ran("check a/b.py", "tree-2", { failing: true })
    const newer = ran("check c/d.py", "tree-2", { failing: true })
    const both = ran("check a/b.py::one c/d.py::two", "tree-2")

    expect(UnresolvedFailure.find({ ledger: [older, newer, both], digest: "tree-2" })?.failed.label)
      .toBe(newer.label)
  })
})

describe("UnresolvedFailure.demand", () => {
  it("names both readings, asks for one of two answers, and claims nothing further", () => {
    const text = UnresolvedFailure.demand({
      failed: ran("check a/b.py", "tree-2", { failing: true }),
      instead: ran("check a/b.py::one", "tree-2")
    })

    expect(text).toContain("check a/b.py")
    expect(text).toContain("::one")
    // Fix it, or say why the failures are expected: two ways out, stated as
    // equals, in the shape the other completion demands already use.
    expect(text).toContain("byte for byte")
    expect(text).toContain("why the failures it reported are expected")
    expect(text).toContain("Nothing re-runs it for you")
  })
})
