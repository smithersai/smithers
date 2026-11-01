/** Public durable model calls, with engine faults injected through its service. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Capability, Permission } from "@smthrs/capability"
import { Crypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness"
import { ModelError, ModelEvent } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ModelStep } from "../src/index.ts"
import * as Internal from "../src/internal/ModelStep.ts"
import { ask, reply, scripted, through } from "./fixtures/model-step-stack.ts"

const probe = Flow.make("agent/test/model-step-public", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(null)
})

const drive = <A, E>(body: Effect.Effect<A, E, ModelStep.Requirements>) =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = yield* Deferred.make<Exit.Exit<A, E>>()
    yield* engine.register(probe, () =>
      body.pipe(
        Effect.onExit((exit) => Deferred.succeed(settled, exit))
      )).pipe(Scope.provide(scope))
    yield* engine.execute(probe, { executionId: "public-model", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.merge(FlowEngine.layerMemory, Crypto.layerFromDigest(NodeCrypto.layerDigest))),
    Effect.scoped,
    Effect.runPromise
  )

const unwrap = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}

describe("ModelStep public boundary", () => {
  it("seals, replays and delivers events with default and explicit policies", async () => {
    const provider = scripted(() => Stream.fromIterable(reply("answer")))
    const seen: Array<ModelEvent.ModelEvent> = []
    const results = unwrap(
      await drive(Effect.gen(function*() {
        const options = { name: "public", request: ask(["question"]), ...through(provider.model) }
        const first = yield* ModelStep.run(options)
        const second = yield* ModelStep.run({
          ...options,
          retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 }),
          heartbeatTimeoutMs: 12_345,
          onEvent: (event) => Effect.sync(() => void seen.push(event))
        })
        const third = yield* ModelStep.run(options)
        return [first, second, third]
      }))
    )
    expect(results.map((result) => result.replayed)).toEqual([false, true, true])
    expect(results.map((result) => result.events)).toEqual([reply("answer"), reply("answer"), reply("answer")])
    expect(seen).toEqual(reply("answer"))
    expect(provider.calls).toHaveLength(1)
  })

  it.each([undefined, "test-provider"])("wraps successful streams and providerName %s", async (providerName) => {
    const provider = scripted(() => Stream.fromIterable(reply("answer")))
    const events = unwrap(
      await drive(Effect.gen(function*() {
        const wrapped = yield* ModelStep.model({
          name: "wrapped",
          ...through({ ...provider.model, ...(providerName === undefined ? {} : { providerName }) })
        })
        expect(wrapped.providerName).toBe(providerName)
        return yield* Stream.runCollect(wrapped.stream(ask(["question"])))
      }))
    )
    expect(events).toEqual(reply("answer"))
    expect(provider.calls).toHaveLength(1)
  })

  it("delivers recorded events before a sealed refusal and replays the refusal", async () => {
    const error = new ModelError.ModelError({ code: "invalid_request", message: "refused" })
    const events = reply("partial").slice(0, 4)
    const provider = scripted(() => Stream.concat(Stream.fromIterable(events), Stream.fail(error)))
    const seen: Array<ModelEvent.ModelEvent> = []
    const result = unwrap(
      await drive(Effect.gen(function*() {
        const options = { name: "refused", request: ask(["question"]), ...through(provider.model) }
        const first = yield* ModelStep.run(options)
        const wrapped = yield* ModelStep.model(options)
        const failure = yield* Stream.runForEach(
          wrapped.stream(options.request),
          (event) => Effect.sync(() => void seen.push(event))
        ).pipe(Effect.exit)
        return { first, failure }
      }))
    )
    expect(result.first.error).toMatchObject({ code: "invalid_request" })
    expect(seen).toEqual(result.first.events)
    expect(seen).toEqual([ModelEvent.ModelEvent.Usage({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })])
    expect(Exit.isFailure(result.failure)).toBe(true)
    if (Exit.isFailure(result.failure)) {
      expect(Cause.squash(result.failure.cause)).toMatchObject({ code: "invalid_request" })
    }
    expect(provider.calls).toHaveLength(1)
  })

  it.each(["harness", "provider"])("converts %s failures at the stream boundary", async (kind) => {
    const provider = scripted(() => Stream.empty)
    const route = through(provider.model).route
    const failure = kind === "provider"
      ? new ModelError.ModelError({ code: "invalid_request", message: "bad route" })
      : undefined
    const result = await drive(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const injected = FlowRuntime.FlowRuntime.of({
        ...engine,
        actionExecute: (action, attempt) =>
          engine.actionExecute({
            ...action,
            executeEncoded: Effect.fail(
              new HarnessError.HarnessError({ code: "engine_failed", message: "injected engine failure" })
            )
          }, attempt)
      })
      const wrapped = yield* ModelStep.model({
        name: "bad-key",
        model: provider.model,
        route: { prepare: (request) => failure === undefined ? route.prepare(request) : Effect.fail(failure) },
        retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
      }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, injected))
      return yield* Stream.runCollect(wrapped.stream(ask(["question"])))
    }))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({ code: kind === "provider" ? "invalid_request" : "unknown" })
    }
    expect(provider.calls).toHaveLength(0)
  })

  it("preserves a host permission refusal without retrying the provider", async () => {
    const denied = new Permission.PermissionDenied({
      capability: Capability.make("net:post", "https://provider.invalid"),
      reason: "host refused"
    })
    const provider = scripted(() => Stream.fail(denied))
    const result = await drive(
      ModelStep.run({ name: "denied", request: ask(["question"]), ...through(provider.model) })
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({ _tag: denied._tag, reason: "host refused" })
    }
    expect(provider.calls).toHaveLength(1)
  })

  it.each([false, true])("announces an injected redispatch (listener %s)", async (listen) => {
    const provider = scripted(() => Stream.fromIterable(reply("answer")))
    const seen: Array<ModelEvent.ModelEvent> = []
    unwrap(
      await drive(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const injected = FlowRuntime.FlowRuntime.of({
          ...engine,
          actionExecute: (action, attempt) =>
            engine.actionExecute({
              ...action,
              executeEncoded: action.executeEncoded.pipe(Effect.provideService(Action.CurrentRedispatch, true))
            }, attempt)
        })
        return yield* ModelStep.run({
          name: "redispatched",
          request: ask(["question"]),
          ...through(provider.model),
          ...(listen
            ? { onEvent: (event: ModelEvent.ModelEvent) => Effect.sync(() => void seen.push(event)) }
            : {})
        }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, injected))
      }))
    )
    expect(provider.calls).toHaveLength(1)
    expect(seen).toEqual(
      listen
        ? [expect.objectContaining({ type: "retry", code: "interrupted", delayMillis: 0 }), ...reply("answer")]
        : []
    )
  })

  it.each([undefined, 429])("announces failed attempts with HTTP status %s", async (httpStatus) => {
    const provider = scripted((call) =>
      call === 1
        ? Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "busy", httpStatus }))
        : Stream.fromIterable(reply("answer"))
    )
    const seen: Array<ModelEvent.ModelEvent> = []
    unwrap(
      await drive(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        // Inject a failed execution followed by another attempt at the runtime seam.
        const injected = FlowRuntime.FlowRuntime.of({
          ...engine,
          actionExecute: (action, attempt) =>
            engine.actionExecute({
              ...action,
              executeEncoded: Effect.andThen(Effect.exit(action.executeEncoded), action.executeEncoded)
            }, attempt)
        })
        return yield* Internal.dispatch({
          name: "retried",
          key: "retry-key",
          request: ask(["question"]),
          model: provider.model,
          retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 }),
          onEvent: (event) => Effect.sync(() => void seen.push(event))
        }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, injected))
      }))
    )
    expect(provider.calls).toHaveLength(2)
    expect(seen[0]).toMatchObject({ type: "retry", code: "rate_limited", elapsedMs: expect.any(Number) })
    expect(seen[0]?.type === "retry" ? seen[0].httpStatus : "wrong event").toBe(httpStatus)
    expect(seen.slice(1)).toEqual(reply("answer"))
  })
})
