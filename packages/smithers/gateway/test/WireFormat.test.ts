/**
 * Golden vectors for the bytes this package puts on the wire.
 *
 * A projection row and a subscription frame are read by clients that are not
 * this repository: the product relay hand-parses the NDJSON envelope, and a
 * browser decodes the rows. A renamed field, a field that became optional, or
 * a frame that grew a member needs a compatibility review. Exact encoded
 * shapes make that drift visible, and decoder tests establish whether an
 * addition remains compatible. Every expectation here is the whole object,
 * never a subset.
 */
import type { ControlSchema } from "@smthrs/control"
import * as Health from "@smthrs/control/Health"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import { Projections } from "../src/Projections.ts"

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

    expect(Schema.decodeUnknownSync(GatewayProjection.RunSummaryRow)(encode(GatewayProjection.RunSummaryRow, row)))
      .toEqual(row)
    expect(encode(GatewayProjection.RunSummaryRow, row)).toEqual({
      runId: "run-1",
      flowId: "deploy",
      status: "completed",
      lifecycleProvenance: { control: "legacy-snapshot", execution: "control" },
      /*
       * `statusRollup` joined the row in 1.0.0-rc.0 as an additive change:
       * the schema declares it optional, every field that was on the wire
       * before it is still there with the same meaning, and a client built
       * against the previous Effect row drops it (strict external decoders
       * need their own compatibility review). The fold always emits
       * one, so a run nobody has probed still reports its lifecycle state,
       * unobserved, rather than no health at all.
       */
      statusRollup: {
        subjectId: "run:run-1",
        state: "completed",
        activity: "unknown",
        health: "healthy",
        attention: "none",
        freshness: "unobserved",
        updatedAt: 2_000
      },
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

  it("freezes a run summary row whose rollup carries a fresh observation", () => {
    // The richest rollup the wire carries: a probe of the run's current
    // incarnation, still inside its lifetime at `now`, so its activity, its
    // reason, and its provenance all reach the client.
    const running: ControlSchema.RunSummary = { ...run, status: "running", ownerId: "owner-1" }
    const incarnation = Health.runIncarnation(running)
    const observation: Health.HealthObservation = {
      subjectId: "run:run-1",
      state: "running",
      checkerId: "semantic",
      monitorId: "monitor-1",
      incarnation,
      evidenceSeq: 2,
      observedAt: 3_000,
      expiresAt: 4_000,
      durationMs: 5,
      outcome: "ok",
      baseHealth: "healthy",
      report: { activity: "working", reason: "ok" }
    }
    const row = GatewayProjection.runSummary(running, [
      event(1, "control.run.accepted", { runId: "run-1", status: "accepted" }),
      event(2, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" }),
      event(3, Health.statusObservedEventType, Schema.encodeUnknownSync(Health.HealthObservation)(observation))
    ], 3_500)

    expect(Schema.decodeUnknownSync(GatewayProjection.RunSummaryRow)(encode(GatewayProjection.RunSummaryRow, row)))
      .toEqual(row)
    expect(encode(GatewayProjection.RunSummaryRow, row)).toEqual({
      runId: "run-1",
      flowId: "deploy",
      status: "running",
      lifecycleProvenance: { control: "legacy-snapshot", execution: "control" },
      statusRollup: {
        subjectId: "run:run-1",
        state: "running",
        activity: "working",
        health: "healthy",
        attention: "none",
        freshness: "fresh",
        reason: "ok",
        provenance: {
          checkerId: "semantic",
          monitorId: "monitor-1",
          observedAt: 3_000,
          expiresAt: 4_000,
          evidenceSeq: 2,
          incarnation,
          version: 3
        },
        updatedAt: 3_000
      },
      createdAt: 1_000,
      updatedAt: 2_000,
      seat: "opus",
      turns: 1,
      calls: 0,
      callsFailed: 0,
      editsAttempted: 0,
      editsSucceeded: 0,
      inputTokens: 0,
      outputTokens: 0,
      verdict: "running",
      diagnosis: [
        "Verdict   running",
        "Run       run-1 · deploy · opus · 1s",
        "Activity  1 turns · 0 calls (0 refused) · edits 0/0",
        "Tokens    0 in / 0 out"
      ].join("\n")
    })
  })

  it("still decodes for a client built against the row before statusRollup", () => {
    // The previous RunSummaryRow, as a client that predates the field holds
    // it: the same fields without `statusRollup`. Additive means such a
    // client reads today's row and sees exactly what it always saw.
    const { statusRollup: _added, ...previousFields } = GatewayProjection.RunSummaryRow.fields
    const PreviousRunSummaryRow = Schema.Struct(previousFields)
    const encoded = encode(GatewayProjection.RunSummaryRow, GatewayProjection.runSummary(run, [])) as Record<
      string,
      unknown
    >
    const { statusRollup, ...previousRow } = encoded

    expect(statusRollup).toBeDefined()
    expect(Schema.decodeUnknownSync(PreviousRunSummaryRow)(encoded)).toEqual(previousRow)
    // New clients also accept old rows without inventing an observation.
    expect(Schema.decodeUnknownSync(GatewayProjection.RunSummaryRow)(previousRow)).toEqual(previousRow)
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

  it("freezes a duration row folded from the engine's own node records", () => {
    const record = (eventType: string, payload: unknown, emittedAtMs: number, sequence: number) =>
      event(sequence, "control.engine.event", {
        version: 1,
        executionId: "native",
        generation: 0,
        sequence,
        emittedAtMs,
        sourceSequence: 0,
        sourceId: `engine/${eventType}`,
        eventType,
        payload
      })
    const events = [
      record("flows.engine.node-scheduled", { nodeId: "compile", kind: "step", attempt: 1, action: "build" }, 100, 1),
      record("flows.engine.node-settled", { nodeId: "compile", outcome: "built", attempts: 1, action: "build" }, 340, 2)
    ]

    expect(
      encode(
        Schema.Array(GatewayProjection.FlowDurationRow),
        GatewayProjection.flowDurations(run.flowId, GatewayProjection.nodeDurations(events))
      )
    ).toEqual([{
      flowId: "deploy",
      actionTag: "build",
      samples: 1,
      p50Ms: 240,
      p90Ms: 240
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

  it("round-trips the additive call identity while accepting legacy transcript rows", () => {
    const rows = GatewayProjection.transcript([
      event(1, "control.agent.cell-call-started", { callId: "cell-call-v1:example", flowName: "write" })
    ])
    const wire = {
      runId: "run-1",
      sequence: 1,
      turn: 0,
      at: 1000,
      kind: "control.agent.cell-call-started",
      callId: "cell-call-v1:example",
      text: "call write"
    }
    expect(encode(GatewayProjection.TranscriptRow, rows[0]!)).toEqual(wire)
    expect(Schema.decodeUnknownSync(GatewayProjection.TranscriptRow)(wire)).toEqual(rows[0])
    const { callId: _, ...legacy } = wire
    expect(Schema.decodeUnknownSync(GatewayProjection.TranscriptRow)(legacy)).toEqual(legacy)
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

  it("spells every service tag under @smthrs/gateway/", () => {
    expect([Projections.key]).toEqual(["@smthrs/gateway/Projections"])
  })
})
