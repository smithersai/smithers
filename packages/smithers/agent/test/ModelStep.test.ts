/**
 * `ModelStep` on the real engine over the compose Postgres, with a scripted
 * model that counts its calls: the key, replay, retry, liveness and streaming
 * contract the module states, the process boundaries a run crosses, and the
 * telemetry a step may emit.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Capability, Permission } from "@smthrs/capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Model, ModelError, ModelEvent, ModelProxy, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Logger as StructuredLogger } from "@smthrs/observability"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import * as http from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import * as InternalModelStep from "../src/internal/ModelStep.ts"
import * as ModelStep from "../src/ModelStep.ts"
import {
  ask,
  dropSchema,
  execute,
  type Handler,
  postgres,
  Probe,
  reply,
  runtime,
  scratchSchema,
  scripted,
  textOf,
  through
} from "./fixtures/model-step-stack.ts"

const reachable = await new Promise<boolean>((resolve) => {
  const socket = connect(postgres.port, postgres.host)
  socket.once("connect", () => {
    socket.destroy()
    resolve(true)
  })
  socket.once("error", () => resolve(false))
})
if (!reachable) {
  console.warn(
    `ModelStep engine cases skipped: nothing listens on ${postgres.host}:${postgres.port}. ` +
      "Start the Postgres in apps/mvp/docker-compose.yml."
  )
}
const withPostgres = describe.skipIf(!reachable)

const fixture = fileURLToPath(new URL("./fixtures/model-step-child.ts", import.meta.url))
const childEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }

const step = "agent/test/model-step/answer"

/** A fast policy: the cases that use it are about what is retried, not when. */
const quickly = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })

const rateLimited = (message = "Too many requests") =>
  new ModelError.ModelError({ code: "rate_limited", httpStatus: 429, message })

/** Waits a real moment, so I/O can progress while a case polls a condition. */
const liveWait = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))

/** Polls a condition, failing the case if it never holds. */
const until = (condition: () => boolean, label: string) =>
  Effect.gen(function*() {
    for (let poll = 0; poll < 15_000 && !condition(); poll++) yield* liveWait
    if (!condition()) return yield* Effect.die(new Error(`${label} never happened`))
  })

/** Advances the test clock in `step` increments until `condition` holds. */
const advanceUntil = (condition: () => boolean, step: number, label: string) =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 2_000 && !condition(); turn++) {
      yield* TestClock.adjust(step)
      yield* liveWait
    }
    if (!condition()) return yield* Effect.die(new Error(`${label} never happened`))
  })

/** The execution's result once it reaches `tag`. */
const reach = (executionId: string, tag: "Suspended" | "Complete") =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    for (let poll = 0; poll < 15_000; poll++) {
      const polled = yield* engine.poll(Probe, executionId).pipe(Effect.option, Effect.map(Option.flatten))
      if (Option.isSome(polled) && polled.value._tag === tag) return polled.value
      yield* liveWait
    }
    return yield* Effect.die(new Error(`${executionId} never reached ${tag}`))
  })

/** Runs `executionId` until its body parks once, resumes it, and returns its value. */
const parkThenResume = (executionId: string, prompt: string) =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    yield* engine.execute(Probe, { executionId, payload: { prompt }, discard: true })
    yield* reach(executionId, "Suspended")
    yield* engine.resume(Probe, executionId)
    const settled = yield* reach(executionId, "Complete")
    return yield* (settled as Flow.Complete<unknown, unknown>).exit
  })

/** Parks the running execution the first time a body reaches it. */
const parkOnce = () => {
  let parked = false
  return Effect.gen(function*() {
    if (parked) return
    parked = true
    return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
  })
}

const cases = new Set<{ readonly schema: string; readonly root: string }>()

/** A scratch schema and workspace root, removed after the case. */
const scratch = () => {
  const made = { schema: scratchSchema(), root: mkdtempSync(join(tmpdir(), "model-step-")) }
  cases.add(made)
  return made
}

afterEach(async () => {
  for (const made of cases) {
    await Effect.runPromise(dropSchema(made.schema, made.root))
    await rm(made.root, { recursive: true, force: true })
  }
  cases.clear()
})

/** One host process over `place`, running `program` against it. */
const host = <A, E>(
  place: { readonly schema: string; readonly root: string },
  handler: Handler,
  program: Effect.Effect<A, E, FlowRuntime.FlowRuntime>
) =>
  program.pipe(
    Effect.provide(runtime({ schema: place.schema, workspaceRoot: place.root, hostId: "model-step-suite", handler })),
    Effect.scoped
  )

