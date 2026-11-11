/**
 * A node approval has to restart the run it parked, and reach the process that
 * can restart it.
 *
 * `ask` parks the run as `waiting-approval` and publishes the exact payload an
 * operator replays through `smithers approve`. Answering it installed the grant
 * and resolved the token — and stopped there, so the run sat in
 * `waiting-approval` until somebody made a SECOND call, which the release policy
 * and §10 promise a gateway client does not have to make (triage B-15).
 *
 * The first repair claimed the row and journaled `control.run.resumed`, and
 * both halves of that were wrong. The journal entry's only consumer is an
 * in-process `PubSub` no other journal instance can publish into, so a decision
 * taken anywhere else reached nobody. And `scope: "launched"` is not a process
 * scope — it is a `control_runs` lookup, a durable table every process over one
 * control database shares — so the deciding process took the row from the host
 * that could still drive it.
 *
 * What a decision does now is RECORD the restart. The delegation is durable,
 * `RunSummary.pendingResume` projects it, and the executor hosting the run
 * takes it up and clears it. A composition that hosts the run takes it up in
 * the deciding call itself; one that does not leaves it standing.
 *
 * A denial is the same shape. The ask activity reads its decision from the
 * grant store, and it only reads it when the execution is re-driven, so a
 * denied run that is never resumed never learns it was denied.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import * as ControlExecutor from "../src/ControlExecutor.vibe"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import type { ApprovalTarget, Envelope } from "../src/ControlSchema.vibe"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { durable, type DurableStack, journalBundle } from "./DurableStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const run = <A, E>(
  body: Effect.Effect<A, E, DurableStack>,
  executor?: ControlExecutor.Service | undefined
): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(durable(executor === undefined ? {} : { executor })),
      Effect.scoped,
      Effect.orDie
    )
  )

/**
 * An executor that hosts the run: it claims the row and reports that it is
 * driving, which is what `AgentSession.resumeRun` does after its engine poll
 * confirms the execution is here.
 *
 * It reads the control runtime, so the plane below is composed by hand rather
 * than through `durable({executor})`, which takes a value built before the
 * runtime exists.
 */
const hostingBridge = (taken: Array<string>) =>
  Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.map(ControlRuntime, (runtime) =>
      ControlExecutor.makeNoop({
        resumeRun: Effect.fn("TestExecutor.resumeRun")(({ runId }) =>
          runtime.resume(runId).pipe(
            Effect.tap(() => Effect.sync(() => void taken.push(runId))),
            Effect.as("resuming" as const),
            Effect.orDie
          )
        )
      }))
  )

/** The durable plane with a host behind it, over one in-memory database. */
const hostedPlane = (taken: Array<string>) => {
  // One layer VALUE, so `ControlLive` and the executor bridge share exactly
  // one runtime instance rather than each building its own.
  const runtime = SqlControlRuntime.layer({}).pipe(Layer.orDie)
  return ControlLive.layer.pipe(
    Layer.provide(hostingBridge(taken)),
    Layer.provideMerge(Layer.mergeAll(runtime, NotificationQueue.layer, Registry.layerNoop())),
    Layer.provideMerge(Layer.merge(journalBundle, NodeCrypto.layer))
  )
}

/** Plans, approves, starts, and parks one run on an in-run approval request. */
const parkedOnAsk = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:plan:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    const runId = receipt.runId
    yield* runtime.resume(runId)
    const target: ApprovalTarget = {
      _tag: "Node",
      runId,
      requestId: `ask:${suffix}`,
      digest: "ask-digest",
      envelope
    }
    yield* runtime.registerApproval(target)
    // The park the executor writes when the ask raises `PermissionRequired`.
    const fence = yield* runtime.claimFence(runId)
    yield* runtime.writeStatus(runId, fence, "waiting-approval")
    return { runId, target, fence }
  })

/** Every event type the run's journal carries, in order. */
const kinds = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
    return page.entries.map((entry) => entry.eventType)
  })

