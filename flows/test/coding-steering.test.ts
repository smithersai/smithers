import { NodeCrypto } from "@effect/platform-node"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as Control from "@smthrs/control/Control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { RunNotFound } from "@smthrs/control/ControlError"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Notifications from "../../packages/smithers/agent/harness/src/Notifications.ts"
import * as DurableWriter from "../../packages/smithers/flows/database/src/DurableWriter.ts"
import * as Journal from "../../packages/smithers/flows/journal/src/Journal.ts"
import * as Migrations from "../../packages/smithers/flows/journal/src/Migrations.ts"
import * as SqlJournal from "../../packages/smithers/flows/journal/src/SqlJournal.ts"
import type { Notification } from "../../packages/smithers/notifications/src/Notification.ts"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import * as LocalControl from "../../packages/smithers/src/internal/LocalControl.ts"
import { appendFeedback, feedbackLayer, FeedbackReceipt, ReceiveFeedback, routeMessages } from "../coding/steering.ts"

const controlLayer = ControlRuntime.layerMemory({ flows: ["coding/request", "other"].map(flowId => ({
  flowId, description: "Steering fixture", deployClass: false, executionDigest: "sha256:fixture",
  envelope: { capabilities: [], flows: ["coding/RunRequest"] }
})) }).pipe(Layer.provide(NodeCrypto.layer))

const launch = (control: ControlRuntime.Service, flowId = "coding/request") => Effect.gen(function*() {
  const { card } = yield* control.plan({ flowId, input: {} })
  const token = yield* control.lookupApproval(card.approval.target)
  const principal = yield* control.stampPrincipal()
  yield* control.resolveApproval(token, "approved", principal)
  const result = yield* control.launch(card.planId, card.digest, card.envelope)
  if (result._tag !== "Started") return yield* Effect.die("expected approved fixture")
  return result.run
})
const message = (id: string, runId: string, payload: Notification["payload"] = { kind: "Message", body: id }): Notification => ({
  _tag: "human-steer", id, delivery: "steer", targetLineageId: runId,
  // This is attribution, not an authenticated role claim. Message routing
  // must not infer human authority from its spelling.
  provenance: { sourceRunId: runId, sourceLineageId: runId, sourceTurn: 0, sourceActor: "automation:fixture" }, payload
})

const journalLayer = async (filename: string) => {
  const database = "Bun" in globalThis
    ? await import("../../packages/smithers/flows/database/src/bun/BunDatabase.ts")
    : await import("../../packages/smithers/flows/database/src/node/NodeDatabase.ts")
  const db = DurableWriter.layer().pipe(Layer.provideMerge(database.layer({ filename })))
  return SqlJournal.layer({ capacity: 128, overflow: "reject" }).pipe(
    Layer.provide(Migrations.layer.pipe(Layer.provideMerge(db)))
  )
}

