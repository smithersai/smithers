// Native ClientEngine history failures over a real durable host. Only the failing reader is injected.
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore, RunStore } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Context, Effect, Layer, Metric, Option, Schema } from "effect"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../../worker/ExecutionHost.vibe"
import { build } from "../../worker/test/flowHost.ts"
import { admissionStages } from "../writeAdmission.vibe"
import { ClientEngine, DispatchFailed, makeDispatch } from "./dispatch.vibe"
import { TabRequests } from "./requests.vibe"

const Echo = Flow.make("test/NativeHistory", {
  payload: {}, success: Schema.Null, body: Node.capture({}, () => Node.succeed(null)),
})
const request = () => ({ executionId: crypto.randomUUID(), source: "missing", action: "missing" })
const fault = new RunStore.RunStore.RunStoreError({ code: "persistence_failed", method: "inspect", message: "unavailable", cause: undefined })
const refused = new DispatchFailed({ flow: Echo._tag, reason: "refused", refusal: "persistence_failed" })

test("known and retry publish a typed refusal when the real host's history cannot be read", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { context, engine } = yield* build(Interpreter.layer(Echo).pipe(Layer.provideMerge(Action.layerImplementations)))
    const server = yield* TestDatabase.serverUrl
    const reader = yield* Layer.build(EngineStore.RunInspection.layerWith({ flows: [Echo] }).pipe(
      Layer.provide(ExecutionHost.readDatabase(server.toString(), engine.schema)),
    ))
    const reads = Context.get(reader, EngineStore.RunInspection.RunInspection)
    const broken = { ...reads, inspect: () => Effect.fail(fault) }
    const client = yield* ClientEngine.pipe(Effect.provide(ClientEngine.layerRuntime([Echo]).pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(Layer.succeed(EngineStore.RunInspection.RunInspection, broken)),
    )))
    expect(yield* Effect.flip(client.known(Echo, "missing"))).toEqual(refused)
    expect(yield* Effect.flip(client.retry(Echo, request()))).toEqual(refused)
  }))))

test("a host without inspection or retry support refuses an explicit retry", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { context, engine } = yield* build(Interpreter.layer(Echo).pipe(Layer.provideMerge(Action.layerImplementations)))
    const native = Context.get(context, FlowRuntime.FlowRuntime)
    const noHistory = yield* ClientEngine.pipe(Effect.provide(ClientEngine.layerRuntime([Echo]).pipe(
      Layer.provide(Layer.succeedContext(context)),
    )))
    expect(yield* noHistory.known(Echo, "missing")).toBe(false)
    expect(yield* Effect.flip(noHistory.retry(Echo, request()))).toEqual(new DispatchFailed({ flow: Echo._tag, reason: "refused" }))
    const server = yield* TestDatabase.serverUrl
    const noRetry = yield* ClientEngine.pipe(Effect.provide(ClientEngine.layerRuntime([Echo]).pipe(
      Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, { ...native, retryFrom: undefined })),
      Layer.provide(EngineStore.RunInspection.layerWith({ flows: [Echo] }).pipe(Layer.provide(
        ExecutionHost.readDatabase(server.toString(), engine.schema),
      ))),
    )))
    expect(yield* Effect.flip(noRetry.retry(Echo, request()))).toEqual(new DispatchFailed({ flow: Echo._tag, reason: "refused" }))
  }))))

class RetryNeeded extends Schema.TaggedError<RetryNeeded>()("test/RetryNeeded", {}) {}

const Recover = Action.make("test/recover", {
  payload: {}, success: Schema.String, error: RetryNeeded, tier: "sealed",
})
const Recovery = Flow.make("issue/test-recovery", {
  payload: {}, success: Schema.String, error: RetryNeeded,
  body: Node.capture({ recover: Recover.name }, () => Recover.call({})),
})

test("dispatch retries a failed run from its recorded action and rejoins the successful attempt", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const executions: string[] = []
    const registration = Interpreter.layerWithImplementations(Recovery, Recover.toLayer(() => Effect.gen(function* () {
      const { executionId } = yield* FlowRuntime.FlowInstance
      executions.push(executionId)
      if (executionId === "recovery") return yield* new RetryNeeded()
      return executionId
    })))
    const { context, engine } = yield* build(registration)
    const server = yield* TestDatabase.serverUrl
    const client = ClientEngine.layerRuntime([Recovery]).pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(EngineStore.RunInspection.layerWith({ flows: [Recovery] }).pipe(
        Layer.provide(ExecutionHost.readDatabase(server.toString(), engine.schema)),
      )),
    )
    const clients = yield* Layer.build(client)
    const tabs = yield* Layer.build(TabRequests.layer())
    const dispatch = yield* makeDispatch({ [Recovery._tag]: { flow: Recovery } }).pipe(
      Effect.provide(clients),
      Effect.provide(tabs),
    )
    const options = {
      door: "sync",
      executionId: "recovery",
      retry: { action: Recover.name, when: (ended: { readonly _tag: string }) => ended._tag === "Failed" },
    } as const

    expect(yield* dispatch(Recovery._tag, {}, options)).toEqual({ _tag: "Failed", error: new RetryNeeded() })
    expect(yield* dispatch(Recovery._tag, {}, options)).toEqual({ _tag: "Done", value: "recovery.retry.1" })
    expect(yield* dispatch(Recovery._tag, {}, options)).toEqual({ _tag: "Done", value: "recovery.retry.1" })
    expect(executions).toEqual(["recovery", "recovery.retry.1"])
    expect(yield* Context.get(tabs, TabRequests).doorOf("recovery.retry.1")).toEqual(Option.some("sync"))
    const confirmed = yield* Metric.value(Metric.withAttributes(admissionStages, {
      flow: Recovery._tag,
      stage: "engine",
      outcome: "confirmed",
    }))
    expect(confirmed.count).toBe(3)
  }))))
