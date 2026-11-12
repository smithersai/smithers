/**
 * Review a code snippet and propose a patch with Kimi K2 served by dstack on your own GPUs.
 *
 * Port of the 0.x `dstack/workflow.jsx`. A reviewer agent critiques the
 * snippet and scores it from 0 to 100; a fixer agent then writes one minimal
 * unified diff for the review's medium- and high-severity issues. Both agents
 * sit in the `dstack:kimi-k2` seat, which a live host resolves to the vLLM
 * service dstack runs, over its OpenAI-compatible Chat Completions endpoint.
 *
 * dstack still provisions the GPUs and serves the model; 0.x's `kimi.dstack.yml`, `fleet.dstack.yml` and `scripts/print-env.sh` are not flows and stay out.
 * 0.x pointed the AI SDK's `createOpenAI` at the endpoint; here {@link endpointSeats} resolves the seat to `Route.openaiChatCompatible`, as `13-agent-live-smoke-local.ts` does for Ollama.
 */
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { executorLayer } from "../13-agent-live-smoke-local.ts"

/** The seat both agents sit in: the model name vLLM serves (`--served-model-name kimi-k2`). */
export const seat = "dstack:kimi-k2"

/** The context window the service allows (`--max-model-len 32768`). */
export const contextWindowTokens = 32_768

/** One issue the reviewer found. */
export const Issue = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high"]),
  area: Schema.String,
  description: Schema.String
})

/** The reviewer's critique. 100 is production-ready. */
export const Review = Schema.Struct({
  summary: Schema.String,
  issues: Schema.Array(Issue),
  overallScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
})

/** The fixer's patch. */
export const Patch = Schema.Struct({
  rationale: Schema.String,
  unifiedDiff: Schema.String
})

/** What the flow settles with. */
export const Output = Schema.Struct({ review: Review, patch: Patch })

/** Critiques the snippet. */
export const ReviewSnippet = AgentAction.make("examples/Dstack/Review", {
  payload: { filename: Schema.String, code: Schema.String },
  output: Review,
  seat,
  system: [
    `You are a senior code reviewer. Given a code snippet, identify
real bugs, design issues, and obvious smells. Be specific. Score 0-100 where 100
is production-ready.`
  ],
  prompt: ({ code, filename }) => `Review this code snippet from ${filename}:\n\n\`\`\`\n${code}\n\`\`\``
})

/** Writes one diff for every issue above `low`, in the order the review listed them. */
export const ProposePatch = AgentAction.make("examples/Dstack/Patch", {
  payload: { filename: Schema.String, code: Schema.String, issues: Schema.Array(Issue) },
  output: Patch,
  seat,
  system: [
    `You are a careful refactorer. Given a snippet and a list of
issues, produce a single unified diff that addresses the highest-severity
issues. Keep the diff minimal — do not rewrite unrelated code.`
  ],
  prompt: ({ code, filename, issues }) =>
    `Original snippet (${filename}):\n\n\`\`\`\n${code}\n\`\`\`\n\nIssues to address (highest severity first):\n${
      issues
        .filter((issue) => issue.severity !== "low")
        .map((issue) => `- [${issue.severity}] ${issue.area}: ${issue.description}`)
        .join("\n")
    }\n\nReturn a minimal unified diff.`
})

