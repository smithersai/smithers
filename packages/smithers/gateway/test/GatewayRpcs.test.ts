/**
 * The gateway's own remote procedures, against a real SQLite control plane.
 *
 * The remaining three requirements the old `packages/server` suite pinned live
 * here:
 *
 * - `server-resume-lifecycle`: approving a parked node resumes the run it
 *   parked, in ONE call. A product client never issues a second manual resume,
 *   because a lost second call is exactly the state a human reads as "I
 *   approved it and nothing happened".
 * - `index-run-lifecycle-coverage`: a launch that succeeds and a launch that
 *   fails both leave a readable run, not a hole.
 * - `xcombo-child-visibility-gateway`: a child run of a listed parent is
 *   itself listed, carrying the parent it came from.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import { Control } from "@smthrs/control/Control"
import type { Service as ControlService } from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import { PersistenceError, TransportError, Unavailable } from "@smthrs/control/ControlError"
import { ControlRpcs, layerNoopAuth } from "@smthrs/control/ControlRpcs"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, ApprovalTarget, PlanCard } from "@smthrs/control/ControlSchema"
import { RunStore } from "@smthrs/run-store"
import { Effect, Fiber, Layer, Schema, type Scope, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import type * as GatewayProjection from "../src/GatewayProjection.ts"
import { GatewayRpcs, SubmitApprovalOutput } from "../src/GatewayRpcs.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import { Projections } from "../src/Projections.ts"
import type { Service as ProjectionsService } from "../src/Projections.ts"
import { driverFence, emit, stack } from "./GatewayStack.ts"

const principal = { id: "gateway-test", kind: "test", stampedAt: 1 }

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

const launch = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
  return receipt.runId
})

/** The gateway's handlers over the real stack, reachable as an RPC client. */
const served = Layer.merge(GatewayServer.layerHandlers, layerNoopAuth(principal)).pipe(
  Layer.provideMerge(stack({
    approvalAuthority: Effect.runSync(ApprovalAuthority.make([
      {
        principal: { id: "local", kind: "operator" },
        scopes: ["once", "run", "remembered"],
        targets: ["Plan", "Node"]
      },
      {
        principal: { id: principal.id, kind: principal.kind },
        scopes: ["once", "run", "remembered"],
        targets: ["Plan", "Node"]
      }
    ]))
  }))
)

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

/**
 * The names of the `ControlError` members a procedure declares, read from its
 * error union by schema identity. Each member is the very class schema
 * `@smthrs/control` exports, so identity, not a decoded sample, names it.
 */
const declaredFailures = (name: "Approve" | "Deny" | "Approval.Submit"): ReadonlyArray<string> => {
  const byAst = new Map<unknown, string>(
    Object.entries(ControlError).flatMap(([exported, value]) =>
      typeof value === "function" && "ast" in value ? [[value.ast, exported] as const] : []
    )
  )
  const rpc = name === "Approval.Submit" ? GatewayRpcs.requests.get(name)! : ControlRpcs.requests.get(name)!
  const union = rpc.errorSchema.ast as { readonly _tag: string; readonly types?: ReadonlyArray<object> }
  expect(union._tag).toBe("Union")
  return (union.types ?? []).map((member) => byAst.get(member) ?? "<not a ControlError>")
}

/**
 * The gateway handlers over a `Control` whose decision commands answer with
 * one chosen failure: the way to reach the failures a healthy SQLite control
 * plane never raises from `approve` or `deny`.
 */
const servedOver = (control: Partial<ControlService>) =>
  Layer.merge(GatewayServer.layerHandlers, layerNoopAuth(principal)).pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(Control)(control as ControlService),
      Layer.succeed(Projections)({} as ProjectionsService)
    ))
  )

