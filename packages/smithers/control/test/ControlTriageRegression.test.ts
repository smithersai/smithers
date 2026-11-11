import { NodeCrypto } from "@effect/platform-node"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import { PersistenceError, PlanDenied, Unauthorized } from "../src/ControlError.ts"
import * as Runtime from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { durable, journalBundle } from "./DurableStack.ts"

const engineBundle = EngineMigrations.layer.pipe(Layer.provideMerge(journalBundle))

const principal = { id: "local", kind: "operator", stampedAt: 1 }
const envelope = { capabilities: [], flows: [], budget: {} }

it("has no ambient run identity outside an executing action", async () => {
  expect(await Effect.runPromise(Runtime.CurrentRunId)).toBeUndefined()
})

it("scoped delegations require trusted flow identity and the exact human wait", async () => {
  const entry = {
    principal,
    scopes: ["once" as const],
    targets: ["Plan" as const, "Node" as const],
    flowId: "allowed",
    waitName: "ask"
  }
  // Configuration carries identity only, never the principal clock.
  const delegation = { ...entry, principal: { id: principal.id, kind: principal.kind } }
  const policy = await Effect.runPromise(ApprovalAuthority.make([delegation]))
  const request: ApprovalAuthority.Request = {
    principal,
    target: { _tag: "Node", runId: "run", requestId: "ask", digest: "token", envelope },
    decision: "approved",
    scope: "once"
  }
  for (const flowId of [undefined, "other"]) {
    expect((await Effect.runPromise(Effect.flip(policy.authorize(request, { flowId: Effect.succeed(flowId) }))))._tag)
      .toBe("/control/Unauthorized")
  }
  expect((await Effect.runPromise(Effect.flip(policy.authorize(request))))._tag).toBe("/control/Unauthorized")
  await Effect.runPromise(policy.authorize(request, { flowId: Effect.succeed("allowed") }))
  for (
    const target of [
      { _tag: "Node", runId: "run", requestId: "other", digest: "token", envelope },
      { _tag: "Plan", planId: "plan", digest: "token", envelope }
    ] as const
  ) {
    await expect(Effect.runPromise(policy.authorize(
      { ...request, target },
      { flowId: Effect.succeed("allowed") }
    ))).rejects.toMatchObject({ _tag: "/control/Unauthorized" })
  }
  const proof = await Effect.runPromise(
    ApprovalAuthority.make([{ ...delegation, flowId: undefined, requiredProof: "passkey" }])
  )
  expect((await Effect.runPromise(Effect.flip(proof.authorize(request))))._tag).toBe("/control/Unauthorized")
  let valid = true
  const verified = await Effect.runPromise(ApprovalAuthority.make([{ ...delegation, requiredProof: "passkey" }], {
    verifyProof: (name, target) =>
      Effect.suspend(() => {
        expect(name).toBe("passkey")
        expect(target.target).toEqual(request.target)
        return valid ? Effect.void : Effect.fail(new Unauthorized({ message: "revoked" }))
      })
  }))
  await Effect.runPromise(verified.authorize(request, { flowId: Effect.succeed("allowed") }))
  valid = false
  expect(
    (await Effect.runPromise(Effect.flip(verified.authorize(request, { flowId: Effect.succeed("allowed") }))))._tag
  ).toBe("/control/Unauthorized")
  const unavailable = await Effect.runPromise(Effect.flip(policy.authorize(request, {
    flowId: Effect.fail(new PersistenceError({ operation: "target", message: "offline" }))
  })))
  expect(unavailable._tag).toBe("/control/PersistenceError")
})