/** One in-memory engine, with no run lease, running `program` against it. */
const memory = <A, E>(handler: Handler, program: Effect.Effect<A, E, FlowRuntime.FlowRuntime>) =>
  program.pipe(
    Effect.provide(
      Layer.effectDiscard(Effect.flatMap(FlowRuntime.FlowRuntime, (engine) => engine.register(Probe, handler))).pipe(
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    ),
    Effect.scoped
  )

/** A request whose only tool's JSON schema, and the request itself, list their keys in `order`. */
const withTool = (order: "forward" | "reverse"): ModelRequest.ModelRequest => {
  const parameters = order === "forward"
    ? { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
    : { required: ["city"], properties: { city: { type: "string" } }, type: "object" }
  const tool = ModelRequest.ToolDefinition.make({ name: "lookup", description: "Look a city up.", parameters })
  const base = ask(["capital of France"])
  return order === "forward"
    ? ModelRequest.ModelRequest.make({
      modelId: base.modelId,
      system: base.system,
      messages: base.messages,
      tools: [tool],
      params: base.params
    })
    : ModelRequest.ModelRequest.make({
      params: base.params,
      tools: [tool],
      messages: base.messages,
      system: base.system,
      modelId: base.modelId
    })
}

/** Reverses the key order of every object in a JSON value. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]))
    : value

const silent = scripted(() => Stream.empty).model

const keyOf = (request: ModelRequest.ModelRequest, options?: Parameters<typeof through>[1]) =>
  Effect.runPromise(
    Effect.flatMap(
      through(silent, options).route.prepare(request),
      (prepared) => InternalModelStep.key(InternalModelStep.material(request), prepared)
    )
  )

describe("ModelStep keys", () => {
  it("digests what the provider is sent and never the credential", async () => {
    const key = await keyOf(withTool("forward"))
    expect(await keyOf(withTool("reverse"))).toBe(key)
    expect(await keyOf(withTool("forward"), { apiKey: "second-key" })).toBe(key)
    const changed = await Promise.all([
      keyOf(ModelRequest.ModelRequest.make({ ...withTool("forward"), messages: ask(["capital of Spain"]).messages })),
      keyOf(ModelRequest.ModelRequest.make({ ...withTool("forward"), modelId: "other-model" })),
      keyOf(withTool("forward"), { baseUrl: "https://other-provider.invalid" })
    ])
    expect(new Set([key, ...changed]).size).toBe(4)
  })

  it("derives the same key in a process that shares nothing with this one", async () => {
    const request = withTool("forward")
    const json = JSON.stringify(reversed(Schema.encodeSync(ModelRequest.ModelRequest)(request)))
    const { stdout } = await promisify(execFile)(process.execPath, [fixture, "key", json], {
      env: childEnv,
      timeout: 120_000
    })
    const printed = JSON.parse(stdout.split("\n").find((line) => line.startsWith("{\"status\":\"key\""))!)
    expect(printed.key).toBe(await keyOf(request))
  }, 180_000)

  it("refuses material it cannot seal with a typed engine failure", async () => {
    const prepared = await Effect.runPromise(through(silent).route.prepare(ask(["hi"])))
    const exit = await Effect.runPromiseExit(
      InternalModelStep.key({ ...InternalModelStep.material(ask(["hi"])), kind: "irreversible" }, prepared)
    )
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [{ error: { code: "engine_failed", message: "The prepared model request could not be sealed" } }]
      }
    })
  })
})

describe("ModelStep.defaultRetryPolicy", () => {
  const policy = ModelStep.defaultRetryPolicy
  it("waits one second, doubling, with up to a fifth shaved off, and a provider's Retry-After up to thirty", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) =>
      Option.getOrThrow(RetryPolicy.nextDelay(policy, attempt, { random: 1, elapsedMs: 0 }))
    )
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(Option.getOrThrow(RetryPolicy.nextDelay(policy, 1, { random: 0, elapsedMs: 0 }))).toBe(800)
    const overloaded = new ModelError.ModelError({
      code: "provider_internal",
      httpStatus: 529,
      message: "Overloaded",
      retryAfterMillis: 45_000
    })
    expect(RetryPolicy.decide(policy, { attempt: 1, error: overloaded, random: 1, elapsedMs: 0 }))
      .toEqual({ _tag: "RetryAfter", delayMs: 30_000 })
  })

  it("makes at most six attempts however long each ran, and never retries a permission failure", () => {
    // A model call's attempts run from milliseconds to its call timeout, so the
    // bound counts attempts: a wall-clock window would forbid any retry of a
    // long reasoning call that dropped its connection late.
    expect(RetryPolicy.decide(policy, { attempt: 5, error: rateLimited(), random: 1, elapsedMs: 600_000 }))
      .toEqual({ _tag: "RetryAfter", delayMs: 16_000 })
    expect(RetryPolicy.decide(policy, { attempt: 6, error: rateLimited(), random: 1, elapsedMs: 31_000 }))
      .toEqual({ _tag: "GiveUp", reason: "exhausted" })
    const denied = new Permission.PermissionDenied({
      capability: Capability.make("net:post", "https://provider.invalid/v1/chat/completions"),
      reason: "denied"
    })
    expect(RetryPolicy.decide(policy, { attempt: 1, error: denied, elapsedMs: 0 }))
      .toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
  })
})

describe("ModelStep's one engine attempt", () => {
  // Retries are the engine's on both paths: an attempt makes one provider call.
  const attempt = (answer: Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>, final: boolean) => {
    const model = scripted(() => answer)
    return Effect.runPromiseExit(
      InternalModelStep.recordModelStep(model.model, ask(["capital of France"]), { reissue: false, final })
    ).then((exit) => ({ exit, calls: model.calls.length }))
  }

  it("fails a dropped connection unsealed for the engine, and seals it on the last attempt", async () => {
    const dropped = new ModelError.ModelError({ code: "transport", httpStatus: 502, message: "Bad gateway" })
    const retried = await attempt(Stream.fail(dropped), false)
    expect(retried.calls).toBe(1)
    expect(Exit.isFailure(retried.exit)).toBe(true)
    expect(Cause.squash((retried.exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({ code: "transport" })
    const sealed = await attempt(Stream.fail(dropped), true)
    expect(sealed.calls).toBe(1)
    expect(sealed.exit).toMatchObject({ _tag: "Success", value: { events: [], error: { code: "transport" } } })
  })

  it("seals a refusal no wait can clear only for a caller that asks, and never a quota that names its reset", async () => {
    const attemptWith = (error: ModelError.ModelError, sealTerminal: boolean) => {
      const model = scripted(() => Stream.fail(error))
      return Effect.runPromiseExit(
        InternalModelStep.recordModelStep(model.model, ask(["capital of France"]), {
          reissue: false,
          final: false,
          sealTerminal
        })
      )
    }
    const payment = new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "Payment required" })
    expect(await attemptWith(payment, true)).toMatchObject({
      _tag: "Success",
      value: { events: [], error: { code: "quota_exceeded", httpStatus: 402 } }
    })
    // The agent loop's controller parks on refusals, so its steps leave every one unsealed.
    expect(Exit.isFailure(await attemptWith(payment, false))).toBe(true)
    const resets = new ModelError.ModelError({
      code: "quota_exceeded",
      httpStatus: 429,
      retryAfterMillis: 1_000,
      message: "Tokens per minute"
    })
    expect(Exit.isFailure(await attemptWith(resets, true))).toBe(true)
  })

  it("fails a capacity refusal unsealed on the last attempt too", async () => {
    const overloaded = new ModelError.ModelError({ code: "provider_internal", httpStatus: 529, message: "Overloaded" })
    const last = await attempt(Stream.fail(overloaded), true)
    expect(Exit.isFailure(last.exit)).toBe(true)
    expect(Cause.squash((last.exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({
      code: "provider_internal"
    })
  })
})

describe("ModelStep bounds by reasoning effort", () => {
  const efforts = [undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
  it("gives a model that thinks longer a longer silence, and none at xhigh and max", () => {
    expect(efforts.map(ModelStep.heartbeatTimeoutMsFor)).toEqual([
      300_000,
      60_000,
      60_000,
      60_000,
      300_000,
      300_000,
      0,
      0
    ])
  })

  it("gives one call the agent loop's ceiling for its effort", () => {
    expect(efforts.map(ModelStep.callTimeoutMsFor)).toEqual([
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
      900_000,
      1_800_000,
      1_800_000
    ])
  })
})

withPostgres("ModelStep on the durable engine", () => {
  it("answers a request it has sealed from the record, and keys it on what the provider is sent", async () => {
    const model = scripted(() => Stream.fromIterable(reply("Paris")))
    const replays: Array<boolean> = []
    const steps: ReadonlyArray<readonly [ModelRequest.ModelRequest, Parameters<typeof through>[1]]> = [
      [withTool("forward"), {}],
      [withTool("reverse"), {}],
      [withTool("forward"), { apiKey: "second-key" }],
      [ModelRequest.ModelRequest.make({ ...withTool("forward"), messages: ask(["capital of Spain"]).messages }), {}],
      [ModelRequest.ModelRequest.make({ ...withTool("forward"), modelId: "other-model" }), {}],
      [withTool("forward"), { baseUrl: "https://other-provider.invalid" }]
    ]
    const value = await Effect.runPromise(host(
      scratch(),
      () =>
        Effect.gen(function*() {
          for (const [request, routing] of steps) {
            const result = yield* ModelStep.run({ name: step, request, ...through(model.model, routing) })
            replays.push(result.replayed)
          }
          return replays.length
        }),
      execute("keys", "capital of France")
    ))
    expect(value).toBe(6)
    expect(replays).toEqual([false, true, true, false, false, false])
    expect(model.calls.map((request) => request.modelId)).toEqual([
      "test-model",
      "test-model",
      "other-model",
      "test-model"
    ])
  })

  it("makes no call for a settled execution, and a call of its own for another execution", async () => {
    const model = scripted(() => Stream.fromIterable(reply("Paris")))
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({ name: step, request: ask([prompt]), ...through(model.model) }),
        (result) => ({ text: textOf(result.events), replayed: result.replayed })
      )
    const place = scratch()
    const first = await Effect.runPromise(host(place, handler, execute("settled", "capital of France")))
    const again = await Effect.runPromise(host(place, handler, execute("settled", "capital of France")))
    expect(model.calls).toHaveLength(1)
    expect(again).toEqual(first)
    const other = await Effect.runPromise(host(place, handler, execute("other", "capital of France")))
    expect(other).toEqual({ text: "Paris", replayed: false })
    expect(model.calls).toHaveLength(2)
  })

  it("streams events to onEvent while the call runs, and hands a replay the recorded events", async () => {
    const program = Effect.gen(function*() {
      const streamed = yield* Deferred.make<void>()
      // The provider holds its stream open after its first text until
      // `onEvent` has seen that text, so an `onEvent` that only heard the
      // call once it settled would leave the step hanging.
      const model = scripted(() =>
        Stream.concat(
          Stream.fromIterable(reply("Paris").slice(0, 2)),
          Stream.fromEffect(Deferred.await(streamed)).pipe(
            Stream.flatMap(() => Stream.fromIterable(reply("Paris").slice(2)))
          )
        )
      )
      const deliveries: Array<Array<string>> = []
      const park = parkOnce()
      const handler: Handler = ({ prompt }) =>
        Effect.gen(function*() {
          const seen: Array<string> = []
          deliveries.push(seen)
          const result = yield* ModelStep.run({
            name: step,
            request: ask([prompt]),
            ...through(model.model),
            onEvent: (event) =>
              Effect.suspend(() => {
                seen.push(event.type)
                return event.type === "text-delta" ? Deferred.succeed(streamed, undefined) : Effect.void
              })
          })
          yield* park
          return { text: textOf(result.events), replayed: result.replayed }
        })
      const value = yield* host(scratch(), handler, parkThenResume("streamed", "capital of France"))
      return { value, deliveries, calls: model.calls.length }
    })
    const { calls, deliveries, value } = await Effect.runPromise(program)
    expect(value).toEqual({ text: "Paris", replayed: true })
    expect(calls).toBe(1)
    const types = reply("Paris").map((event) => event.type)
    expect(deliveries).toEqual([types, types])
  })

  it("seals a provider refusal as a typed value, and replays it without asking again", async () => {
    const model = scripted(() =>
      Stream.fail(new ModelError.ModelError({ code: "invalid_request", httpStatus: 400, message: "Bad request" }))
    )
    const park = parkOnce()
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const result = yield* ModelStep.run({ name: step, request: ask([prompt]), ...through(model.model) })
        yield* park
        return { code: result.error?.code ?? null, replayed: result.replayed, events: result.events.length }
      })
    const value = await Effect.runPromise(host(scratch(), handler, parkThenResume("refused", "capital of France")))
    expect(value).toEqual({ code: "invalid_request", replayed: true, events: 0 })
    expect(model.calls).toHaveLength(1)
  })

  it("serves a Model whose calls are sealed steps, replayed on resume, with a sealed refusal failing the stream", async () => {
    const model = scripted((_, request) =>
      request.messages.length > 1
        ? Stream.fail(new ModelError.ModelError({ code: "invalid_request", httpStatus: 400, message: "Bad request" }))
        : Stream.fromIterable(reply("Paris"))
    )
    const codeOf = (error: { readonly _tag: string; readonly code?: string }) => error.code ?? error._tag
    const park = parkOnce()
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const sealed = yield* ModelStep.model({ name: step, ...through({ ...model.model, providerName: "test" }) })
        const answered = yield* Stream.runCollect(sealed.stream(ask([prompt])))
        const refused = yield* Stream.runCollect(sealed.stream(ask([prompt, "and Spain?"]))).pipe(
          Effect.match({ onFailure: codeOf, onSuccess: () => "answered" })
        )
        yield* park
        return { text: textOf(answered), refused, providerName: sealed.providerName ?? null }
      })
    const value = await Effect.runPromise(host(scratch(), handler, parkThenResume("as-model", "capital of France")))
    expect(value).toEqual({ text: "Paris", refused: "invalid_request", providerName: "test" })
    // The resumed body streamed both requests again, and the record answered each.
    expect(model.calls).toHaveLength(2)
  })

  it("fails a Model's stream with the step's failure, and a key it cannot derive as an unknown ModelError", async () => {
    const model = scripted(() => Stream.fail(rateLimited()))
    const once = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
    const codeOf = (error: { readonly _tag: string; readonly code?: string }) => error.code ?? error._tag
    const route = through(model.model).route
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const limited = yield* ModelStep.model({ name: step, model: model.model, route, retryPolicy: once })
        const unsealable = yield* ModelStep.model({
          name: step,
          model: model.model,
          route: {
            prepare: (request) =>
              Effect.map(route.prepare(request), (prepared) => ({ ...prepared, publicHeaders: { x: 1n as never } }))
          }
        })
        const run = (sealed: typeof limited) =>
          Stream.runCollect(sealed.stream(ask([prompt]))).pipe(
            Effect.match({ onFailure: codeOf, onSuccess: () => "answered" })
          )
        return [yield* run(limited), yield* run(unsealable)]
      })
    expect(await Effect.runPromise(host(scratch(), handler, execute("as-model-failed", "capital of France"))))
      .toEqual(["rate_limited", "unknown"])
  })

  it("retries a rate limit through the retry policy without sealing it", async () => {
    const model = scripted((call) => call === 1 ? Stream.fail(rateLimited()) : Stream.fromIterable(reply("Paris")))
    const deliveries: Array<Array<ModelEvent.ModelEvent>> = []
    const park = parkOnce()
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const seen: Array<ModelEvent.ModelEvent> = []
        deliveries.push(seen)
        const result = yield* ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: quickly,
          onEvent: (event) => Effect.sync(() => void seen.push(event))
        })
        yield* park
        return { text: textOf(result.events), replayed: result.replayed }
      })
    const value = await Effect.runPromise(host(scratch(), handler, parkThenResume("limited", "capital of France")))
    expect(value).toEqual({ text: "Paris", replayed: true })
    expect(model.calls).toHaveLength(2)
    const [live, replayed] = deliveries
    // The second attempt opens with the retry that discards the first
    // attempt's output; the record holds only the attempt that answered.
    expect(live![0]).toMatchObject({ type: "retry", attempt: 2, code: "rate_limited", httpStatus: 429 })
    expect(live!.slice(1).map((event) => event.type)).toEqual(reply("Paris").map((event) => event.type))
    expect(replayed!.map((event) => event.type)).toEqual(reply("Paris").map((event) => event.type))
  })

  it("asks once for a payment refusal, which no wait clears, and replays it without asking again", async () => {
    const model = scripted(() =>
      Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "Payment required" }))
    )
    const sixTimes = RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 })
    const park = parkOnce()
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const result = yield* ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: sixTimes
        })
        yield* park
        return { code: result.error?.code ?? null, status: result.error?.httpStatus ?? null, replayed: result.replayed }
      })
    const value = await Effect.runPromise(host(scratch(), handler, parkThenResume("payment", "capital of France")))
    expect(value).toEqual({ code: "quota_exceeded", status: 402, replayed: true })
    // Six attempts before this: one per default retry, all refused the same way.
    expect(model.calls).toHaveLength(1)
  })

  it("still waits out a quota that names when it resets", async () => {
    const model = scripted((call) =>
      call === 1
        ? Stream.fail(
          new ModelError.ModelError({
            code: "quota_exceeded",
            httpStatus: 429,
            retryAfterMillis: 1,
            message: "Tokens per minute"
          })
        )
        : Stream.fromIterable(reply("Paris"))
    )
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({ name: step, request: ask([prompt]), ...through(model.model), retryPolicy: quickly }),
        (result) => ({ text: textOf(result.events), code: result.error?.code ?? null })
      )
    expect(await Effect.runPromise(host(scratch(), handler, execute("quota-resets", "capital of France"))))
      .toEqual({ text: "Paris", code: null })
    expect(model.calls).toHaveLength(2)
  })

  it("fails with the rate limit once the retry policy gives up", async () => {
    const model = scripted(() => Stream.fail(rateLimited()))
    const handler: Handler = ({ prompt }) =>
      Effect.as(
        ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 })
        }),
        null
      )
    const exit = await Effect.runPromiseExit(host(scratch(), handler, execute("exhausted", "capital of France")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({ code: "rate_limited" })
    expect(model.calls).toHaveLength(2)
  })

  it("waits the provider's Retry-After, not the policy's backoff, before the engine retries a rate limit", async () => {
    const program = Effect.gen(function*() {
      const calledAt: Array<number> = []
      const model = scripted((call) =>
        Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => {
          calledAt.push(now)
          return call === 1
            ? Stream.fail(
              new ModelError.ModelError({
                code: "rate_limited",
                httpStatus: 429,
                message: "Too many requests",
                retryAfterMillis: 30_000
              })
            )
            : Stream.fromIterable(reply("Paris"))
        }))
      )
      const handler: Handler = ({ prompt }) =>
        Effect.map(
          ModelStep.run({
            name: step,
            request: ask([prompt]),
            ...through(model.model),
            // Alone, this policy retries after one millisecond.
            retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 60_000, maxAttempts: 3 })
          }),
          (result) => textOf(result.events)
        )
      const text = yield* host(
        scratch(),
        handler,
        Effect.gen(function*() {
          const running = yield* Effect.forkChild(execute("retry-after", "capital of France"), {
            startImmediately: true
          })
          yield* advanceUntil(() => running.pollUnsafe() !== undefined, 100, "the retried call")
          return yield* Fiber.join(running)
        })
      )
      return { text, calledAt }
    })
    const { calledAt, text } = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))
    expect(text).toBe("Paris")
    expect(calledAt).toHaveLength(2)
    // The test clock also moves while the engine records the first failure,
    // so only the lower bound tells the provider's delay from the policy's.
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(30_000)
  })

  it.each([["an error", new Error("socket torn down")], ["a bare value", "socket torn down"]])(
    "fails the step when the provider stream dies with %s, without sealing anything",
    async (_, defect) => {
      const model = scripted(() => Stream.die(defect))
      const handler: Handler = ({ prompt }) =>
        Effect.as(ModelStep.run({ name: step, request: ask([prompt]), ...through(model.model) }), null)
      const exit = await Effect.runPromiseExit(host(scratch(), handler, execute("died", "capital of France")))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(model.calls).toHaveLength(1)
    }
  )

  it("fails the step on a permission refusal without retrying it", async () => {
    const denied = new Permission.PermissionDenied({
      capability: Capability.make("net:post", "https://provider.invalid/v1/chat/completions"),
      reason: "the host refused the provider"
    })
    const model = scripted(() => Stream.fail(denied))
    const handler: Handler = ({ prompt }) =>
      Effect.as(ModelStep.run({ name: step, request: ask([prompt]), ...through(model.model) }), null)
    const exit = await Effect.runPromiseExit(host(scratch(), handler, execute("denied", "capital of France")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({ code: "permission_denied" })
    expect(model.calls).toHaveLength(1)
  })

  it("leaves a provider fault to the retry policy and seals only the attempt that answered", async () => {
    const model = scripted((call) =>
      call === 1
        ? Stream.fail(new ModelError.ModelError({ code: "transport", httpStatus: 502, message: "Bad gateway" }))
        : Stream.fromIterable(reply("Paris"))
    )
    const seen: Array<ModelEvent.ModelEvent> = []
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: quickly,
          onEvent: (event) => Effect.sync(() => void seen.push(event))
        }),
        (result) => JSON.parse(JSON.stringify(result.events)) as Schema.Json
      )
    const events = await Effect.runPromise(host(scratch(), handler, execute("faulted", "capital of France")))
    expect(model.calls).toHaveLength(2)
    expect(events).toMatchObject(reply("Paris").map((event) => ({ type: event.type })))
    expect(seen[0]).toMatchObject({ type: "retry", attempt: 2, code: "transport", httpStatus: 502 })
  })

  it("seals a call that runs past callTimeoutMs as call_timeout, without asking again", async () => {
    const model = scripted(() =>
      Stream.concat(
        Stream.fromIterable(reply("Paris").slice(0, 1)),
        Stream.fromEffectRepeat(
          Effect.as(
            Effect.sleep(100),
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "." })
          )
        )
      )
    )
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: quickly,
          callTimeoutMs: 1_000,
          heartbeatTimeoutMs: 5_000
        }),
        (result) => result.error?.code ?? null
      )
    const code = await Effect.runPromise(host(scratch(), handler, execute("overrun", "capital of France")))
    expect(code).toBe("call_timeout")
    expect(model.calls).toHaveLength(1)
  })

  // The engine's run lease reads the same clock as the heartbeat, so these two
  // cases run on the live clock with a short timeout rather than skipping a
  // test clock past a lease nothing renewed.
  it("fails an attempt that streams nothing for the heartbeat timeout, and retries it", async () => {
    const model = scripted((call) =>
      call === 1
        ? Stream.concat(Stream.fromIterable(reply("Paris").slice(0, 1)), Stream.never)
        : Stream.fromIterable(reply("Paris"))
    )
    const seen: Array<ModelEvent.ModelEvent> = []
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: quickly,
          heartbeatTimeoutMs: 2_000,
          onEvent: (event) => Effect.sync(() => void seen.push(event))
        }),
        (result) => textOf(result.events)
      )
    const value = await Effect.runPromise(host(scratch(), handler, execute("silent", "capital of France")))
    expect(value).toBe("Paris")
    expect(model.calls).toHaveLength(2)
    expect(seen.map((event) => event.type)).toEqual([
      "text-start",
      "retry",
      ...reply("Paris").map((event) => event.type)
    ])
    expect(seen[1]).toMatchObject({ type: "retry", attempt: 2, code: "interrupted" })
  })

  it("keeps a slow call alive while each event arrives inside the heartbeat timeout", async () => {
    // Five events half a second apart take longer than the two-second
    // timeout, so only a heartbeat on every event keeps the attempt alive.
    const model = scripted(() =>
      Stream.fromIterable(reply("Paris")).pipe(Stream.mapEffect((event) => Effect.as(Effect.sleep(500), event)))
    )
    const handler: Handler = ({ prompt }) =>
      Effect.map(
        ModelStep.run({
          name: step,
          request: ask([prompt]),
          ...through(model.model),
          retryPolicy: quickly,
          heartbeatTimeoutMs: 2_000
        }),
        (result) => textOf(result.events)
      )
    const value = await Effect.runPromise(host(scratch(), handler, execute("slow", "capital of France")))
    expect(value).toBe("Paris")
    expect(model.calls).toHaveLength(1)
  })

  it("calls the provider again for a call cut off mid-flight, and counts it", async () => {
    const counted = () =>
      Effect.map(Metric.snapshot, (metrics) =>
        metrics.filter((metric) => metric.id === "agent_model_step_redispatches")
          .reduce((sum, metric) => sum + Number((metric.state as { readonly count: number }).count), 0))
    const program = Effect.gen(function*() {
      const inFlight = yield* Deferred.make<void>()
      const model = scripted((call) =>
        call === 1
          ? Stream.concat(
            Stream.fromIterable(reply("Paris").slice(0, 2)),
            Stream.fromEffect(Deferred.succeed(inFlight, undefined)).pipe(Stream.flatMap(() => Stream.never))
          )
          : Stream.fromIterable(reply("Paris"))
      )
      const deliveries: Array<Array<ModelEvent.ModelEvent>> = []
      const handler: Handler = ({ prompt }) =>
        Effect.gen(function*() {
          const seen: Array<ModelEvent.ModelEvent> = []
          deliveries.push(seen)
          const result = yield* ModelStep.run({
            name: step,
            request: ask([prompt]),
            ...through(model.model),
            onEvent: (event) => Effect.sync(() => void seen.push(event))
          })
          return { text: textOf(result.events), replayed: result.replayed }
        })
      const before = yield* counted()
      const place = scratch()
      // The first host stops while the provider is still answering: its scope
      // closes, as a host's does on shutdown, with the call open.
      yield* host(
        place,
        handler,
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.execute(Probe, { executionId: "cut", payload: { prompt: "capital of France" }, discard: true })
          yield* Deferred.await(inFlight)
        })
      )
      const value = yield* host(place, handler, execute("cut", "capital of France"))
      return { value, deliveries, calls: model.calls.length, counted: (yield* counted()) - before }
    })
    const { calls, counted: redispatches, deliveries, value } = await Effect.runPromise(program)
    expect(value).toEqual({ text: "Paris", replayed: false })
    expect(calls).toBe(2)
    expect(redispatches).toBe(1)
    expect(deliveries[1]![0]).toMatchObject({ type: "retry", code: "interrupted", delayMillis: 0 })
  })
})

// The in-memory engine holds no run lease, so its test clock can skip minutes
// that the Postgres engine's lease renewals could not keep up with.
describe("ModelStep on the in-memory engine", () => {
  /** A model that thinks for `seconds` without an event, sending a keep-alive every ten when `alive`. */
  const thinking = (seconds: number, alive: boolean) =>
    scripted(() =>
      Stream.concat(
        Stream.fromEffect(Effect.gen(function*() {
          const beat = yield* Model.Liveness
          for (let waited = 0; waited < seconds; waited += 10) {
            yield* Effect.sleep(10_000)
            if (alive) yield* beat
          }
        })).pipe(Stream.drain),
        Stream.fromIterable(reply("Paris"))
      )
    )

  /**
   * `model` behind the metered model endpoint: `ModelProxy.serve` as a Web
   * handler on this test's clock, and the browser's `ModelProxy` client whose
   * `fetch` calls it, with no socket between them.
   */
  const endpoint = (model: Model.Model) =>
    Effect.gen(function*() {
      const url = "http://model.test/api/model/agent"
      const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(
        yield* Effect.context<never>()
      )(ModelProxy.serve({ prepare: (request) => Effect.succeed({ model, request }) }))
      const fetch: typeof globalThis.fetch = (input, init) => handler(new Request(input, init))
      const client = yield* ModelProxy.makeClient({ url }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))).pipe(
            HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch))
          )
        )
      )
      return { model: client, route: { prepare: ModelProxy.prepare({ url }) } }
    })

  const think = (
    model: ReturnType<typeof thinking>,
    reasoningEffort: ModelRequest.ReasoningEffort,
    served = false
  ) =>
    Effect.gen(function*() {
      const seat = served ? yield* endpoint(model.model) : through(model.model)
      const handler: Handler = ({ prompt }) =>
        Effect.map(
          ModelStep.run({
            name: step,
            request: ModelRequest.ModelRequest.make({
              ...ask([prompt]),
              params: ModelRequest.GenerationParams.make({ reasoningEffort })
            }),
            ...seat,
            retryPolicy: quickly
          }),
          (result) => textOf(result.events)
        )
      const exit = yield* memory(
        handler,
        Effect.gen(function*() {
          const running = yield* Effect.forkChild(execute("thinking", "capital of France"), {
            startImmediately: true
          })
          yield* advanceUntil(() => running.pollUnsafe() !== undefined, 1_000, "the long think")
          return yield* Fiber.await(running)
        })
      )
      return { exit, calls: model.calls.length }
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

  it("lets a reasoning call think in silence past the minute an ordinary call gets", async () => {
    const { calls, exit } = await think(thinking(120, false), "high")
    expect(exit).toEqual(Exit.succeed("Paris"))
    expect(calls).toBe(1)
  })

  it("puts no silence bound on a call at max effort, which its call timeout bounds instead", async () => {
    const { calls, exit } = await think(thinking(600, false), "max")
    expect(exit).toEqual(Exit.succeed("Paris"))
    expect(calls).toBe(1)
  })

  it("cuts off an ordinary call silent for a minute, and asks again", async () => {
    const { calls } = await think(thinking(120, false), "low")
    expect(calls).toBe(3)
  })

  it("keeps a call alive through minutes of silence while the provider sends keep-alives", async () => {
    // Past `high`'s five minutes, and past the agent loop's own silence bound:
    // only keep-alives keep this call going.
    const { calls, exit } = await think(thinking(400, true), "high")
    expect(exit).toEqual(Exit.succeed("Paris"))
    expect(calls).toBe(1)
  })

  it("keeps a call through the model endpoint alive while the provider behind it sends keep-alives", async () => {
    // The browser's step reads the provider through `ModelProxy`: the endpoint
    // forwards each keep-alive as a blank line and the client counts it, so
    // 400 s without an event outlasts `high`'s 300 s silence bound.
    const { calls, exit } = await think(thinking(400, true), "high", true)
    expect(exit).toEqual(Exit.succeed("Paris"))
    expect(calls).toBe(1)
  })

  it("still cuts off a call through the model endpoint whose provider goes silent, and asks again", async () => {
    const { calls, exit } = await think(thinking(400, false), "high", true)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({
      code: "attempt_timed_out",
      bound: "heartbeat",
      timeoutMs: 300_000
    })
    expect(calls).toBe(3)
  })

  it("makes one HTTP request per policy attempt, however many retries the route's executor allows", async () => {
    // The executor is built with its default ladder, which repeats a 503
    // twice more inside every attempt unless the step allows no retries.
    let requests = 0
    const server = http.createServer((request, response) => {
      request.resume()
      request.on("end", () => {
        requests++
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "overloaded" } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const configured = Result.getOrThrow(Route.openaiChatCompatible({
        id: "model-step-executor",
        providerName: "test",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: Redacted.make("wire-key")
      }))
      const program = Effect.gen(function*() {
        const model = yield* Route.toModel(configured).pipe(
          Effect.provide(
            Layer.effect(RequestExecutor.RequestExecutor)(
              Effect.flatMap(HttpClient.HttpClient, (client) => RequestExecutor.makeWith(RequestExecutor.fixed(client)))
            )
          ),
          Effect.provide(FetchHttpClient.layer)
        )
        const handler: Handler = ({ prompt }) =>
          Effect.as(
            ModelStep.run({
              name: step,
              request: ask([prompt]),
              model,
              route: { prepare: (input) => Route.prepare(configured, input) },
              retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 })
            }),
            null
          )
        return yield* memory(handler, execute("executor", "capital of France")).pipe(Effect.exit)
      })
      const exit = await Effect.runPromise(program)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({
        code: "provider_internal",
        httpStatus: 503
      })
      expect(requests).toBe(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("makes one request per policy attempt against an overloaded provider, each after its Retry-After", async () => {
    // Before, the step retried `provider_internal` six times in itself,
    // ignoring Retry-After, and the policy then repeated the whole ladder.
    const program = Effect.gen(function*() {
      const calledAt: Array<number> = []
      const model = scripted(() =>
        Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => {
          calledAt.push(now)
          return Stream.fail(
            new ModelError.ModelError({
              code: "provider_internal",
              httpStatus: 529,
              message: "Overloaded",
              retryAfterMillis: 20_000
            })
          )
        }))
      )
      const handler: Handler = ({ prompt }) =>
        Effect.as(
          ModelStep.run({
            name: step,
            request: ask([prompt]),
            ...through(model.model),
            retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 60_000, maxAttempts: 3 })
          }),
          null
        )
      const exit = yield* memory(
        handler,
        Effect.gen(function*() {
          const running = yield* Effect.forkChild(execute("overloaded", "capital of France"), {
            startImmediately: true
          })
          yield* advanceUntil(() => running.pollUnsafe() !== undefined, 250, "the policy giving up")
          return yield* Fiber.await(running)
        })
      )
      return { calledAt, exit }
    })
    const { calledAt, exit } = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))
    expect(calledAt).toHaveLength(3)
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(20_000)
    expect(calledAt[2]! - calledAt[1]!).toBeGreaterThanOrEqual(20_000)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)).toMatchObject({ code: "provider_internal" })
  })
})