const submitNothing = {
  target: {
    _tag: "Plan" as const,
    planId: "stubbed-plan",
    digest: "stubbed-digest",
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  scope: "run" as const,
  idempotencyKey: "stubbed",
  decision: "approve" as const
}

describe("Approval.Submit", () => {
  it("round-trips the transport failure raised by a remote approval adapter", () => {
    const rpc = GatewayRpcs.requests.get("Approval.Submit")!
    const error = new TransportError({ message: "Approval transport unavailable", retryable: true })
    const encoded = Schema.encodeSync(rpc.errorSchema)(error)
    expect(Schema.decodeUnknownSync(rpc.errorSchema)(JSON.parse(JSON.stringify(encoded))))
      .toMatchObject({
        _tag: "/control/TransportError",
        code: "transport_error",
        retryable: true,
        message: error.message
      })
  })

  test("delegates one durable resume when a parked node is approved", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      const target: ApprovalTarget = {
        _tag: "Node",
        runId,
        requestId: "gate",
        digest: "gate-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      }
      // The run registers its gate and parks on it exactly as
      // `AgentSession.authorize` and `AgentSession.settle` do: the ask is
      // registered, then the run's status is moved under its own fence.
      yield* runtime.registerApproval(target)
      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "approve:gate",
        decision: "approve"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      const encoded = Schema.encodeUnknownSync(SubmitApprovalOutput)(submitted)
      expect(Object.keys(encoded)).toEqual(["decision"])
      expect(encoded).toEqual({ decision: submitted.decision })
      // This fixture's executor owns no engine row. Control therefore leaves
      // the row parked and records a durable delegation for its real host.
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")
      expect((yield* runtime.pendingResumes).map((entry) => entry.runId)).toEqual([runId])
      const events = yield* Stream.runCollect(
        (yield* Control).watch({ runId, follow: false })
      )
      const kinds = events.map((event) => event.kind)
      expect(kinds.filter((kind) => kind === "control.run.resumed")).toHaveLength(1)
      expect(kinds).not.toContain("control.run.resume")
      const summary = (yield* (yield* Projections).snapshot({ _tag: "run-summary", runId }))
        .rows[0]
      const resumed = yield* runtime.getRun(runId)
      expect(summary?.status).toBe(resumed.status)
      expect(summary?.verdict).toContain(resumed.status)
    }).pipe(Effect.provide(served)))

  test("delegates one durable resume when a gate is denied", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      const target: ApprovalTarget = {
        _tag: "Node",
        runId,
        requestId: "denied-gate",
        digest: "denied-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      }
      yield* runtime.registerApproval(target)
      const fence = yield* driverFence(runId)
      yield* runtime.writeStatus(runId, fence, "waiting-approval")

      const submitted = yield* rpc["Approval.Submit"]({
        target,
        scope: "run",
        idempotencyKey: "deny:gate",
        decision: "deny"
      })

      expect(submitted.decision._tag).toBe("Accepted")
      expect((yield* runtime.getRun(runId)).status).toBe("waiting-approval")
      expect((yield* runtime.pendingResumes).map((entry) => entry.runId)).toEqual([runId])
      const events = yield* Stream.runCollect((yield* Control).watch({ runId, follow: false }))
      expect(events.map((event) => event.kind).filter((kind) => kind === "control.run.resumed"))
        .toHaveLength(1)
    }).pipe(Effect.provide(served)))

  test("approves a plan without a run to resume", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const submitted = yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `approve:${card.planId}`,
        decision: "approve"
      })

      expect(submitted.decision._tag).toBe("Accepted")
    }).pipe(Effect.provide(served)))

  /**
   * `Approval.Submit` is a control mutation wearing a gateway payload, and the
   * decision it records is the one an operator is answerable for. The
   * composition here defaults to `local`/`operator` and the middleware
   * authenticates `gateway-test`, so a handler that never read
   * `ControlPrincipal` writes the wrong name into the journal.
   */
  test("journals the authenticated principal rather than the runtime's default", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `attributed:${card.planId}`,
        decision: "approve"
      })

      const events = yield* Stream.runCollect(control.watch({ runId: `plan:${card.planId}`, follow: false }))
      const decided = events.find((event) => event.kind === "control.approval.approved")
      expect((decided?.payload as { readonly principal?: unknown } | null)?.principal)
        .toMatchObject({ id: "gateway-test", kind: "test" })
    }).pipe(Effect.provide(served)))

  test("denies a plan, which has no run to resume either way", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const submitted = yield* rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `deny:${card.planId}`,
        decision: "deny"
      })

      expect(submitted.decision._tag).toBe("Accepted")
    }).pipe(Effect.provide(served)))

  /**
   * The typed failures the mount declares, produced over the wire rather than
   * asserted from the schema. A client writes one recovery per tag, so a tag
   * the mount cannot actually produce is a branch nobody's code will ever
   * reach, and a tag it produces as a defect is a branch nobody can catch.
   */
  test("answers a plan digest that does not match with PlanDigestMismatch", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: "not-the-digest", envelope: card.envelope },
        scope: "run",
        idempotencyKey: `mismatch:${card.planId}`,
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/PlanDigestMismatch")
    }).pipe(Effect.provide(served)))

  test("answers a second decision on the same gate with AlreadyResolved", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      const target: ApprovalTarget = {
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope
      }

      yield* rpc["Approval.Submit"]({ target, scope: "run", idempotencyKey: "first", decision: "approve" })
      // A different idempotency key makes this a new command rather than a
      // replay of the accepted one, so the gate itself has to refuse it.
      const failure = yield* Effect.flip(
        rpc["Approval.Submit"]({ target, scope: "run", idempotencyKey: "second", decision: "deny" })
      )
      expect(failure._tag).toBe("/control/AlreadyResolved")
    }).pipe(Effect.provide(served)))

  test("answers a decision for a run that does not exist with RunNotFound", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: {
          _tag: "Node",
          runId: "no-such-run",
          requestId: "gate",
          digest: "gate-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "run",
        idempotencyKey: "missing-run",
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/RunNotFound")
    }).pipe(Effect.provide(served)))

  test("answers a decision for a plan that does not exist with PlanNotFound", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: {
          _tag: "Plan",
          planId: "no-such-plan",
          digest: "plan-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "run",
        idempotencyKey: "missing-plan",
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/PlanNotFound")
    }).pipe(Effect.provide(served)))

  test("answers a gate submitted under a different envelope with EnvelopeMismatch", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runtime = yield* ControlRuntime
      const runId = yield* launch
      const registered: ApprovalTarget = {
        _tag: "Node",
        runId,
        requestId: "envelope-gate",
        digest: "envelope-digest",
        envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
      }
      yield* runtime.registerApproval(registered)

      // A client that widens the envelope it was shown is approving something
      // the run never asked for, so the stored envelope, not the submitted
      // one, is the one that counts.
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: { ...registered, envelope: { capabilities: ["model:call", "fs:write"], flows: ["ask"], budget: {} } },
        scope: "run",
        idempotencyKey: "approve:envelope-gate",
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/EnvelopeMismatch")
    }).pipe(Effect.provide(served)))

  test("answers a payload the control plane refuses with InvalidInput", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })

      // The wire schema types the key as a string; the 1024-character bound is
      // Control's mutation boundary, so the refusal arrives as its typed error.
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({
        target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: "k".repeat(1025),
        decision: "approve"
      }))
      expect(failure._tag).toBe("/control/InvalidInput")
      expect((failure as { readonly issue?: string }).issue).toContain("idempotencyKey")
    }).pipe(Effect.provide(served)))

  test("answers a decision the control plane could not record with PersistenceError", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"](submitNothing))
      expect(failure).toMatchObject({
        _tag: "/control/PersistenceError",
        code: "persistence_failed",
        operation: "record an approval"
      })
    }).pipe(Effect.provide(servedOver({
      approve: () =>
        Effect.fail(new PersistenceError({ operation: "record an approval", message: "journal is read-only" }))
    }))))

  test("answers a decision the control plane does not serve with Unavailable", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(rpc["Approval.Submit"]({ ...submitNothing, decision: "deny" }))
      expect(failure).toMatchObject({ _tag: "/control/Unavailable", code: "unavailable", feature: "deny" })
    }).pipe(Effect.provide(servedOver({
      deny: () => Effect.fail(new Unavailable({ feature: "deny", ticket: "T-approvals" }))
    }))))

  /**
   * The handler adds no failure of its own, so the mount's union has to be the
   * one `Approve` and `Deny` declare, member for member and without repeats:
   * a member listed twice reads as two recovery branches to a client that
   * generates its handlers from the schema.
   */
  it("declares exactly the failures ControlRpcs declares for Approve and Deny, once each", () => {
    const submit = declaredFailures("Approval.Submit")
    expect(new Set(submit).size).toBe(submit.length)
    expect([...submit].sort()).toEqual([...declaredFailures("Approve")].sort())
    expect([...submit].sort()).toEqual([...declaredFailures("Deny")].sort())
    expect(submit).toContain("Unauthorized")
  })
})