test("messages use coordinator receipts while settings, other roots and explicit lineages retain native delivery", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = await journalLayer(join(root, "control.db"))
  const host = ManagedRuntime.make(Layer.mergeAll(controlLayer, NotificationQueue.layer.pipe(Layer.provideMerge(journal))))
  t.after(() => host.dispose())
  const captured = await host.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const native = yield* NotificationQueue.NotificationQueue
    const queue = routeMessages(native, control)
    const owner = yield* launch(control), other = yield* launch(control, "other")
    const note = message("prototype-feedback", owner.runId, { body: "Keep the retained prototype's compact layout." })
    const admitted = yield* queue.admit(owner.runId, note)
    assert.equal(admitted.duplicate, false)
    assert.equal((yield* queue.admit(owner.runId, note)).duplicate, true)
    for (const [id, payload] of [["seat", { kind: "Seat", seat: "configured:model" }],
      ["thinking", { kind: "Thinking", thinking: "high" }],
      ["tools", { kind: "Tools", toolNames: ["read"] }]] as const) {
      yield* queue.admit(owner.runId, message(id, owner.runId, payload))
    }
    yield* queue.admit(other.runId, message("other-message", other.runId))
    yield* queue.admit(owner.runId, message("leaf-message", "explicit-native-leaf"))
    const source = yield* Notifications.make({ runId: owner.runId, lineageId: owner.runId }).pipe(
      Effect.provideService(NotificationQueue.NotificationQueue, queue)
    )
    const drained = yield* source.drain({ boundary: "model-close", wouldIdle: true })
    assert.deepEqual(drained.seatChanges.map(change => change._tag), ["SeatChange", "ThinkingChange"])
    assert.equal(drained.inserts.length, 1) // existing unsupported-Tools explanation
    assert.equal(JSON.stringify(drained).includes("compact layout"), false)
    assert.deepEqual((yield* native.drain({ runId: other.runId, targetLineageId: other.runId, boundary: "other", wouldIdle: true })).notifications.map(n => n.id), ["other-message"])
    assert.deepEqual((yield* native.drain({ runId: owner.runId, targetLineageId: "explicit-native-leaf", boundary: "leaf", wouldIdle: true })).notifications.map(n => n.id), ["leaf-message"])
    const pending = yield* queue.pending(owner.runId)
    assert.equal(pending.length, 1)
    assert.notEqual(pending[0]!.targetLineageId, owner.runId)
    assert.deepEqual(pending[0]!.provenance, note.provenance)
    return { runId: owner.runId, notification: pending[0]! }
  }))
  // Close the real SQLite services. A fresh queue must recover the same
  // committed admission and the same boundary receipt, including an empty one.
  await host.dispose()
  const reopened = ManagedRuntime.make(NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db")))))
  t.after(() => reopened.dispose())
  await reopened.runPromise(Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const input = { runId: captured.runId, targetLineageId: captured.notification.targetLineageId, boundary: "coordinator/after-poc/0", wouldIdle: true }
    const first = yield* queue.drain(input)
    assert.deepEqual(first.notifications, [captured.notification])
    assert.equal(first.duplicate, false)
    yield* queue.admit(captured.runId, { ...captured.notification, id: "later-feedback" })
    const replay = yield* queue.drain(input)
    assert.equal(replay.duplicate, true)
    assert.deepEqual(replay.notifications, first.notifications)
    assert.deepEqual((yield* queue.pending(captured.runId)).map(n => n.id), ["later-feedback"])
    const next = yield* queue.drain({ ...input, boundary: "coordinator/before-implementation/1" })
    assert.deepEqual(next.notifications.map(n => n.id), ["later-feedback"])
    assert.equal((yield* queue.drain({ ...input, boundary: "after-correction" })).notifications.length, 0)
    // Closing the last safe boundary is not an atomic close of the control
    // run. A later admission remains pending; replay must not pretend it ran.
    yield* queue.admit(captured.runId, { ...captured.notification, id: "after-final-boundary" })
    assert.equal((yield* queue.drain({ ...input, boundary: "after-correction" })).notifications.length, 0)
  }))
  await reopened.dispose()
  const cold = ManagedRuntime.make(NotificationQueue.layer.pipe(Layer.provide(await journalLayer(join(root, "control.db")))))
  t.after(() => cold.dispose())
  await cold.runPromise(Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const input = { runId: captured.runId, targetLineageId: captured.notification.targetLineageId, boundary: "coordinator/after-poc/0", wouldIdle: true }
    assert.deepEqual((yield* queue.drain(input)).notifications, [captured.notification])
    assert.equal((yield* queue.drain({ ...input, boundary: "after-correction" })).duplicate, true)
    assert.deepEqual((yield* queue.pending(captured.runId)).map(n => n.id), ["after-final-boundary"])
  }))
})

test("routing refuses absent, stale or unapproved coding owners and preserves the caller transaction", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-transaction-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = ManagedRuntime.make(Layer.mergeAll(controlLayer,
    NotificationQueue.layerWith({ capacity: 1 }).pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))))
  t.after(() => host.dispose())
  await host.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const native = yield* NotificationQueue.NotificationQueue
    const journal = yield* Journal.Journal
    const owner = yield* launch(control)
    for (const altered of [
      { ...control, getRun: (runId: string) => Effect.fail(new RunNotFound({ runId })) },
      { ...control, getRun: (id: string) => control.getRun(id).pipe(Effect.map(run => ({ ...run, status: "completed" as const }))) },
      { ...control, getPlan: (id: string) => control.getPlan(id).pipe(Effect.map(plan => ({ ...plan, decision: "pending" as const }))) },
      { ...control, getPlan: (id: string) => control.getPlan(id).pipe(Effect.map(plan => ({ ...plan, card: { ...plan.card, digest: "stale" } }))) },
      { ...control, getPlan: (id: string) => control.getPlan(id).pipe(Effect.map(plan => ({ ...plan, card: { ...plan.card, envelope: { ...plan.card.envelope, flows: [] } } }))) }
    ]) {
      const refused = yield* routeMessages(native, altered).admit(owner.runId, message("refused", owner.runId)).pipe(Effect.flip)
      assert.equal(refused._tag, "/notifications/NotificationError")
    }
    assert.deepEqual(yield* native.pending(owner.runId), [])
    const queue = routeMessages(native, control)
    yield* journal.transact(Effect.gen(function*() {
      yield* queue.admit(owner.runId, message("rolled-back", owner.runId))
      return yield* Effect.fail("rollback")
    })).pipe(Effect.flip)
    assert.deepEqual(yield* native.pending(owner.runId), [])
    assert.equal((yield* queue.admit(owner.runId, message("rolled-back", owner.runId))).duplicate, false)
    const full = yield* queue.admit(owner.runId, message("overflow", owner.runId)).pipe(Effect.flip)
    assert.equal(full._tag, "/notifications/NotificationError")
    assert.match(full.message, /queue is full/)
    assert.deepEqual((yield* native.pending(owner.runId)).map(n => n.id), ["rolled-back"])
  }))
})