/** Starts a fixture host, resolving when it prints `marker`. */
const startChild = (args: ReadonlyArray<string>, marker: string) => {
  const child = spawn(process.execPath, [fixture, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const reached = new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`child exited ${code} before ${marker}: ${stderr}`)))
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
      if (stdout.includes(`"status":"${marker}"`)) resolve()
    })
  })
  return { child, reached, lines: () => stdout.split("\n").filter((line) => line.startsWith("{")) }
}

const kill = async (child: ReturnType<typeof spawn>) => {
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  const [, signal] = await exited
  return signal
}

/** Drives the execution to completion in a fresh host process, returning its receipt. */
const resume = async (place: { readonly schema: string; readonly root: string }, executionId: string) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fixture, "resume", place.schema, place.root, executionId],
    { env: childEnv, timeout: 120_000 }
  )
  return JSON.parse(stdout.split("\n").find((line) => line.startsWith("{\"status\":\"done\""))!)
}

withPostgres("ModelStep across a killed process", () => {
  it("makes one provider call when the host dies after the seal and before the next step", async () => {
    const place = scratch()
    const killed = startChild(["seal", place.schema, place.root, "after-seal"], "next-entered")
    try {
      await killed.reached
      expect(await kill(killed.child)).toBe("SIGKILL")
      expect(killed.lines().filter((line) => line.includes("\"called\""))).toHaveLength(1)
      expect(await resume(place, "after-seal")).toEqual({
        status: "done",
        value: { text: "Paris", replayed: true },
        calls: 0,
        redispatches: 0
      })
    } finally {
      if (killed.child.exitCode === null && killed.child.signalCode === null) await kill(killed.child)
    }
  }, 180_000)

  it("calls the provider again when the host dies mid-call, and counts the repeat", async () => {
    const place = scratch()
    const killed = startChild(["midflight", place.schema, place.root, "mid-call"], "in-flight")
    try {
      await killed.reached
      expect(await kill(killed.child)).toBe("SIGKILL")
      expect(await resume(place, "mid-call")).toEqual({
        status: "done",
        value: { text: "Paris", replayed: false },
        calls: 1,
        redispatches: 1
      })
    } finally {
      if (killed.child.exitCode === null && killed.child.signalCode === null) await kill(killed.child)
    }
  }, 180_000)
})

