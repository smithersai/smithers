/** Run existing behavioral fixtures on the real SDK runtime. No provider or engine mocks. */
import type { ModelStep } from "@smthrs/agent"
import { WebCrypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { ModelRequest, Route, type Model } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import type { ContextPreflight, NativeAgent } from "@smthrs/rpc"
import { Cause, Effect, Exit, Layer, Option, Redacted, Result, Schedule, Schema, Stream } from "effect"
import * as Turn from "../../src/ModelTurnHost.vibe"
import * as Context from "../../src/ContextPreflight.ts"
import * as Producer from "../../src/DurableChatProducer.ts"
import * as Tools from "../../src/HostTools.ts"
import * as Server from "../../src/HostServer.ts"
import * as Probe from "../../src/ModelProbe.ts"
import * as Fallback from "../../src/FastModelFallback.vibe"

export * from "../../src/ModelTurnHost.vibe"
export * from "../../src/ContextPreflight.ts"
export * from "../../src/DurableChatProducer.ts"
export * from "../../src/HostTools.ts"
export * from "../../src/HostServer.ts"
export * from "../../src/ModelProbe.ts"

const route = Result.getOrThrow(Route.openaiChatCompatible({
  id: "behavioral-fixture", providerName: "fixture", baseUrl: "http://127.0.0.1:1", apiKey: Redacted.make("fixture")
}))
export const fixtureRoute = { prepare: (request: ModelRequest.ModelRequest) => Route.prepare(route, request) }
export type ModelTurnOptions = Omit<Turn.ModelTurnOptions, "route"> & Partial<Pick<Turn.ModelTurnOptions, "route">>
const optionsOf = (options: ModelTurnOptions): Turn.ModelTurnOptions => ({ ...options, route: options.route ?? fixtureRoute })

let sequence = 0
export const inFlow = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  uninterruptible = false
): Effect.Effect<A, E, Exclude<R, ModelStep.Requirements>> => Effect.scoped(
  Effect.gen(function*() {
    const context = yield* Effect.context<Exclude<R, ModelStep.Requirements>>()
    const engine = yield* FlowRuntime.FlowRuntime
    const id = "model-host/fixture/" + sequence++
    const flow = Flow.make(id, { payload: {}, success: Schema.Unknown, error: Schema.Unknown, body: () => Node.succeed(undefined) })
    let outcome: Exit.Exit<A, E> | undefined
    const observed = body.pipe(
      Effect.provideContext(context),
      Effect.onExit((exit) => Effect.sync(() => { outcome = exit }))
    ) as Effect.Effect<A, E, ModelStep.Requirements>
    yield* engine.register(flow, () => uninterruptible ? Effect.uninterruptible(observed) : observed)
    return (yield* Effect.uninterruptible(
      Effect.interruptible(engine.execute(flow, { executionId: id, payload: {} })).pipe(
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Effect.gen(function*() {
            yield* engine.interrupt(flow, id)
            yield* engine.poll(flow, id).pipe(Effect.repeat({
              schedule: Schedule.spaced("1 milli"),
              until: (value) => Option.isNone(value) || value.value._tag === "Complete"
            }))
            return outcome !== undefined && Exit.isSuccess(outcome) ? outcome.value : yield* Effect.failCause(cause)
          })
          : Effect.failCause(cause))
      )
    )) as A
  }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, WebCrypto.layer)))
) as Effect.Effect<A, E, Exclude<R, ModelStep.Requirements>>

export const runModelTurn = <E>(
  model: Model.Model, turn: NativeAgent.StartAgentTurnRequest, options: ModelTurnOptions,
  write: Turn.FrameWriter<E>, host?: Turn.HostLeg, diagnostics?: Parameters<typeof Turn.runModelTurn>[5]
) => inFlow(Turn.runModelTurn(model, turn, optionsOf(options), write, host, diagnostics))

export const runContextPreflight = (
  input: ContextPreflight.ContextPreflightInput, model: Model.Model, options: ModelTurnOptions
) => inFlow(Context.runContextPreflight(input, model, optionsOf(options)))

type Preflight = { readonly input: ContextPreflight.ContextPreflightInput; readonly model: Model.Model; readonly options: ModelTurnOptions }
const preflightOf = (preflight: Preflight | undefined) => preflight === undefined ? undefined : { ...preflight, options: optionsOf(preflight.options) }

export const runDurableChatTurn = (
  model: Model.Model, grant: Producer.DurableChatGrant, options: ModelTurnOptions,
  callbackBaseUrl?: string, fetchImpl?: NativeAgent.FetchLike, preflight?: Preflight,
  docs?: Parameters<typeof Producer.runDurableChatTurn>[6], diagnostics?: Parameters<typeof Producer.runDurableChatTurn>[7],
  observer?: Parameters<typeof Producer.runDurableChatTurn>[8]
) => inFlow(Producer.runDurableChatTurn(model, grant, optionsOf(options), callbackBaseUrl, fetchImpl, preflightOf(preflight), docs, diagnostics, observer))

export const runHostTurn = <E>(
  model: Model.Model, grant: Producer.DurableChatGrant, options: ModelTurnOptions, write: Turn.FrameWriter<E>,
  transport: Tools.HostTransport, diagnostics?: Parameters<typeof Tools.runHostTurn>[5]
) => inFlow(Tools.runHostTurn(model, grant, optionsOf(options), write, transport, diagnostics))

export type ModelTurnResolution = Omit<Server.ModelTurnResolution, "options" | "preflight"> & {
  readonly options: ModelTurnOptions
  readonly preflight?: Preflight
}
export type ModelTurnResolver = (
  ...args: Parameters<Server.ModelTurnResolver>
) => Effect.Effect<ModelTurnResolution, import("../../src/ModelHostError.vibe").ResolveFailed>
export type ModelTurnHandlerOptions = Omit<Server.ModelTurnHandlerOptions, "resolve"> & { readonly resolve: ModelTurnResolver }
export const createModelTurnHandler = (options: ModelTurnHandlerOptions) => Effect.uninterruptible(inFlow(Server.createModelTurnHandler({
  ...options,
  resolve: (...args) => Effect.map(options.resolve(...args), (resolved) => ({
    model: resolved.model, options: optionsOf(resolved.options),
    ...(resolved.preflight === undefined ? {} : { preflight: preflightOf(resolved.preflight)! })
  }))
}), true))
export const createModelProbe = (options: Probe.ModelProbeOptions) => {
  const probe = Probe.createModelProbe(options)
  return { ...probe, test: (...args: Parameters<typeof probe.test>) => inFlow(probe.test(...args)) }
}
export const fastModelFallback = (
  sources: ReadonlyArray<Omit<Fallback.ModelSource, "route"> & Partial<Pick<Fallback.ModelSource, "route">>>,
  onFallback?: (index: number) => Effect.Effect<void>
): Model.Model => ({
  stream: (request) => Stream.unwrap(inFlow(Effect.map(
    Stream.runCollect(Fallback.fastModelFallback(sources.map((source) => ({ ...source, route: source.route ?? fixtureRoute })), onFallback).stream(request)),
    Stream.fromIterable
  )))
})
