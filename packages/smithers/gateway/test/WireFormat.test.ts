/**
 * Golden vectors for the bytes this package puts on the wire.
 *
 * A projection row and a subscription frame are read by clients that are not
 * this repository: the product relay hand-parses the NDJSON envelope, and a
 * browser decodes the rows. A renamed field, a field that became optional, or
 * a frame that grew a member is a breaking change for all of them, and the
 * only way that shows up as a test failure is if the exact encoded shape is
 * written down. Every expectation here is the whole object, never a subset.
 */
import type { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import { Projections } from "../src/Projections.ts"
import { ResumeError, SuperviseRuntime } from "../src/SuperviseRuntime.ts"

const encode = <A, I, R>(schema: Schema.Codec<A, I, R>, value: A): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeUnknownSync(schema)(value)))

const run: ControlSchema.RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "completed",
  createdAt: 1_000,
  updatedAt: 2_000
}

const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence * 1_000,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

describe("the encoded projection rows", () => {
  it("freezes a run summary row", () => {
    const row = GatewayProjection.runSummary(run, [
      event(1, "control.run.accepted", { runId: "run-1", status: "accepted" }),
      event(2, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event(3, "control.agent.cell-call-started", { flowName: "write", input: {} }),
      event(4, "control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote it" }),
      event(5, "control.agent.resolved", { text: "shipped" }),
      event(6, "control.run.completed", { runId: "run-1", status: "completed" })
    ])

    expect(encode(GatewayProjection.RunSummaryRow, row)).toEqual({
      runId: "run-1",
      flowId: "deploy",
      status: "completed",
      createdAt: 1_000,
      updatedAt: 2_000,
      seat: "opus",
      turns: 1,
      calls: 1,
      callsFailed: 0,
      editsAttempted: 1,
      editsSucceeded: 1,
      inputTokens: 0,
      outputTokens: 0,
      verdict: "completed — shipped",
      diagnosis: [
        "Verdict   completed — shipped",
        "Run       run-1 · deploy · opus · 5s",
        "Activity  1 turns · 1 calls (0 refused) · edits 1/1",
        "Tokens    0 in / 0 out",
        "Output    shipped"
      ].join("\n"),
      finalOutput: "shipped"
    })
  })

  it("freezes a run tree row and the node output that names the same node", () => {
    const events = [
      event(1, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event(2, "control.agent.cell-call-started", { flowName: "write", input: {} }),
      event(3, "control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote it" })
    ]

    expect(encode(Schema.Array(GatewayProjection.RunTreeRow), GatewayProjection.runTree(run, events))).toEqual([{
      runId: "run-1",
      nodeId: "call-1",
      label: "write",
      status: "completed",
      seat: "opus",
      startedAt: 2_000,
      endedAt: 3_000
    }])

    expect(encode(Schema.Array(GatewayProjection.NodeOutputRow), GatewayProjection.nodeOutput(events))).toEqual([{
      runId: "run-1",
      nodeId: "call-1",
      outcome: "success",
      output: "wrote it",
      settledAt: 3_000
    }])
  })

  it("freezes an approval row, including the payload a client submits back", () => {
    const payload = {
      target: {
        _tag: "Node",
        runId: "run-1",
        requestId: "gate",
        digest: "gate-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      },
      scope: "run",
      idempotencyKey: "approve:gate"
    }
    const rows = GatewayProjection.approvals([
      event(1, "control.approval.requested", { runId: "run-1", requestId: "gate", question: "Ship?", payload })
    ])

    expect(encode(Schema.Array(GatewayProjection.ApprovalRow), rows)).toEqual([{
      runId: "run-1",
      requestId: "gate",
      title: "Ship?",
      request: { runId: "run-1", requestId: "gate", question: "Ship?", payload },
      payload,
      requestedAt: 1_000,
      status: "pending"
    }])
  })

  it("freezes a transcript row", () => {
    const rows = GatewayProjection.transcript([event(1, "control.agent.turn-opened", { seat: "opus" })])
    expect(encode(Schema.Array(GatewayProjection.TranscriptRow), rows)).toEqual([{
      runId: "run-1",
      sequence: 1,
      turn: 1,
      at: 1_000,
      kind: "control.agent.turn-opened",
      text: "turn opened · opus"
    }])
  })
})

describe("the encoded subscription frames", () => {
  const selector = { _tag: "run-summary" as const, runId: "run-1" }
  const cursor = { selector, projection: "run-summary" as const, runId: "run-1", value: 6, offset: 0 }
  const row = GatewayProjection.runSummary(run, [])

  it("freezes the snapshot, row, delta, and heartbeat frames", () => {
    expect(encode(GatewaySchema.GatewayFrame, { _tag: "snapshot-start", selector, cursor })).toEqual({
      _tag: "snapshot-start",
      selector: { _tag: "run-summary", runId: "run-1" },
      cursor: {
        selector: { _tag: "run-summary", runId: "run-1" },
        projection: "run-summary",
        runId: "run-1",
        value: 6,
        offset: 0
      }
    })
    expect(encode(GatewaySchema.GatewayFrame, { _tag: "row", selector, cursor, row })).toEqual({
      _tag: "row",
      selector: { _tag: "run-summary", runId: "run-1" },
      cursor: {
        selector: { _tag: "run-summary", runId: "run-1" },
        projection: "run-summary",
        runId: "run-1",
        value: 6,
        offset: 0
      },
      row
    })
    expect(encode(GatewaySchema.GatewayFrame, { _tag: "snapshot-end", selector, cursor })).toEqual({
      _tag: "snapshot-end",
      selector: { _tag: "run-summary", runId: "run-1" },
      cursor: {
        selector: { _tag: "run-summary", runId: "run-1" },
        projection: "run-summary",
        runId: "run-1",
        value: 6,
        offset: 0
      }
    })
    expect(encode(GatewaySchema.GatewayFrame, { _tag: "delta", selector, cursor, delta: [] })).toEqual({
      _tag: "delta",
      selector: { _tag: "run-summary", runId: "run-1" },
      cursor: {
        selector: { _tag: "run-summary", runId: "run-1" },
        projection: "run-summary",
        runId: "run-1",
        value: 6,
        offset: 0
      },
      delta: []
    })
    expect(encode(GatewaySchema.GatewayFrame, { _tag: "heartbeat", atMs: 1_700_000_000_000 })).toEqual({
      _tag: "heartbeat",
      atMs: 1_700_000_000_000
    })
  })

  it("freezes a workspace cursor as a null run at zero", () => {
    expect(
      encode(GatewaySchema.ProjectionSnapshot, {
        selector: { _tag: "workspace-runs" },
        cursor: {
          selector: { _tag: "workspace-runs" },
          projection: "workspace-runs",
          runId: null,
          value: 0,
          offset: 0
        },
        rows: []
      })
    ).toEqual({
      selector: { _tag: "workspace-runs" },
      cursor: {
        selector: { _tag: "workspace-runs" },
        projection: "workspace-runs",
        runId: null,
        value: 0,
        offset: 0
      },
      rows: []
    })
  })
})

describe("the tag namespace", () => {
  it("freezes a refusal body's tag", () => {
    expect(encode(GatewayError, new GatewayError({ code: "unauthorized", message: "no" }))).toEqual({
      _tag: "@smthrs/gateway/GatewayError",
      code: "unauthorized",
      message: "no"
    })
  })

  it("freezes a resume failure's tag", () => {
    expect(encode(ResumeError, new ResumeError({ code: "claim_lost", message: "lost", cause: null }))).toEqual({
      _tag: "@smthrs/gateway/ResumeError",
      code: "claim_lost",
      message: "lost",
      cause: null
    })
  })

  it("spells every service tag under @smthrs/gateway/", () => {
    expect([SuperviseRuntime.key, Projections.key]).toEqual([
      "@smthrs/gateway/SuperviseRuntime",
      "@smthrs/gateway/Projections"
    ])
  })
})