/** The flow: review, then patch what the review found. */
export const Dstack = Flow.make("examples/Dstack", {
  payload: { filename: Schema.optional(Schema.String), code: Schema.String },
  success: Output,
  error: AgentAction.AgentFailure,
  body: Node.capture({}, ({ code, filename = "input.ts" }) =>
    Node.bindPlanned(
      ReviewSnippet.call({ filename, code }),
      Node.capture({ filename, code }, (review: Planned.Planned<typeof Review.Type>) =>
        Node.bindPlanned(
          ProposePatch.call({ filename, code, issues: review.issues }),
          Node.capture({}, (patch: Planned.Planned<typeof Patch.Type>) => Node.succeed({ review, patch }))
        ))
    ))
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(ReviewSnippet.layer, ProposePatch.layer)

/** Where dstack serves the model: the service's `/v1` URL and a dstack user token. */
export interface Endpoint {
  readonly baseUrl: string
  readonly apiKey: string
}

/** Reads the endpoint from `KIMI_BASE_URL` and `KIMI_API_KEY`, and throws, as 0.x did, when either is missing. */
export const endpointFromEnv = (env: Readonly<Record<string, string | undefined>>): Endpoint => {
  const baseUrl = env["KIMI_BASE_URL"]
  const apiKey = env["KIMI_API_KEY"]
  if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
    throw new Error(
      "Set KIMI_BASE_URL to the dstack service's /v1 URL and KIMI_API_KEY to a dstack user token (`dstack run get kimi-k2 --json` lists the URL)."
    )
  }
  return { baseUrl, apiKey }
}

/**
 * The route to the service: Chat Completions at `<baseUrl>/chat/completions`,
 * bearer-authenticated with the dstack token, which the dstack gateway accepts.
 */
export const route = (endpoint: Endpoint) =>
  Route.openaiChatCompatible({
    id: "dstack",
    providerName: "dstack",
    baseUrl: endpoint.baseUrl,
    path: "/chat/completions",
    apiKey: Redacted.make(endpoint.apiKey)
  })

/** Resolves every seat to the model the endpoint serves, sending requests through the host's `RequestExecutor`. */
export const endpointSeats = (endpoint: Endpoint) =>
  Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function*() {
      const executor = yield* RequestExecutor.RequestExecutor
      return SeatResolver.make({
        resolve: (id) =>
          Effect.gen(function*() {
            const config = yield* Effect.fromResult(route(endpoint)).pipe(
              Effect.mapError((error) => new Seat.SeatUnresolved({ seat: id, message: error.message }))
            )
            const model = yield* Route.toModel(config).pipe(
              Effect.provideService(RequestExecutor.RequestExecutor, executor)
            )
            return Seat.make({
              id,
              modelId: Seat.modelIdOf(id),
              model,
              route: FlowEngineLike.routeResolver(config),
              contextWindowTokens
            })
          })
      })
    })
  )

/** The two services a live host may replace. */
export interface LiveOptions {
  /** Sends model requests. Defaults to the guarded egress client of `13-agent-live-smoke-local.ts`. */
  readonly executor?: Layer.Layer<RequestExecutor.RequestExecutor>
  /** Judges each step's completion. Defaults to the endpoint's own seat. */
  readonly judge?: Layer.Layer<Evaluator.Evaluator>
}

/**
 * The live composition: the flow's steps over seats on the endpoint, journaled
 * durably in `database` so a run interrupted while the service scales resumes
 * from its last finished step.
 */
export const liveLayer = (endpoint: Endpoint, database: string, options: LiveOptions = {}) => {
  const seats = endpointSeats(endpoint).pipe(Layer.provide(options.executor ?? executorLayer))
  const judge = options.judge ?? Layer.unwrap(Effect.gen(function*() {
    const resolver = yield* SeatResolver.SeatResolver
    return Evaluator.layerFromSeat(yield* resolver.resolve(seat))
  })).pipe(Layer.provide(seats))
  return Layer.mergeAll(layer, Interpreter.layer(Dstack)).pipe(
    Layer.provideMerge(Layer.mergeAll(
      AgentAction.layerHost({
        registry: Registry.makeNoop({
          list: () => Effect.succeed([]),
          visible: () => Effect.succeed([]),
          getOption: () => Effect.succeed(Option.none())
        }),
        limits: { calls: 10 },
        capabilityEnvelope: [],
        maxFrames: 8
      }),
      seats,
      Agent.layer
    )),
    // A served model can still name a reset, so honor it. This standalone run
    // has no approved plan envelope from which to derive a ceiling.
    // eslint-disable-next-line no-restricted-syntax -- this standalone run has no approved envelope
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(judge),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TestNodeRuntime.durableEngine(database, "examples-dstack"))
  )
}

/** Reviews and patches one snippet against the endpoint `env` names. */
export const main = (
  input: typeof Dstack.payloadSchema.Type,
  env: Readonly<Record<string, string | undefined>> = process.env,
  database = "dstack.sqlite"
) =>
  Effect.suspend(() =>
    Effect.scoped(
      Dstack.execute(input, { executionId: `dstack-${Date.now()}` }).pipe(
        Effect.provide(liveLayer(endpointFromEnv(env), database))
      )
    )
  )

if (import.meta.url === `file://${process.argv[1]}`) {
  Effect.runPromise(main(JSON.parse(process.argv[2] ?? "{}"))).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error("FAILED:", error)
      process.exitCode = 1
    }
  )
}
