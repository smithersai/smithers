/**
 * The compositions a review run needs: one for a real host, one for a test.
 *
 * The split is one seam wide. Everything above it — the flows, the actions, the
 * cell loop, the structured-output boundary — is identical in both. What
 * changes is where the run's state lives (a SQLite file or the process) and
 * what a declared seat resolves to (a live provider route or a scripted model).
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Registry from "@smthrs/registry/Registry"
import type * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { OpenCodeReviewInput } from "./openCodeReviewInputSchema.ts"
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  mergeFileBatchLayer,
  prepareReviewLayer,
  renderWalkthroughLayer
} from "./reviewActions.ts"
import { NarrateChanges, QuizChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts"
import { NarrateReview, Review, ReviewFiles, VerifyReview } from "./reviewFlow.ts"
import { modelCallEnvelope, modelCallRules } from "./reviewSeatResolver.ts"

/** The deadline fields shared by every model action payload. */
const deadlineInput = Schema.Struct({
  timeout: OpenCodeReviewInput.fields.timeout,
  path: Schema.optional(Schema.String)
})

/**
 * Interrupts the entire agent action, including resolution, retries and schema
 * corrections. The typed failure follows the flow's existing recovery arms.
 * Register after the original layer so both the requirement and the runtime
 * implementation table resolve to the bounded call.
 */
const withDeadline = <I, R>(action: {
  readonly requirement: Context.Service<I, Action.Implementation>
  readonly layer: Layer.Layer<I, never, R>
}) =>
  Layer.effect(action.requirement)(Effect.gen(function*() {
    const original = yield* action.requirement
    const bounded: Action.Implementation = {
      ...original,
      action: (payload) => Effect.suspend(() => {
        const { timeout, path } = Schema.decodeUnknownSync(deadlineInput)(payload)
        return original.action(payload).pipe(
          Effect.interruptible,
          Effect.timeoutOrElse({
            duration: Duration.minutes(timeout),
            orElse: () => Effect.fail(new HarnessError({
              code: "model_failed",
              message: `${path ?? original.name} timed out after ${timeout} minute(s).`
            }))
          })
        )
      })
    }
    const table = yield* Effect.serviceOption(Action.Implementations)
    if (Option.isSome(table)) yield* table.value.add(bounded, { override: true })
    return bounded
  })).pipe(Layer.provide(action.layer))

/**
 * Every action implementation and flow registration the review workflow needs,
 * before the agent host and the engine are supplied.
 *
 * @since 1.0.0
 * @category layers
 */
export const declarations = Layer.mergeAll(
  prepareReviewLayer,
  mergeFileBatchLayer,
  finalizeReviewLayer,
  applyVerdictsLayer,
  renderWalkthroughLayer,
  withDeadline(ReviewFile),
  withDeadline(VerifyFindings),
  withDeadline(NarrateChanges),
  withDeadline(QuizChanges),
  Interpreter.layer(Review),
  Interpreter.layer(ReviewFiles),
  Interpreter.layer(VerifyReview),
  Interpreter.layer(NarrateReview)
)

/**
 * The agent host: an empty catalog, an explicit cell budget, and the one
 * capability a review actually exercises.
 *
 * The review seats answer from the prompt they were given — every diff a
 * reviewer needs is embedded by `buildNativeReviewPrompt` — so the host offers
 * no tool flows. A cell that tries to reach for one finds an empty registry
 * rather than an unbounded surface on the repository under review.
 *
 * The envelope is the run's complete authority claim, so it names the model
 * hosts the seats can dial and nothing else. It is derived from the same
 * environment the seat resolver reads, which keeps the claim and the grant
 * rules in {@link layerNode} describing one set of origins.
 *
 * @since 1.0.0
 * @category layers
 */
export const agentHost = (environment: Readonly<Record<string, string | undefined>> = process.env) =>
  AgentAction.layerHost({
    registry: Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    }),
    limits: { calls: 8 },
    capabilityEnvelope: modelCallEnvelope(environment),
    maxFrames: 4
  })

/**
 * Review calls real providers, so reset-bearing refusals park and resume. The
 * review launcher has no approved plan budget envelope, so a numeric ceiling
 * here would be one no reviewer selected.
 */
// eslint-disable-next-line no-restricted-syntax -- no approved envelope exists, see above
const agentPolicy = Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())

/**
 * Builds the review workflow over a caller-supplied seat resolver and the
 * in-process engine.
 *
 * This is the composition the tests and the seeded-bug eval run: no SQLite
 * file, no credential, and every seat answered by whatever model the caller
 * passes.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerMemory = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  environment: Readonly<Record<string, string | undefined>> = process.env
) =>
  declarations.pipe(
    Layer.provideMerge(Layer.mergeAll(agentHost(environment), seats, Agent.layer)),
    Layer.provideMerge(agentPolicy),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

/**
 * Builds the review workflow over the durable Node runtime.
 *
 * The run's state lives in `filename`, so a review that dies mid-fan-out
 * resumes into the batches it had already settled instead of re-asking their
 * seats.
 *
 * `rules` is what makes the run able to call a model at all. The durable host
 * guards its HTTP client with the capability kernel, which asks `model:call`
 * on `<host>/<model id>` for every model request; a host built without a rule
 * for it parks the first request on a permission and, with `attended: false`,
 * nobody ever answers. `layerMemory` never meets the check because a scripted
 * seat builds no request, which is why this grant has to be tested through a
 * real route.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerNode = (options: {
  readonly filename: string
  readonly seats: Layer.Layer<SeatResolver.SeatResolver>
  /** The environment the reachable model hosts are read from. */
  readonly environment?: Readonly<Record<string, string | undefined>>
}) => {
  const environment = options.environment ?? process.env
  return NodeRuntime.layerHost(
    {
      filename: options.filename,
      workspaceRoot: process.cwd(),
      owner: { hostId: "smithers-review" },
      rules: modelCallRules(environment)
    },
    declarations.pipe(
      Layer.provideMerge(Layer.mergeAll(agentHost(environment), options.seats, Agent.layer)),
      Layer.provideMerge(agentPolicy),
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations)
    )
  )
}

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * Both review runtimes supply every service the workflow can require.
 *
 * @category models
 * @since 1.0.0
 */
export type CompositionRootsAreComplete = [
  Expect<Complete<ReturnType<typeof layerMemory>>>,
  Expect<Complete<ReturnType<typeof layerNode>>>
]