/** One SSE frame of the Chat Completions stream. */
const frame = (fields: object): string => `data: ${JSON.stringify({ id: "chatcmpl_1", ...fields })}\n\n`

withPostgres("ModelStep over a provider's wire", () => {
  it("resends byte-identical bodies on the engine's retry, the bytes its key digests", async () => {
    const bodies: Array<Buffer> = []
    const server = http.createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks))
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: "Par" } }] }))
        // The first answer dies mid-body, as a dropped connection does.
        if (bodies.length === 1) return response.socket?.destroy()
        response.write(frame({ choices: [{ index: 0, delta: { content: "is" } }] }))
        response.end(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const configured = Result.getOrThrow(Route.openaiChatCompatible({
        id: "model-step-wire",
        providerName: "test",
        baseUrl,
        apiKey: Redacted.make("wire-key")
      }))
      const request = ask(["capital of France"])
      const program = Effect.gen(function*() {
        const model = yield* Route.toModel(configured).pipe(
          Effect.provide(
            Layer.effect(RequestExecutor.RequestExecutor)(
              Effect.gen(function*() {
                const client = yield* HttpClient.HttpClient
                return yield* RequestExecutor.makeWith(RequestExecutor.fixed(client), { maxRetries: 0 })
              })
            )
          ),
          Effect.provide(FetchHttpClient.layer)
        )
        const seen: Array<ModelEvent.ModelEvent> = []
        const handler: Handler = () =>
          Effect.map(
            ModelStep.run({
              name: step,
              request,
              model,
              route: { prepare: (input) => Route.prepare(configured, input) },
              retryPolicy: quickly,
              onEvent: (event) => Effect.sync(() => void seen.push(event))
            }),
            (result) => textOf(result.events)
          )
        const value = yield* host(scratch(), handler, execute("wire", "capital of France"))
        return { value, seen }
      })
      const { seen, value } = await Effect.runPromise(program)
      expect(value).toBe("Paris")
      expect(bodies).toHaveLength(2)
      expect(bodies[1]!.equals(bodies[0]!)).toBe(true)
      const prepared = await Effect.runPromise(Route.prepare(configured, request))
      expect(Buffer.from(prepared.body).equals(bodies[0]!)).toBe(true)
      expect(seen.find((event) => event.type === "retry")).toMatchObject({ code: "transport" })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("counts a silent provider's keep-alive comments as heartbeats", async () => {
    // The provider says nothing a protocol decodes for longer than the
    // heartbeat, but keeps the connection alive with SSE comments, as a
    // reasoning model's gateway does while it thinks.
    let requests = 0
    const server = http.createServer((request, response) => {
      request.resume()
      request.on("end", () => {
        requests++
        response.writeHead(200, { "content-type": "text/event-stream" })
        let pings = 0
        const timer = setInterval(() => {
          if (pings++ < 12) return void response.write(": keep-alive\n\n")
          clearInterval(timer)
          response.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: "Paris" } }] }))
          response.end(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
        }, 200)
        response.on("close", () => clearInterval(timer))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const configured = Result.getOrThrow(Route.openaiChatCompatible({
        id: "model-step-keep-alive",
        providerName: "test",
        baseUrl,
        apiKey: Redacted.make("wire-key")
      }))
      const program = Effect.gen(function*() {
        const model = yield* Route.toModel(configured).pipe(
          Effect.provide(
            Layer.effect(RequestExecutor.RequestExecutor)(
              Effect.gen(function*() {
                const client = yield* HttpClient.HttpClient
                return yield* RequestExecutor.makeWith(RequestExecutor.fixed(client), { maxRetries: 0 })
              })
            )
          ),
          Effect.provide(FetchHttpClient.layer)
        )
        const handler: Handler = ({ prompt }) =>
          Effect.map(
            ModelStep.run({
              name: step,
              request: ask([prompt]),
              model,
              route: { prepare: (input) => Route.prepare(configured, input) },
              retryPolicy: quickly,
              heartbeatTimeoutMs: 1_000
            }),
            (result) => textOf(result.events)
          )
        return yield* host(scratch(), handler, execute("keep-alive", "capital of France"))
      })
      expect(await Effect.runPromise(program)).toBe("Paris")
      expect(requests).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

/** Everything a span exporter would write, flattened to text. */
const spanText = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): string => {
  const failures = Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) => {
      const value = reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined
      return value instanceof Error ? [value.name, value.message, value.stack ?? ""] : [String(value)]
    })
    : []
  return JSON.stringify({ name: span.name, attributes: [...span.attributes], failures })
}

