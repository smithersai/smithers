/**
 * The served read path, against a real SQLite control plane.
 *
 * Three of the eight requirements the old `packages/server` suite pinned live
 * here, re-expressed on the rc.0 boundary:
 *
 * - `mirror-approval-projection`: an approval request reaches a pending row
 *   carrying the payload that decides it, and a decision clears it without
 *   discarding the request.
 * - `mirror-cancellation-projection`: a cancellation's source, reason, and
 *   principal reach the run's terminal row.
 * - `whatHappenedRoute`: a run's diagnosis answers from the run's own facts,
 *   an unknown run is refused by name, and a node's output is addressable.
 */
import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, ApprovalTarget, PlanCard } from "@smthrs/control/ControlSchema"
import { RunStore } from "@smthrs/run-store/RunStore"
import { Deferred, Effect, Fiber, Schema, type Scope, Stream } from "effect"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import { make, Projections } from "../src/Projections.ts"
import { defaultCadenceStack, driverFence, emit, stack } from "./GatewayStack.ts"

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves, and starts one run; returns its id. */
const launch = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "gateway" } })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected an accepted run")
  return receipt.runId
})

const askTarget = (runId: string, requestId: string): Extract<ApprovalTarget, { readonly _tag: "Node" }> => ({
  _tag: "Node",
  runId,
  requestId,
  digest: `digest-${requestId}`,
  envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
})

const askPayload = (runId: string, requestId: string): ApprovalPayload => ({
  target: askTarget(runId, requestId),
  scope: "run",
  idempotencyKey: `approve:${requestId}`
})

/**
 * Parks a launched run on an approval, the way a run really parks: the ask is
 * registered with the control plane, journaled with the payload
 * `AgentSession.authorize` writes, and the run's status is moved to
 * `waiting-approval` through the same fenced transition `AgentSession.settle`
 * uses. Without the status write the run is not parked, and the workspace
 * inbox is scoped to parked runs.
 */
const parkOnApproval = (runId: string, requestId: string, question: string) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const payload = askPayload(runId, requestId)
    yield* runtime.registerApproval(askTarget(runId, requestId))
    yield* emit(runId, "control.approval.requested", { runId, requestId, question, payload })
    const fence = yield* driverFence(runId)
    yield* runtime.writeStatus(runId, fence, "waiting-approval")
    yield* emit(runId, "control.run.waiting-approval", { runId, status: "waiting-approval" })
    return payload
  })

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

const runScopedSelectors = (runId: string): ReadonlyArray<GatewaySchema.ProjectionSelector> => [
  { _tag: "run-summary", runId },
  { _tag: "run-tree", runId },
  { _tag: "run-events", runId },
  { _tag: "transcript", runId },
  { _tag: "approvals", runId },
  { _tag: "node-output", runId, nodeId: "call-1" }
]

describe("the fixture stack these projections read through", () => {
  // Every suite here launches through the noop executor, and `ControlLive`
  // releases a launch its executor declines: the run keeps its public
  // `accepted` status and loses its owner. A fixture that writes a run's
  // status is the executor that took the launch up, so it claims the run
  // before it fences. Pinning that here means a later change to the control
  // plane's release-on-decline semantics fails with the reason rather than
  // with an opaque `ClaimLost` from every fixture that writes a status.
  test("refuses a bare fence on a declined launch and fences it after a claim", () =>
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      expect((yield* runtime.getRun(runId)).status).toBe("accepted")

      const lost = yield* Effect.flip(runtime.claimFence(runId))
      expect(lost._tag).toBe("/control/ClaimLost")

      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "running")
      expect((yield* runtime.getRun(runId)).status).toBe("running")

      // A run this process now owns is fenced without a second claim.
      expect(yield* driverFence(runId)).toBe(fence)
    }).pipe(Effect.provide(stack())))
})

