/**
 * The descendant walk both stores share: attached children are followed
 * transitively, detached ones are reported but not crossed, and a child named
 * by two edges is one descendant.
 */
import { describe, expect, it } from "@effect/vitest"
import type { LineageEdge } from "../src/Frame.ts"
import * as LineageTree from "../src/internal/LineageTree.ts"

const edge = (
  parentRunId: string,
  parentSeq: number,
  childRunId: string,
  attached: boolean
): LineageEdge => ({ parentRunId, parentSeq, childRunId, kind: attached ? "child" : "fork", attached })

describe("LineageTree.descendants", () => {
  it("keeps only root edges above the frame and walks attached children transitively", () => {
    const edges = [
      edge("root", 1, "before", true),
      edge("root", 3, "a", true),
      edge("a", 0, "a1", true),
      edge("a1", 0, "a2", false),
      edge("root", 4, "d", false),
      edge("d", 0, "under-detached", true)
    ]
    const result = LineageTree.descendants(edges, "root", { lineageId: "l", seq: 2 })
    expect(result.attached.map((e) => e.childRunId)).toEqual(["a", "a1"])
    expect(result.detached.map((e) => e.childRunId)).toEqual(["d", "a2"])
    expect([...result.attachedRunIds]).toEqual(["a", "a1"])
  })

  it("reports a child named by two edges once", () => {
    const edges = [
      edge("root", 3, "c", true),
      edge("root", 5, "c", true),
      edge("root", 3, "f", false),
      edge("root", 4, "f", false)
    ]
    const result = LineageTree.descendants(edges, "root", { lineageId: "l", seq: 0 })
    expect(result.attached.map((e) => e.childRunId)).toEqual(["c"])
    expect(result.detached.map((e) => e.childRunId)).toEqual(["f"])
  })
})