withPostgres("ModelStep telemetry", () => {
  it("logs, traces and counts each call without prompt, provider text or credential", async () => {
    const sentinel = "SENTINEL-7f3a"
    const spans: Array<string> = []
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const captured: Array<string> = []
    const capture = Logger.make((options) => {
      const record = StructuredLogger.formatStructured.log(options) as {
        readonly message: unknown
        readonly annotations: Record<string, unknown>
      }
      logs.push(record)
      captured.push(JSON.stringify(record), Cause.pretty(options.cause))
    })
    const tracing = (inner: Tracer.Tracer) =>
      Tracer.make({
        ...inner,
        span(options) {
          const span = inner.span(options)
          const end = span.end.bind(span)
          span.end = (time, exit) => {
            spans.push(spanText(span, exit))
            end(time, exit)
          }
          return span
        }
      })
    const model = scripted((call, request) => {
      const asked = JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(request))
      if (asked.includes("refused")) {
        return Stream.fail(
          new ModelError.ModelError({ code: "invalid_request", httpStatus: 400, message: `${sentinel} bad request` })
        )
      }
      if (asked.includes("throttled")) return Stream.fail(rateLimited(`${sentinel} still too many`))
      return call === 1 ? Stream.fail(rateLimited(`${sentinel} slow down`)) : Stream.fromIterable(reply("Paris"))
    })
    const handler: Handler = ({ prompt }) =>
      Effect.gen(function*() {
        const answered = yield* ModelStep.run({
          name: step,
          request: ask([`${prompt} ${sentinel}`]),
          ...through(model.model, { apiKey: `${sentinel}-key` }),
          retryPolicy: quickly
        })
        const refused = yield* ModelStep.run({
          name: step,
          request: ask([`refused ${sentinel}`]),
          ...through(model.model, { apiKey: `${sentinel}-key` })
        })
        // A refusal the policy gives up on fails the step, and its failure
        // crosses every span the step opened.
        const throttled = yield* ModelStep.run({
          name: step,
          request: ask([`throttled ${sentinel}`]),
          ...through(model.model, { apiKey: `${sentinel}-key` }),
          retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
        }).pipe(Effect.match({ onFailure: (failure) => failure.code, onSuccess: () => "answered" }))
        return [textOf(answered.events), refused.error?.code ?? null, throttled]
      })
    const value = await Effect.runPromise(
      host(scratch(), handler, execute("observed", "capital of France")).pipe(
        Effect.updateService(Tracer.Tracer, tracing),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )
    const metrics = await Effect.runPromise(Metric.snapshot)
    expect(value).toEqual(["Paris", "invalid_request", "rate_limited"])
    const exported = [...spans, ...captured, JSON.stringify(metrics)].join("\n")
    expect(exported).not.toContain(sentinel)
    // A model step traces, logs inside its span, and counts.
    expect(spans.some((span) => span.startsWith("{\"name\":\"ModelStep\""))).toBe(true)
    const ended = logs.filter((log) => String(log.message).includes("A model step's provider call ended"))
    expect(ended.map((log) => log.annotations.outcome)).toEqual(["refused", "sealed", "sealed_error", "refused"])
    for (const log of ended) {
      expect(log.annotations).toMatchObject({ step, model: "test-model" })
      expect(log.annotations.trace_id).toEqual(expect.any(String))
      expect(log.annotations.span_id).toEqual(expect.any(String))
    }
    expect(metrics.some((metric) => metric.id === "agent_model_step_calls")).toBe(true)
  })
})