it.each(["memory", "sql"] as const)("pages bounded signal metadata in %s", async (adapter) => {
  const layer = adapter === "memory"
    ? Runtime.layerMemory({ approvalAuthority: ApprovalAuthority.local })
    : durable({ database: engineBundle })
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* Runtime.ControlRuntime
      const launch = Effect.gen(function*() {
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        yield* runtime.resolveApproval(
          yield* runtime.lookupApproval(card.approval.target),
          "approved",
          principal,
          "once"
        )
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") throw new Error("expected launch")
        return launched.run.runId
      })
      const runId = yield* launch
      const other = yield* launch
      yield* runtime.admitSignal("other", other, { name: "other", payload: null }, principal)
      const commandId = Runtime.signalCommandId("public-id", principal)
      yield* runtime.admitSignal(commandId, runId, { name: "wait", payload: { private: "answer" } }, principal)
      yield* runtime.admitSignal("second", runId, { name: "second", payload: null }, principal)
      yield* runtime.settleSignal("second", "rejected", "unauthorized")
      const first = yield* runtime.querySignals({ runId, limit: 1 })
      expect(first.items).toMatchObject([{ commandId, receiptId: "public-id", state: "pending" }])
      expect(JSON.stringify(first)).not.toContain("answer")
      expect(first.next).toEqual(expect.any(Number))
      const next = yield* runtime.querySignals({ runId, limit: 1, after: first.next })
      expect(next.items).toMatchObject([{ commandId: "second", receiptId: "second", rejection: "unauthorized" }])
      expect(next.next).toBeUndefined()
      expect((yield* runtime.querySignals({ runId, limit: 2, commandId })).items).toHaveLength(1)
      expect((yield* runtime.querySignals({ runId, limit: 2, commandId: "absent" })).items).toEqual([])
      for (const after of [-1, 0.5, Number.NaN]) {
        expect((yield* Effect.flip(runtime.querySignals({ runId, limit: 1, after })))._tag).toBe(
          "/control/InvalidInput"
        )
      }
      expect((yield* Effect.flip(runtime.querySignals({ runId, limit: 0 })))._tag).toBe("/control/InvalidInput")
    }).pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer), Effect.scoped)
  )
})

it("checks the captured host admission policy before writing a run", async () => {
  let allow = false
  const options: SqlControlRuntime.Options = {
    authorizeLaunch: (card) =>
      Effect.suspend(() => allow ? Effect.void : Effect.fail(new PlanDenied({ planId: card.planId })))
  }
  const acquire = SqlControlRuntime.make(options)
  Object.assign(options, { authorizeLaunch: undefined })
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* acquire
      const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
      yield* runtime.resolveApproval(yield* runtime.lookupApproval(card.approval.target), "approved", principal)
      expect((yield* Effect.flip(runtime.launch(card.planId, card.digest, card.envelope)))._tag).toBe(
        "/control/PlanDenied"
      )
      expect((yield* runtime.queryRuns({ limit: 1 })).items).toEqual([])
      allow = true
      expect((yield* runtime.launch(card.planId, card.digest, card.envelope))._tag).toBe("Started")
    }).pipe(Effect.provide(Layer.merge(engineBundle, NodeCrypto.layer)), Effect.scoped)
  )
})

it.each(["memory", "sql"] as const)(
  "resolves scoped plan and wait authority from durable identity in %s",
  async (adapter) => {
    const policy = await Effect.runPromise(ApprovalAuthority.make([{
      principal: { id: principal.id, kind: principal.kind },
      scopes: ["once"],
      targets: ["Plan", "Node"],
      flowId: "system/test"
    }]))
    const layer = adapter === "memory"
      ? Runtime.layerMemory({ approvalAuthority: policy })
      : durable({ approvalAuthority: policy, database: engineBundle })
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Runtime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const other = yield* runtime.plan({ flowId: "system/target", input: {} })
        const authorize = (target: ApprovalAuthority.Request["target"]) =>
          runtime.authorizeApproval({
            principal,
            target,
            decision: "approved",
            scope: "once"
          })
        yield* authorize(card.approval.target)
        expect((yield* Effect.flip(authorize(other.card.approval.target)))._tag).toBe("/control/Unauthorized")
        expect((yield* Effect.flip(authorize({ ...card.approval.target, _tag: "Plan", planId: "missing" })))._tag)
          .toBe("/control/Unauthorized")
        yield* runtime.resolveApproval(yield* runtime.lookupApproval(card.approval.target), "approved", principal)
        const launch = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launch._tag !== "Started") throw new Error("expected launch")
        expect(
          (yield* runtime.queryRuns({ limit: 1, filters: { runIds: [launch.run.runId] } })).items.map((run) =>
            run.runId
          )
        )
          .toEqual([launch.run.runId])
        yield* authorize({ _tag: "Node", runId: launch.run.runId, requestId: "ask", digest: "wait", envelope })
        expect(
          (yield* Effect.flip(
            authorize({ _tag: "Node", runId: "missing", requestId: "ask", digest: "wait", envelope })
          ))._tag
        )
          .toBe("/control/Unauthorized")
      }).pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer), Effect.scoped)
    )
  }
)