describe("Projection.Snapshot and Projection.Subscribe", () => {
  test("answers a snapshot with the rows and the cursor they were read at", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const snapshot = yield* rpc["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId } })
      expect(snapshot.cursor).toMatchObject({ projection: "run-summary", runId })
      expect(snapshot.rows).toHaveLength(1)
    }).pipe(Effect.provide(served)))

  test("streams a subscription's snapshot frames through the RPC group", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const frames = yield* Stream.runCollect(
        Stream.take(rpc["Projection.Subscribe"]({ selector: { _tag: "run-summary", runId } }), 3)
      )
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "row", "snapshot-end"])
    }).pipe(Effect.provide(served)))

  test("passes a resume cursor through the subscription handler", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const runId = yield* launch
      const selector = { _tag: "run-events" as const, runId }
      const snapshot = yield* rpc["Projection.Snapshot"]({ selector })
      // A resumed subscription sends no snapshot frames, so the keepalive
      // channel is the only other thing on the stream: filter to the deltas.
      const following = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(
            Stream.filter(
              rpc["Projection.Subscribe"]({ selector, after: snapshot.cursor }),
              (frame) => frame._tag === "delta"
            ),
            1
          )
        )
      )
      yield* Effect.sleep("100 millis")
      yield* emit(runId, "control.run.completed", { runId, status: "completed" })
      const frames = yield* Fiber.join(following)

      expect(frames.map((frame) => frame._tag)).toEqual(["delta"])
      expect(frames[0]?._tag === "delta" && frames[0].cursor.value).toBeGreaterThan(snapshot.cursor.value)
    }).pipe(Effect.provide(served)))

  test("refuses a projection of an unknown run with a typed gateway error", () =>
    Effect.gen(function*() {
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const failure = yield* Effect.flip(
        rpc["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId: "nope" } })
      )
      // A run the control plane does not have is not a backend failure, and a
      // client decides whether to retry on the difference.
      expect(failure.code).toBe("run_not_found")
    }).pipe(Effect.provide(served)))
})

