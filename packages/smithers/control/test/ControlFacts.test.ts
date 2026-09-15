import { describe, expect, it } from "vitest"
import * as Facts from "../src/ControlFacts.ts"
import type { ControlEvent, RunSummary } from "../src/ControlSchema.ts"

const run: RunSummary = { runId: "run-1", flowId: "test", status: "accepted", createdAt: 1, updatedAt: 1 }
const event = (kind: string, payload: unknown, sequence = 1, runId = run.runId): ControlEvent => ({
  kind,
  payload: payload as ControlEvent["payload"],
  sequence,
  runId,
  occurredAt: sequence
})
const target = (requestId: string, runId = run.runId) => ({
  _tag: "Node" as const,
  runId,
  requestId,
  digest: `digest:${requestId}`,
  envelope: { capabilities: [], budget: {}, retries: {}, workspace: {}, external: {} }
})
// The actual schema's envelope, shared by producers and consumers.
const envelope = { capabilities: [], flows: [], budget: {} }
const request = (id: string, versioned = true, runId = run.runId) =>
  event(
    "control.approval.requested",
    {
      ...(versioned ? { factVersion: 1 } : {}),
      runId,
      requestId: id,
      question: id,
      payload: { target: { ...target(id, runId), envelope }, scope: "run", idempotencyKey: id }
    },
    1,
    runId
  )
const decision = (id: string, status = "approved", runId = run.runId) =>
  event(
    `control.approval.${status}`,
    {
      factVersion: 1,
      tokenId: id,
      approvalTarget: { ...target(id, runId), envelope }
    },
    2,
    runId
  )

describe("control lifecycle producer coverage", () => {
  it("replays versioned snapshots with a creation baseline", () => {
    const completed = { ...run, status: "completed" as const, updatedAt: 9 }
    const facts = [
      event("control.run.accepted", Facts.runFact(run, "created")),
      event("control.run.completed", Facts.runFact(completed), 9)
    ]
    expect(Facts.fold(facts).run).toEqual(completed)
    expect(Facts.fold(facts, completed).provenance).toEqual({
      control: "events",
      execution: "control",
      baseline: "created",
      fromSequence: 1,
      throughSequence: 9
    })
  })
  it("does not invent a creation history for a migrated or unjournaled row", () => {
    const resumed = { ...run, status: "running" as const, updatedAt: 7 }
    const facts = [event("control.run.running", Facts.runFact(resumed), 7)]
    expect(Facts.fold(facts, resumed).provenance.baseline).toBe("legacy")
    expect(Facts.fold([], resumed).provenance.control).toBe("legacy-snapshot")
    expect(Facts.fold(facts, { ...resumed, status: "failed", updatedAt: 8 }).provenance.control).toBe(
      "unverified-snapshot"
    )
  })
  it("retains engine status with separate engine provenance", () => {
    const snapshot = { ...run, executionObservation: "observed" as const, status: "completed" as const }
    const result = Facts.fold([event("control.run.accepted", Facts.runFact(run, "created"))], snapshot)
    expect(result.run?.status).toBe("completed")
    expect(() => Facts.runFact(snapshot)).toThrow("executor observation")
    const native = {
      executionId: "native" as never,
      flowName: "agent/run",
      status: "completed" as const,
      createdAtMs: 1 as never,
      startedAtMs: null,
      finishedAtMs: 2 as never,
      parentRunId: null,
      lineageId: "native" as never,
      roundOrdinal: 0 as never,
      cancelRequestedAtMs: null,
      waiting: null
    }
    const forged = { ...run, executionView: { root: native, current: native } }
    expect(() => Facts.runFact(forged)).toThrow("executor observation")
    expect(
      Facts.fold([event("control.run.accepted", { factVersion: 1, baseline: "created", run: forged })], run).provenance
        .control
    )
      .toBe("unverified-snapshot")
    expect(result.provenance.execution).toBe("engine-observed")
    expect(Facts.fold([], { ...run, executionObservation: "missing" }).provenance.execution).toBe("engine-missing")
  })
  it("ignores foreign run facts", () => {
    expect(Facts.fold([event("control.run.accepted", Facts.runFact(run, "created"), 1, "other")], run).run).toEqual(run)
    expect(
      Facts.fold([event("control.run.accepted", Facts.runFact(run, "created"), 1, "other")], run).provenance.control
    ).toBe("legacy-snapshot")
  })
  it("captures a detached producer snapshot", () => {
    const input = { ...run }
    const fact = Facts.runFact(input)
    input.status = "failed"
    expect(fact.run.status).toBe("accepted")
  })
  it("refuses an unknown producer version or a missing lifecycle fact after a covered prefix", () => {
    const prefix = event("control.run.accepted", Facts.runFact(run, "created"))
    for (const payload of [{ runId: run.runId, status: "accepted" }, { ...Facts.runFact(run), factVersion: 2 }]) {
      expect(Facts.fold([prefix, event("control.run.accepted", payload, 2)], run).provenance.control).toBe(
        "unverified-snapshot"
      )
    }
    const resumed = { ...run, status: "running" as const, updatedAt: 3 }
    const result = Facts.fold([
      prefix,
      event("control.run.running", {}, 2),
      event("control.run.running", Facts.runFact(resumed), 3)
    ], resumed)
    expect(result.provenance).toMatchObject({ baseline: "legacy", fromSequence: 3, throughSequence: 3 })
  })
})

