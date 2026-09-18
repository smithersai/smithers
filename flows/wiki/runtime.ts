/** Host composition reuses model routing and the existing runtime store. */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer } from "effect"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { checkCitations, unsupportedCitations } from "./jev-citations.ts"
import { operations } from "./operations.ts"
import { WikiError } from "./schema.ts"
import { Assess, CheckCitations, Collect, ReviewPage, ValidateReview, Wiki, Write } from "./workflow.ts"

/** The evaluator a host runs with when it names none: Jev through the gateway
 * when `AI_GATEWAY_API_KEY` is set, and the unavailable transport when it is
 * not. The completion brake never falls back, so without the key a review run
 * fails at its first completion instead of standing unjudged. An offline test
 * names a scripted one. */
export const hostEvaluator = (): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerFromEnvironment(process.env).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const agentLayers = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  maxReviewMillis: number,
  evaluator: Layer.Layer<Evaluator.Evaluator> = hostEvaluator()
) => {
  const host = Layer.effect(AgentAction.Host, Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return { registry, limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 }, capabilityEnvelope: [], maxFrames: 8, defaultCorrections: 2 }
  })).pipe(Layer.provide(Registry.layerFromDescriptors([])))
  return ReviewPage.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ latency: { maxMillis: maxReviewMillis, onExceeded: "fail" } }))),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(evaluator)
  )
}
export const registration = (options: { readonly root: string; readonly output: string }, reviewers: ReturnType<typeof agentLayers>) =>
  Layer.mergeAll(actionLayers(options), reviewers, Interpreter.layer(Wiki)).pipe(Layer.provideMerge(Action.layerImplementations))

/** Jev through the Vercel gateway when `AI_GATEWAY_API_KEY` is set, else one
 * that answers `unreachable`. The key is required to review a page at all:
 * without it every verified run refuses instead of publishing claims whose
 * citations nothing checked. A test supplies its own scripted evaluator. */
export const actionLayers = (options: Parameters<typeof operations>[0] & {
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
}) => {
  const ops = operations(options)
  return Layer.mergeAll(Collect.toLayer(({ spec }) => ops.collect(spec)), Assess.toLayer(ops.assess),
    ValidateReview.toLayer(({ evidence, review }) => review === null
      ? Effect.fail(new WikiError({ code: "review-failed", message: "Semantic validation requires a review" }))
      : ops.assess({ evidence, review, reviewer: null }).pipe(Effect.map(page => page.review!))),
    CheckCitations.toLayer(({ evidence, review }) => checkCitations(evidence, review).pipe(
      Effect.flatMap(citations => citations.verdict === "unsupported"
        ? Effect.fail(unsupportedCitations(evidence, citations)) : Effect.succeed({ review, citations }))
    )).pipe(Layer.provide(options.evaluator ?? evaluatorLayer(process.env))),
    Write.toLayer(({ pages, mode }) => ops.write(Object.keys(pages).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((key) => pages[key]!), mode)))
}