describe("run visibility", () => {
  test("lists a child run beside the parent it came from", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runs = yield* RunStore.RunStore
      const parentRunId = yield* launch
      // A child run is a run the engine created under a parent. Whatever
      // created it, the ordinary listing every run surface renders must show
      // it. A child that only a debug escape hatch can see is a child a human
      // cannot reach.
      //
      // The state the child is created with is an ENGINE-owned state, so it
      // carries the flow name every engine row carries
      // (`@smthrs/engine-store` `DurableEngineState`). `@smthrs/control`
      // decodes that column before it projects the row, so a placeholder `{}`
      // would fail the listing rather than exercise the listing.
      yield* runs.create(`${parentRunId}:child`, JSON.stringify({ flowName: "system/test" }), { parentRunId })

      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows
      const child = rows.find((row) => row.runId === `${parentRunId}:child`)
      expect(rows.map((row) => row.runId)).toContain(parentRunId)
      expect(child).toBeDefined()
      expect(child?.parentRunId).toBe(parentRunId)
    }).pipe(Effect.provide(served)))

  test("keeps a run readable after a launch the executor refused", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const runId = yield* launch
      // The noop executor takes nothing, so the run stays pending rather than
      // running. It is still a run, still listed, and still diagnosable. A
      // refused launch must not leave a hole where a run should be.
      const rows = (yield* projections.snapshot({ _tag: "run-summary", runId })).rows
      expect(rows[0]?.runId).toBe(runId)
      expect(rows[0]?.diagnosis).toContain("Verdict")
    }).pipe(Effect.provide(served)))
})
