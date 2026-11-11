/**
 * The two pure journal projections, driven directly.
 *
 * `Steering.derive` and `Lineage.derive` read journal rows written by other
 * packages, so every one of their guards exists for a row this package does not
 * control: a payload that is an array, a `boundary` that is not a string, an
 * `ids` list holding numbers. The end-to-end suites reach the happy shapes; a
 * hostile or merely older row only reaches the guards from here.
 */
import { describe, expect, it } from "vitest"
import type { ControlEvent } from "../src/ControlSchema.vibe"
import * as Lineage from "../src/Lineage.vibe"
import * as Steering from "../src/Steering.ts"

const event = (overrides: Partial<ControlEvent> = {}): ControlEvent => ({
  sequence: 7,
  kind: Steering.promotedEventType,
  runId: "run-1",
  occurredAt: 1_700,
  payload: null,
  ...overrides
})

describe("Steering.derive", () => {
  it("derives one delivery per promoted message id", () => {
    const derived = Steering.derive(event({ payload: { boundary: "turn-3", ids: ["steer-1", "steer-2"] } }))
    expect(derived).toEqual([
      {
        sequence: 7,
        kind: Steering.deliveredEventType,
        runId: "run-1",
        occurredAt: 1_700,
        payload: { runId: "run-1", messageId: "steer-1", boundary: "turn-3" }
      },
      {
        sequence: 7,
        kind: Steering.deliveredEventType,
        runId: "run-1",
        occurredAt: 1_700,
        payload: { runId: "run-1", messageId: "steer-2", boundary: "turn-3" }
      }
    ])
  })

  it("derives nothing from a row it does not recognize", () => {
    const payload = { boundary: "turn-3", ids: ["steer-1"] }
    expect(Steering.derive(event({ kind: "control.run.started", payload }))).toEqual([])
    expect(Steering.derive(event({ runId: undefined, payload }))).toEqual([])
  })

  it("derives nothing from a payload that is not a record", () => {
    for (const payload of [null, "promoted", 7, true, ["steer-1"]] as ReadonlyArray<ControlEvent["payload"]>) {
      expect(Steering.derive(event({ payload }))).toEqual([])
    }
  })

  it("derives nothing without a string boundary", () => {
    expect(Steering.derive(event({ payload: { ids: ["steer-1"] } }))).toEqual([])
    expect(Steering.derive(event({ payload: { boundary: 3, ids: ["steer-1"] } }))).toEqual([])
  })

  it("keeps only the string ids a promotion named", () => {
    const derived = Steering.derive(event({ payload: { boundary: "turn-1", ids: ["a", 2, null, "b"] } }))
    expect(derived.map((delivery) => (delivery.payload as { readonly messageId: string }).messageId)).toEqual([
      "a",
      "b"
    ])
  })

  it("derives nothing when ids is absent or not an array", () => {
    expect(Steering.derive(event({ payload: { boundary: "turn-1" } }))).toEqual([])
    expect(Steering.derive(event({ payload: { boundary: "turn-1", ids: "steer-1" } }))).toEqual([])
    expect(Steering.derive(event({ payload: { boundary: "turn-1", ids: [] } }))).toEqual([])
  })

  it("expands an entry into itself and its deliveries", () => {
    const promoted = event({ payload: { boundary: "turn-1", ids: ["steer-1"] } })
    expect(Steering.expand(promoted)).toHaveLength(2)
    expect(Steering.expand(promoted)[0]).toBe(promoted)
    const unrelated = event({ kind: "control.run.started" })
    expect(Steering.expand(unrelated)).toEqual([unrelated])
  })
})

const decision = (payload: ControlEvent["payload"]): ControlEvent =>
  event({ kind: Lineage.runDecisionEventType, payload })

describe("Lineage.derive", () => {
  it("derives a child edge from a spawn at round zero", () => {
    const derived = Lineage.derive(decision({ decision: "created", parentExecutionId: "parent-1" }))
    expect(derived).toMatchObject({
      kind: Lineage.lineageEventType,
      runId: "run-1",
      payload: { runId: "run-1", parentRunId: "parent-1", origin: "child" }
    })
  })

  it("leaves a continuation round's own created decision to the handoff that names it", () => {
    expect(Lineage.derive(decision({ decision: "created", parentExecutionId: "prev", roundOrdinal: 1 })))
      .toBeUndefined()
  })

  it("derives a continuation edge from a handoff", () => {
    const derived = Lineage.derive(decision({
      decision: "handed-off",
      nextExecutionId: "run-2",
      lineageId: "lineage-1",
      roundOrdinal: 2
    }))
    expect(derived?.payload).toEqual({
      runId: "run-2",
      parentRunId: "run-1",
      lineageId: "lineage-1",
      roundOrdinal: 2,
      origin: "continuation"
    })
  })

  it("derives a fork edge from a fork-created entry", () => {
    const derived = Lineage.derive(
      event({ kind: Lineage.forkCreatedEventType, payload: { parentRunId: "parent-1" } })
    )
    expect(derived?.payload).toMatchObject({ runId: "run-1", parentRunId: "parent-1", origin: "fork" })
  })

  it("derives nothing from a row missing the pair it needs", () => {
    expect(Lineage.derive(event({ runId: undefined, kind: Lineage.forkCreatedEventType }))).toBeUndefined()
    expect(Lineage.derive(decision(null))).toBeUndefined()
    expect(Lineage.derive(decision(["created"]))).toBeUndefined()
    expect(Lineage.derive(decision({ decision: "abandoned" }))).toBeUndefined()
    expect(Lineage.derive(decision({ decision: "created" }))).toBeUndefined()
    expect(Lineage.derive(decision({ decision: "created", parentExecutionId: "" }))).toBeUndefined()
    expect(Lineage.derive(decision({ decision: "handed-off" }))).toBeUndefined()
    expect(Lineage.derive(event({ kind: "control.run.started", payload: { parentRunId: "p" } }))).toBeUndefined()
  })

  it("ignores a round ordinal it cannot trust", () => {
    // A non-integer, negative, or non-numeric ordinal reads as "no round", so a
    // corrupt engine row degrades to an ordinary child rather than vanishing.
    for (const roundOrdinal of [1.5, -1, "2", null]) {
      expect(Lineage.derive(decision({ decision: "created", parentExecutionId: "parent-1", roundOrdinal })))
        .toMatchObject({ payload: { origin: "child" } })
    }
  })

  it("expands an entry into itself and its edge", () => {
    const spawn = decision({ decision: "created", parentExecutionId: "parent-1" })
    expect(Lineage.expand(spawn)).toHaveLength(2)
    expect(Lineage.expand(spawn)[0]).toBe(spawn)
    const unrelated = event({ kind: "control.run.started" })
    expect(Lineage.expand(unrelated)).toEqual([unrelated])
  })
})

describe("Lineage.originOf", () => {
  it("reports a fork ahead of a continuation and a continuation ahead of a child", () => {
    expect(Lineage.originOf({ parentRunId: "p", forked: true, roundOrdinal: 3 })).toBe("fork")
    expect(Lineage.originOf({ parentRunId: "p", roundOrdinal: 3 })).toBe("continuation")
    expect(Lineage.originOf({ parentRunId: "p", roundOrdinal: 0 })).toBe("child")
    expect(Lineage.originOf({ parentRunId: "p" })).toBe("child")
    expect(Lineage.originOf({})).toBeUndefined()
  })
})