describe("gateway projections over a real SQLite control plane", () => {
  test("projects an approval request into a pending row carrying its decision payload", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* parkOnApproval(runId, "gate-1", "Ship it?")

      const rows = (yield* projections.snapshot({ _tag: "approvals", runId }))
        .rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ runId, requestId: "gate-1", title: "Ship it?", status: "pending" })
      // The row carries the submit-ready envelope, so a client decides the
      // gate by handing this payload back rather than rebuilding authority.
      expect(rows[0]?.payload).toMatchObject({
        scope: "run",
        target: { _tag: "Node", runId, requestId: "gate-1" }
      })

      // The workspace inbox is the same gate, reached the way an operator
      // reaches it: over every run the control plane reports as parked.
      const inbox = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows
      expect(inbox).toMatchObject([{ runId, requestId: "gate-1", title: "Ship it?", status: "pending" }])
    }).pipe(Effect.provide(stack())))

  test("lists one pending gate per parked run and drops the one that was decided", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const first = yield* launch
      const second = yield* launch
      const decided = yield* parkOnApproval(first, "gate-a", "Merge?")
      yield* parkOnApproval(second, "gate-b", "Deploy?")

      const before = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows
      expect(before.map((row) => row.requestId).sort()).toEqual(["gate-a", "gate-b"])

      yield* control.approve(decided)
      const after = (yield* projections.snapshot({ _tag: "approvals" }))
        .rows
      // The decided gate leaves the inbox; the other run is still waiting.
      expect(after.map((row) => row.requestId)).toEqual(["gate-b"])

      const closed = (yield* projections.snapshot({ _tag: "approvals", runId: first }))
        .rows
      // `ControlLive` journals the decision with `tokenId`, which for a Node
      // target is the request id, so the row it closed is the row it named.
      expect(closed).toMatchObject([{ requestId: "gate-a", status: "approved", title: "Merge?" }])
    }).pipe(Effect.provide(stack())))

  test("clears a pending approval on a decision without discarding the request", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.approval.requested", {
        runId,
        requestId: "gate-2",
        question: "Ship it?",
        payload: askPayload(runId, "gate-2")
      })
      const pending = (yield* projections.snapshot({ _tag: "approvals", runId })).rows
      expect(pending.map((row) => row.status)).toEqual(["pending"])

      yield* emit(runId, "control.approval.approved", {
        tokenId: "gate-2",
        target: "Node",
        scope: "run",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} },
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })
      const decided = (yield* projections.snapshot({ _tag: "approvals", runId })).rows
      expect(decided.map((row) => row.status)).toEqual(["approved"])
      // The decision event carries no question, so the projection kept the
      // request rather than nulling it.
      expect(decided[0]?.title).toBe("Ship it?")

      const events = (yield* projections.snapshot({ _tag: "run-events", runId })).rows
      // The raw event projection is the same ordered stream every fold reads.
      expect(events.length).toBeGreaterThan(0)

      const inbox = (yield* projections.snapshot({ _tag: "approvals" })).rows
      // This run was never parked, so the workspace inbox, which is scoped to
      // the runs the control plane reports as waiting, does not list it.
      expect(inbox).toHaveLength(0)
    }).pipe(Effect.provide(stack())))

  test("removes a cancelled pending gate from a live workspace inbox", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const projections = yield* Projections
      const runId = yield* launch
      yield* parkOnApproval(runId, "cancel-gate", "Ship?")
      const snapshotEnded = yield* Deferred.make<void>()
      const following = yield* Effect.forkChild(
        projections.subscribe({ _tag: "approvals" }).pipe(
          Stream.tap((frame) =>
            frame._tag === "snapshot-end" ? Deferred.succeed(snapshotEnded, undefined) : Effect.void
          ),
          Stream.filter((frame) => frame._tag === "delta"),
          Stream.take(1),
          Stream.runCollect
        )
      )
      yield* Deferred.await(snapshotEnded)
      yield* control.cancel({ runId, idempotencyKey: `cancel:${runId}` })
      const frames = yield* Fiber.join(following).pipe(Effect.timeout("10 seconds"))
      expect(frames[0]?.delta).toEqual([])
      expect((yield* projections.snapshot({ _tag: "approvals" })).rows).toEqual([])
      expect((yield* projections.snapshot({ _tag: "approvals", runId })).rows).toMatchObject([
        { requestId: "cancel-gate", status: "pending" }
      ])
    }).pipe(Effect.provide(stack())))

  test("records a cancellation's source, reason, and principal on the run row", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const runId = yield* launch
      yield* control.cancel({
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: "worker received SIGTERM",
        principal: { id: "operator", kind: "cli", stampedAt: 1 }
      })

      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows
      expect(rows[0]?.cancellation).toMatchObject({
        source: "control",
        reason: "worker received SIGTERM",
        principal: { id: "operator", kind: "cli" }
      })
    }).pipe(Effect.provide(stack())))

  test("diagnoses a run from its own events and addresses one node's output", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      // Exactly the payloads `@smthrs/agent` `AgentSession` journals: no node
      // id, no run id, no stamp. The projection keys the call by the ordinal
      // it opened on, because that is all the emitter gives it.
      yield* emit(runId, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })
      yield* emit(runId, "control.agent.cell-call-started", { flowName: "write", input: { path: "src/index.ts" } })
      yield* emit(runId, "control.agent.cell-call-settled", {
        flowName: "write",
        outcome: "success",
        value: "wrote src/index.ts"
      })
      yield* emit(runId, "control.agent.model-settled", {
        text: "done",
        usage: { inputTokens: 120, outputTokens: 34 },
        durationMillis: 42
      })
      // The run really finishes: the status moves under the run's own fence
      // and is journaled after it, which is the order `AgentSession.settle`
      // writes them in. The summary's status is the row's, so a fold that read
      // it off the journal alone would report the run's previous state.
      const runtime = yield* ControlRuntime
      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })

      const summary = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows[0]
      expect(summary?.seat).toBe("opus")
      expect(summary?.turns).toBe(1)
      expect(summary?.editsSucceeded).toBe(1)
      expect(summary?.status).toBe("completed")
      expect(summary?.verdict).toBe("completed")
      expect(summary?.diagnosis).toContain("Verdict")
      expect(summary?.diagnosis).toContain(runId)

      const tree = (yield* projections.snapshot({ _tag: "run-tree", runId })).rows
      expect(tree).toMatchObject([{ nodeId: "call-1", label: "write", status: "completed", seat: "opus" }])

      const output = (yield* projections.snapshot({ _tag: "node-output", runId, nodeId: "call-1" }))
        .rows
      expect(output).toMatchObject([{ nodeId: "call-1", outcome: "success", output: "wrote src/index.ts" }])

      const transcript = (yield* projections.snapshot({ _tag: "transcript", runId })).rows
      expect(transcript.map((row) => row.kind)).toContain("control.agent.turn-opened")
      expect(transcript.every((row) => row.runId === runId)).toBe(true)
    }).pipe(Effect.provide(stack())))

  test("reports model usage from the durable redacted journal", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      // The payload `@smthrs/agent` `AgentSession` journals for a settled model
      // call, verbatim.
      yield* emit(runId, "control.agent.model-settled", {
        text: "done",
        usage: { inputTokens: 120, outputTokens: 34 },
        durationMillis: 42
      })

      const settled = ((yield* projections.snapshot({ _tag: "run-events", runId })).rows as unknown as ReadonlyArray<
        { readonly kind: string; readonly payload: { readonly usage: Record<string, unknown> } }
      >).find((event) => event.kind === "control.agent.model-settled")
      // Numeric accounting survives structural redaction; a string under the
      // same credential-shaped key is still refused by the journal.
      expect(settled?.payload.usage).toEqual({ inputTokens: 120, outputTokens: 34 })

      const summary = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows[0]
      expect(summary?.inputTokens).toBe(120)
      expect(summary?.outputTokens).toBe(34)
    }).pipe(Effect.provide(stack())))

  for (const selector of runScopedSelectors("missing-run")) {
    test(`refuses an unknown run for ${selector._tag}`, () =>
      Effect.gen(function*() {
        const projections = yield* Projections
        const failure = yield* Effect.flip(projections.snapshot(selector))
        expect(failure.code).toBe("run_not_found")
        expect(failure.message).toContain("missing-run")
      }).pipe(Effect.provide(stack())))
  }

  test("serves rows that decode under the schema rowSchemaFor names for their selector", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      yield* emit(runId, "control.agent.cell-call-started", { flowName: "write", input: { path: "src/index.ts" } })
      yield* emit(runId, "control.agent.cell-call-settled", {
        flowName: "write",
        outcome: "success",
        value: "wrote src/index.ts"
      })
      yield* emit(runId, "control.approval.requested", {
        runId,
        requestId: "gate-schema",
        question: "Ship it?",
        payload: askPayload(runId, "gate-schema")
      })
      const selectorFor = {
        "workspace-runs": { _tag: "workspace-runs" },
        "run-summary": { _tag: "run-summary", runId },
        "run-events": { _tag: "run-events", runId },
        transcript: { _tag: "transcript", runId },
        "run-tree": { _tag: "run-tree", runId },
        approvals: { _tag: "approvals", runId },
        "node-output": { _tag: "node-output", runId, nodeId: "call-1" }
      } as const satisfies Record<GatewaySchema.ProjectionName, GatewaySchema.ProjectionSelector>

      // The declared decoder used to be tested only against rows assembled by
      // the same pure folds. These rows came through the real SQLite read path,
      // so a drift between the served shape and the client schema fails here.
      for (const name of GatewaySchema.ProjectionName.literals) {
        const selector = selectorFor[name]
        const snapshot = yield* projections.snapshot(selector)
        expect(snapshot.rows.length).toBeGreaterThan(0)
        for (const row of snapshot.rows) {
          expect(Schema.decodeUnknownSync(GatewaySchema.rowSchemaFor(selector))(row)).toEqual(row)
        }
        expect(Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)(snapshot)).toEqual(snapshot)
      }
    }).pipe(Effect.provide(stack())))

  test("lists every workspace run as a summary row", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows
      expect(rows.map((row) => row.runId)).toEqual([runId])
      expect(rows[0]?.flowId).toBe("system/test")
    }).pipe(Effect.provide(stack())))

  test("sends one arrived event per run-events delta, never the log again", () =>
    Effect.gen(function*() {
      const control = yield* Control
      // Force snapshot I/O past the old 100 ms producer delay.
      const projections = yield* make({
        ...control,
        list: (request) => control.list(request).pipe(Effect.delay("200 millis"))
      })
      const runId = yield* launch
      yield* emit(runId, "control.agent.turn-opened", { seat: "opus", contextDigest: "ctx" })
      yield* emit(runId, "control.agent.model-settled", { text: "done", usage: {} })

      // A follower asked for what is new. Recomputing `run-events` re-read the
      // whole history and re-sent it on every frame, which is quadratic in run
      // length and is the opposite of following.
      const snapshotEnded = yield* Deferred.make<void>()
      const following = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(
            Stream.filter(
              projections.subscribe({ _tag: "run-events", runId }).pipe(
                Stream.tap((frame) =>
                  frame._tag === "snapshot-end"
                    ? Deferred.succeed(snapshotEnded, undefined) :
                    Effect.void
                )
              ),
              (frame) => frame._tag === "delta"
            ),
            1
          )
        )
      )
      yield* Deferred.await(snapshotEnded)
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })
      const frames = yield* Fiber.join(following)

      const delta = frames[0]
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      const rows = delta.delta
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ runId, kind: "control.run.completed" })

      // The snapshot of the same selector still carries the whole log, so the
      // delta is an addition to it and not a different projection.
      const snapshot = (yield* projections.snapshot({ _tag: "run-events", runId })).rows
      expect(snapshot.length).toBeGreaterThan(1)
    }).pipe(Effect.provide(stack())))

  test("serves the same rows under the shipped keepalive cadence", () =>
    Effect.gen(function*() {
      // The default layer is what a host composes; the suites above pin the
      // rows under a short cadence, and this pins that the shipped one reads
      // the same control plane.
      const projections = yield* Projections
      const runId = yield* launch
      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows
      expect(rows).toHaveLength(1)
    }).pipe(Effect.provide(defaultCadenceStack)))
})

