/**
 * The unmoved-tree relation, which is one comparison and three refusals.
 *
 * There is very little to fix here on purpose: the whole judgement is that two
 * digests the controller already measured are equal. What the cases pin is the
 * three ways the comparison must decline to answer — no opening measurement, no
 * closing one, and a tree that moved — because each of those is a case where an
 * eager answer would bounce a run that did its work.
 */
import { describe, expect, it } from "vitest"
import * as UnmovedTree from "../src/UnmovedTree.ts"

describe("UnmovedTree.find", () => {
  it("names both digests when the completing tree is the tree the run opened on", () => {
    expect(UnmovedTree.find({ opened: "tree-1", digest: "tree-1" })).toEqual({
      opened: "tree-1",
      closed: "tree-1"
    })
  })

  it("says nothing when the tree moved", () => {
    expect(UnmovedTree.find({ opened: "tree-1", digest: "tree-2" })).toBeUndefined()
  })

  it("says nothing when the run never measured what it opened on", () => {
    // An unmeasured origin cannot say a tree held still. Empty is what the
    // controller records for a walk that was absent or stopped at a bound.
    expect(UnmovedTree.find({ opened: "", digest: "tree-1" })).toBeUndefined()
  })

  it("says nothing when the completing frame closed on no measurement", () => {
    expect(UnmovedTree.find({ opened: "tree-1", digest: "" })).toBeUndefined()
  })

  it("says nothing when the run wrote to a tree the two digests do not cover", () => {
    // A container edit leaves the host's opening and closing digests equal.
    // The digests agreeing is not the tree holding still; one recorded remote
    // write is the tree moving, and the demand must not fire on it.
    expect(UnmovedTree.find({ opened: "tree-1", digest: "tree-1", elsewhere: 1 })).toBeUndefined()
    expect(UnmovedTree.find({ opened: "tree-1", digest: "tree-1", elsewhere: 0 })).toEqual({
      opened: "tree-1",
      closed: "tree-1"
    })
  })

  it("says nothing when neither end was measured, rather than reading two blanks as equal", () => {
    // The one case the comparison would get exactly backwards if it only tested
    // equality: two absent measurements are equal strings and say nothing at
    // all about the tree.
    expect(UnmovedTree.find({ opened: "", digest: "" })).toBeUndefined()
  })
})

describe("UnmovedTree.demand", () => {
  it("quotes both digests, names two answers, and accepts the one that changes nothing", () => {
    const text = UnmovedTree.demand({ opened: "tree-1", closed: "tree-1" })

    expect(text).toContain("tree-1")
    // The two ways out, stated as equals: a task whose right answer is "nothing
    // needs changing" exists, and a demand that only accepted an edit would be
    // pushing a correct run into making one.
    expect(text).toContain("Make the change")
    expect(text).toContain("no change is needed")
    // The harness changes nothing for the run, and says so.
    expect(text).toContain("Nothing makes the change for you")
  })

  it("asks the second answer for its working without gating on it", () => {
    const text = UnmovedTree.demand({ opened: "tree-1", closed: "tree-1" })

    // The re-tuning the armed wave paid for: a completion bounced off a
    // fabricated edit answered "No change is needed" from a run that had made
    // one call in its life, and the old sentence had offered that exit with
    // nothing attached. The claim is still accepted exactly as written — the
    // harness cannot know whether it is true and does not try — but the run is
    // asked what it ran to reach it.
    expect(text).toContain("naming what you ran to conclude it")
    expect(text).toContain("Both answers are accepted exactly as you write them")
    expect(text).toContain("nothing re-checks either one")
  })
})