describe("deciding an in-run approval nobody here can drive", () => {
  it("records a durable resume delegation and leaves the row where the host parked it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("approved")
      const parked = yield* runtime.getRun(runId)

      const receipt = yield* control.approve({ target, scope: "run", idempotencyKey: "approve:ask" })
      return {
        runId,
        parked,
        receipt,
        after: yield* runtime.getRun(runId),
        pending: yield* runtime.pendingResumes,
        kinds: yield* kinds(runId)
      }
    }))

    expect(observed.parked.status).toBe("waiting-approval")
    expect(observed.parked.pendingResume).toBeUndefined()
    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "approve:ask", runId: observed.runId })
    // The delegation is durable and projected, so a host that starts a minute
    // later — or an operator reading the run — can see a restart is owed.
    expect(observed.pending.map((entry) => entry.runId)).toEqual([observed.runId])
    expect(observed.after.pendingResume).toBe(observed.pending[0]?.sequence)
    // And the row is untouched: this composition drives nothing, so claiming
    // it would strand the run under a fence with no executor behind it.
    expect(observed.after.status).toBe("waiting-approval")
    expect(observed.after.ownerId).toBe(observed.parked.ownerId)
    const approved = observed.kinds.indexOf("control.approval.approved")
    const resumed = observed.kinds.indexOf("control.run.resumed")
    expect(approved).toBeGreaterThanOrEqual(0)
    // Order matters: the decision is the reason for the resume, so a reader
    // walking the journal sees the answer before the restart it caused.
    expect(resumed).toBeGreaterThan(approved)
  })

  it("records the same delegation for a denial, and installs no grant", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("denied")

      yield* control.deny({ target, scope: "run", idempotencyKey: "deny:ask" })
      return {
        runId,
        after: yield* runtime.getRun(runId),
        grants: yield* runtime.grants,
        kinds: yield* kinds(runId)
      }
    }))

    // A denial installs no grant for the request it denied; the resumed
    // attempt reads the resolved token and settles with the refusal.
    expect(observed.grants.map((grant) => grant.tokenId)).not.toContain("ask:denied")
    expect(observed.after.pendingResume).toBeGreaterThan(0)
    const denied = observed.kinds.indexOf("control.approval.denied")
    const resumed = observed.kinds.indexOf("control.run.resumed")
    expect(denied).toBeGreaterThanOrEqual(0)
    expect(resumed).toBeGreaterThan(denied)
  })

  it("records the fence the run was parked under, and clears it when the park ends", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { fence, runId, target } = yield* parkedOnAsk("parked-by")
      const parked = yield* runtime.getRun(runId)
      yield* control.approve({ target, scope: "run", idempotencyKey: "approve:parked-by" })
      const delegated = yield* runtime.getRun(runId)
      return { fence, runId, parked, delegated, claimed: yield* runtime.resume(runId) }
    }))

    // A park releases the owner columns — that is what makes the execution
    // resumable — so the fence it was written under is the only thing left on
    // the row that says which process is hosting it. A second process holding
    // the same control database can read this and tell that the parked run is
    // not its own to take up (triage B-15).
    expect(observed.parked.ownerId).toBeUndefined()
    expect(observed.parked.parkedBy).toBe(observed.fence)
    // Recording a delegation does not end the park, so it does not end the
    // record of who wrote it: the host still has to recognize its own park.
    expect(observed.delegated.parkedBy).toBe(observed.fence)
    // Claiming the run does end it. A running row names its owner outright.
    expect(observed.claimed.parkedBy).toBeUndefined()
    expect(observed.claimed.ownerId).toBeDefined()
  })

  it("leaves a plan-level approval alone: there is no run to resume yet", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: { suite: "plan-level" } })
      yield* control.approve({ ...card.approval, idempotencyKey: "approve:plan-only" })
      return { kinds: yield* kinds(`plan:${card.planId}`), pending: yield* (yield* ControlRuntime).pendingResumes }
    }))

    expect(observed.kinds).toContain("control.approval.approved")
    expect(observed.kinds).not.toContain("control.run.resumed")
    expect(observed.pending).toEqual([])
  })
})

describe("deciding an in-run approval in the composition hosting the run", () => {
  it("takes the resume up inside the deciding call and clears the delegation", async () => {
    const taken: Array<string> = []
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId, target } = yield* parkedOnAsk("hosted")
        yield* control.approve({ target, scope: "run", idempotencyKey: "approve:hosted" })
        return { runId, after: yield* runtime.getRun(runId), pending: yield* runtime.pendingResumes }
      }).pipe(
        Effect.provide(hostedPlane(taken) as Layer.Layer<DurableStack>),
        Effect.scoped,
        Effect.orDie
      )
    )

    // One call, and the run is moving again — under THIS composition's fence,
    // because this composition is the one that answered "I am driving it".
    expect(taken).toEqual([observed.runId])
    expect(observed.after.status).not.toBe("waiting-approval")
    // Taken up means cleared: a delegation that outlived its uptake would be
    // re-driven by every host poll for the rest of the run's life.
    expect(observed.pending).toEqual([])
    expect(observed.after.pendingResume).toBeUndefined()
  })
})

describe("deciding an in-run approval on a run that has already settled", () => {
  it("answers Terminal instead of delegating a resume nothing can take up", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("cancelled-before-decision")
      // The operator cancelled the parked run before answering its ask. This
      // is the release validation's own sequence: `cancel run-4`, then `approve`
      // with the ask payload, which hung for 120 s and printed nothing.
      yield* control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` })

      const receipt = yield* control.approve({ target, scope: "run", idempotencyKey: "approve:settled" })
      return {
        runId,
        receipt,
        after: yield* runtime.getRun(runId),
        pending: yield* runtime.pendingResumes,
        kinds: yield* kinds(runId)
      }
    }))

    // A decision on a settled run decides nothing. `smithers approve` prints
    // this receipt and returns; the `Accepted` it used to print sent the CLI
    // into `awaitRun` for a settlement that had already happened.
    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
    expect(observed.after.status).toBe("cancelled")
    // No delegation either: a standing resume for a cancelled run is a
    // restart every host poll re-reads and no host may take up.
    expect(observed.pending).toEqual([])
    expect(observed.kinds).not.toContain("control.approval.approved")
    expect(observed.kinds).not.toContain("control.run.resumed")
  })

  it("answers Terminal for a repeat rather than replaying the decision's receipt", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("settled-after-decision")
      const key = "approve:settled-repeat"
      const first = yield* control.approve({ target, scope: "run", idempotencyKey: key })
      // The host took the delegation up and ran the flow to its end.
      yield* runtime.resume(runId)
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")
      const again = yield* control.approve({ target, scope: "run", idempotencyKey: key })
      return { runId, first, again }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.again).toEqual({ _tag: "Terminal", runId: observed.runId, status: "completed" })
  })
})
