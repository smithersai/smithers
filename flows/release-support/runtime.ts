import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { rebuildableTransport, seatResolver } from "@smthrs/cli/NodeControl"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, type Scope } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { hostname } from "node:os"
import { dirname } from "node:path"
import * as Content from "../release-content/workflow.ts"
import * as Release from "../release/workflow.ts"
import { actionLayers } from "./operations.ts"
import { relativePath } from "./io.ts"

/** Host composition only. Bun owns its fetch pool; Node owns replaceable Undici agents. */
export const modelTransport: Effect.Effect<RequestExecutor.Transport, never, Scope.Scope> = Effect.suspend(() =>
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? rebuildableTransport(NodeHttpClient.makeDispatcher)
    : Effect.map(HttpClient.HttpClient, RequestExecutor.fixed).pipe(Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
    )))

/** The same provider/auth routing as the Smithers CLI, with named release roles. */
export const liveSeats = (model: string) => Layer.effect(SeatResolver.SeatResolver,
  Effect.gen(function*() {
    const transport = yield* modelTransport
    const executor = yield* RequestExecutor.makeWith(transport)
    const resolver = seatResolver(process.env, executor)
    return SeatResolver.make({ resolve: () => resolver.resolve(model) })
  }))

/** The evaluator a host runs with when it names none: Jev through the gateway
 * when `AI_GATEWAY_API_KEY` is set, and the unavailable transport when it is
 * not. The completion brake never falls back, so without the key a writer run
 * fails at its first completion instead of standing unjudged. An offline test
 * names a scripted one. */
export const hostEvaluator = (): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerFromEnvironment(process.env).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const agentLayers = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  maxTokens: number,
  evaluator: Layer.Layer<Evaluator.Evaluator> = hostEvaluator()
) => {
  // Writers receive a bounded evidence snapshot. They have no shell, network,
  // filesystem or publication tools; deterministic actions own that work.
  const host = Layer.effect(AgentAction.Host, Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return {
      registry,
      limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 },
      capabilityEnvelope: [],
      maxFrames: 8,
      defaultCorrections: 2
    }
  })).pipe(Layer.provide(Registry.layerFromDescriptors([])), Layer.provide(NodeServices.layer))
  return Layer.mergeAll(
    Content.Analyze.layer, Content.OutlineTemplate.layer, Content.DraftChangelog.layer,
    Content.DraftThread.layer, Content.OutlineBlog.layer, Content.DraftBlog.layer,
    Content.Score.layer, Content.Revise.layer, Release.AuditDocs.layer
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ tokens: { max: maxTokens, onExceeded: "fail" } }))),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(evaluator)
  )
}

export const runtime = (options: {
  readonly root: string
  readonly filename: string
  readonly model: string
  readonly maxTokens: number
}) => {
  const registration = Layer.mergeAll(
    actionLayers({ root: options.root, reviewDirectory: relativePath(options.root, dirname(options.filename)) }),
    agentLayers(liveSeats(options.model), options.maxTokens),
    HumanTask.layer,
    Interpreter.layer(Content.ReleaseContent),
    Interpreter.layer(Release.Release)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
  return NodeRuntime.layerHost({
    filename: options.filename,
    workspaceRoot: options.root,
    owner: { hostId: hostname() }
  }, registration)
}