describe("empty journal follow", () => {
  test("delivers the first two committed events after snapshot-end", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runs = yield* RunStore
      const runId = "empty-journal-run"
      yield* runs.create(runId, JSON.stringify({ flowName: "system/test" }))
      const snapshotEnded = yield* Deferred.make<void>()
      const following = yield* Effect.forkChild(
        projections.subscribe({ _tag: "run-events", runId }).pipe(
          Stream.tap((frame) =>
            frame._tag === "snapshot-end" ? Deferred.succeed(snapshotEnded, undefined) : Effect.void
          ),
          Stream.filter((frame) => frame._tag === "delta"),
          Stream.take(2),
          Stream.runCollect
        )
      )
      yield* Deferred.await(snapshotEnded)
      yield* emit(runId, "control.run.accepted", { runId })
      yield* emit(runId, "control.run.running", { runId })
      const frames = yield* Fiber.join(following).pipe(Effect.timeout("5 seconds"))
      expect(frames.map((frame) => frame.cursor.value)).toEqual([0, 1])
      expect(frames.flatMap<unknown>((frame) => frame.delta)).toMatchObject([
        { sequence: 0, kind: "control.run.accepted" },
        { sequence: 1, kind: "control.run.running" }
      ])
    }).pipe(Effect.provide(stack())))
})

describe("incremental journal snapshots", () => {
  test("returns only rows after the issued cursor and retains full inspection", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      const selector = { _tag: "run-events" as const, runId }
      const initial = yield* projections.snapshot(selector)
      expect(initial.rows.length).toBeGreaterThan(0)
      const unchanged = yield* projections.snapshot(selector, initial.cursor)
      expect(unchanged.rows).toEqual([])
      yield* emit(runId, "control.agent.turn-opened", { seat: "test" })
      const next = yield* projections.snapshot(selector, initial.cursor)
      expect(next.rows).toHaveLength(1)
      const full = yield* projections.snapshot(selector)
      expect(full.rows).toEqual([...initial.rows, ...next.rows])
      expect(next.cursor).toEqual(full.cursor)
      expect((yield* projections.snapshot(selector, next.cursor)).rows).toEqual([])
      const wrongRun = { ...initial.cursor, runId: "another-run" }
      expect((yield* Effect.flip(projections.snapshot(selector, wrongRun))).code).toBe("malformed_request")
      const future = { ...initial.cursor, value: next.cursor.value + 100 }
      expect((yield* Effect.flip(projections.snapshot(selector, future))).code).toBe("malformed_request")
    }).pipe(Effect.provide(stack())))
})