test("actual feedback action needs a proved owner and retains attributed overflow before refusing planning", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-action-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parent = ManagedRuntime.make(Layer.mergeAll(controlLayer,
    NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))))
  t.after(() => parent.dispose())
  const { queue, owner } = await parent.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    return { owner: yield* launch(control), queue: routeMessages(yield* NotificationQueue.NotificationQueue, control) }
  }))
  await parent.runPromise(queue.admit(owner.runId, message("oversized", owner.runId, { kind: "Message", body: "x".repeat(65_539) })))
  const Probe = Flow.make("test/ReceiveFeedback", {
    payload: {}, success: FeedbackReceipt, error: ReceiveFeedback.errorSchema,
    body: () => ReceiveFeedback.call({ boundary: "after-poc", revision: 0 })
  })
  const build = (identity?: { rootId: string; flowId: string }) => ManagedRuntime.make(Layer.mergeAll(
    Interpreter.layer(Probe), feedbackLayer
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provide(Layer.succeed(NotificationQueue.NotificationQueue, queue)),
    Layer.provide(identity === undefined ? Layer.empty : Layer.succeed(ModuleOwner, identity)),
    Layer.provideMerge(NodeCrypto.layer)))
  for (const identity of [undefined, { rootId: owner.runId, flowId: "other" }]) {
    const runtime = build(identity)
    try {
      const error = await runtime.runPromise(Probe.execute({}).pipe(Effect.flip, Effect.scoped))
      assert.equal(error.code, "unavailable")
    } finally { await runtime.dispose() }
  }
  assert.equal((await parent.runPromise(queue.pending(owner.runId))).length, 1)
  const runtime = build({ rootId: owner.runId, flowId: "coding/request" })
  t.after(() => runtime.dispose())
  const receipt = await runtime.runPromise(Probe.execute({}).pipe(Effect.scoped))
  assert.match(receipt.boundary, /after-poc/)
  assert.equal(receipt.messages[0]!.id, "oversized")
  assert.equal((await parent.runPromise(queue.pending(owner.runId))).length, 0)
  const error = await Effect.runPromise(appendFeedback("", receipt).pipe(Effect.flip))
  assert.equal(error.code, "invalid_plan")
  assert.match(error.message, /oversized/)
  assert.equal(Schema.decodeUnknownSync(FeedbackReceipt)(receipt).messages[0]!.provenance.sourceActor, "automation:fixture")
  const small = { ...receipt, messages: [message("small", owner.runId, { kind: "Message", body: "Use a compact list." })] }
  const combined = await Effect.runPromise(appendFeedback("POC feedback.", small))
  assert.match(combined, /^POC feedback\./)
  assert.match(combined, /automation:fixture/)
  assert.match(combined, /Use a compact list\./)
})

test("private host composition shares one decorated queue with Control and the executor", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-composition-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let executorQueue: NotificationQueue.Service | undefined
  let decorated: NotificationQueue.Service | undefined
  let decorations = 0
  const executor = Layer.effect(ControlExecutor.ControlExecutor, Effect.map(NotificationQueue.NotificationQueue, queue => {
    executorQueue = queue
    return ControlExecutor.makeNoop()
  }))
  const host = ManagedRuntime.make(LocalControl.layer(Registry.layerNoop(), {
    runtime: controlLayer, journal: await journalLayer(join(root, "control.db"))
  }, executor, (queue, control) => {
    decorations++
    decorated = routeMessages(queue, control)
    return decorated
  }).pipe(Layer.provideMerge(controlLayer)))
  t.after(() => host.dispose())
  await host.runPromise(Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    const control = yield* Control.Control
    const run = yield* launch(runtime)
    const receipt = yield* control.steer({ runId: run.runId, idempotencyKey: "composition-message", message: {
      runId: run.runId, messageId: "composition-message", principal: yield* runtime.stampPrincipal(),
      createdAt: 0, body: "Revise the next plan."
    } })
    assert.equal(receipt._tag, "Accepted")
    assert.equal(decorations, 1)
    assert.equal(executorQueue, decorated)
    assert.ok(executorQueue)
    const pending = yield* executorQueue.pending(run.runId)
    assert.equal(pending[0]!.id, "composition-message")
    assert.notEqual(pending[0]!.targetLineageId, run.runId)
    assert.equal((yield* executorQueue.drain({ runId: run.runId, targetLineageId: run.runId,
      boundary: "model", wouldIdle: true })).notifications.length, 0)
  }))
})