describe("approval fact identities", () => {
  it("admits a real versioned request", () => {
    expect(Facts.fold([request("one")]).approvals.map((row) => row.requestId)).toEqual(["one"])
  })
  it("settles reverse-order concurrent gates without reopening duplicated requests", () => {
    const rows =
      Facts.fold([request("one"), request("two"), decision("two"), decision("one", "denied"), request("one")]).approvals
    expect(rows.map((row) => [row.requestId, row.status])).toEqual([["one", "denied"], ["two", "approved"]])
  })
  it("holds an exact decision that arrives before its request", () => {
    expect(Facts.fold([decision("one"), request("one")]).approvals[0]?.status).toBe("approved")
  })
  it("never lets an unknown identity or legacy unnamed decision steal a versioned gate", () => {
    const rows = Facts.fold([request("one"), decision("other"), event("control.approval.denied", {})]).approvals
    expect(rows[0]?.status).toBe("pending")
  })
  it("joins requests by run and request, including legacy history", () => {
    const rows = Facts.fold([
      request("one", false),
      request("one", false, "run-2"),
      event("control.approval.approved", { tokenId: "one" }, 2, "run-2")
    ]).approvals
    expect(rows.map((row) => row.status)).toEqual(["pending", "approved"])
  })
  it("limits unnamed legacy decisions to legacy gates and first decisions win", () => {
    const rows = Facts.fold([
      request("new"),
      request("old", false),
      event("control.approval.denied", {}),
      event("control.approval.approved", { tokenId: "old" })
    ]).approvals
    expect(rows.map((row) => row.status)).toEqual(["pending", "denied"])
  })
  it("refuses wrong target/digest, unknown versions, and malformed current requests", () => {
    const wrong = decision("one")
    const payload = wrong.payload as Record<string, unknown>
    const rows = Facts.fold([
      request("one"),
      {
        ...wrong,
        payload: { ...payload, approvalTarget: { ...target("one"), envelope, digest: "wrong" } }
      } as ControlEvent
    ]).approvals
    expect(rows[0]?.status).toBe("pending")
    expect(Facts.fold([event("control.approval.requested", { factVersion: 2, requestId: "one" })]).approvals).toEqual(
      []
    )
    expect(
      Facts.fold([event("control.approval.requested", { factVersion: 1, requestId: "one", payload: {} })]).approvals
    ).toEqual([])
  })
  it("reads malformed legacy display payloads without throwing", () => {
    expect(() =>
      Facts.fold([
        decision("one"),
        event("control.approval.requested", {
          runId: run.runId,
          requestId: "one",
          payload: null
        })
      ])
    ).not.toThrow()
  })
})
