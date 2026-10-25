import type { FlowEngineLike } from "@smthrs/agent"
import { FlowRuntime } from "@smthrs/flow"
import { Model, ModelError, ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { Cause, Config, Duration, Effect, Exit, type Layer, Metric, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import { MODEL_ROUTE, type ModelRole } from "../src/features/model/contract.ts"
import { OWN_MODEL_ROLES } from "../src/features/personal-model/contract.ts"
import { canAsk, Sessions } from "./Actor.ts"
import { codeOf } from "./ErrorCode.ts"
import { FlowStarter } from "./Flows.ts"
import * as ModelRoles from "./ModelRoles.ts"
import * as ModelSpend from "./ModelSpend.ts"
import * as ModelUsage from "./ModelUsage.ts"
import { PersonalModels, PersonalModelUnusable } from "./personal/Models.ts"
import * as PersonalUsage from "./personal/Usage.ts"

// The metered model endpoint (docs/features/model-endpoint.md): every model call the browser's agent makes is one
// `POST /api/model/<role>`, served by `ModelProxy.serve` from @smthrs/model. Before the model runs it refuses a
// signed-out request and one from a person who may not ask (a Guest, or no role), bounds the request, picks the role's
// model and reserves the call's worst case against the deployment's daily budget; after, it settles the reservation to
// what the call spent. A person who saved a model of their own (docs/features/personal-model.md) is answered by it
// instead, with their key, outside the budget, and their call is kept in their own ledger. The key never leaves the
// Worker, and refusals carry codes, never provider text.

/** The deployment's token budget per UTC day, input and output together, when `MODEL_DAILY_TOKEN_BUDGET` is unset. */
export const DAILY_TOKEN_BUDGET = 1_000_000

/** The most output tokens one call may ask for when `MODEL_MAX_OUTPUT_TOKENS` is unset. */
export const MAX_OUTPUT_TOKENS = 8_000

/** The most messages one call may send when `MODEL_MAX_MESSAGES` is unset. */
export const MAX_MESSAGES = 200

/**
 * The largest request body, in bytes, when `MODEL_MAX_REQUEST_BYTES` is unset: 192 KiB. It is the prompt's token cap
 * too, because a call reserves each byte as a token. The agent compacts against a 32,768-token window
 * (`CONTEXT_WINDOW_TOKENS`, src/features/agent/host.ts), about 128 KiB of text at four bytes a token, and its JSON
 * body adds field names and escapes, so a smaller bound would refuse requests the agent counts as fitting.
 */
export const MAX_REQUEST_BYTES = 192 * 1024

/**
 * How long a call's reservation lasts before it is final, when `MODEL_RESERVATION_EXPIRY` is unset: an hour. A
 * reservation that never settles (its Worker died, or its settle never ran) counts in full either way; past its expiry,
 * a late settle can't refund it. The longest call the caps allow writes 16,000 tokens (`MAX_OUTPUT_TOKENS` of output
 * and as many of thinking), about 27 minutes at 10 tokens a second, so an hour leaves every call time to settle.
 */
export const RESERVATION_EXPIRY = Duration.hours(1)

/**
 * Settles of a served call's reservation, by `outcome`: `recorded` (settled to what it spent), `refused` (the provider
 * refused it before any output, so it settled to the usage the provider reported, 0 when none), `kept` (its usage was
 * unknown, so it keeps its reservation), `expired` (it ended after its reservation expired, so it stays charged in
 * full) or `error`.
 */
export const usageWrites = Metric.counter("smithers_model_usage_writes", {
  description: "Model usage settled after served calls, by outcome",
  incremental: true,
})

const positive = Schema.Int.check(Schema.isGreaterThan(0))

const refuse = (status: number, code: ModelProxy.Refusal["code"], message: string) =>
  new ModelProxy.Refusal({ status, code, message })

const unavailable = refuse(503, "provider_internal", "Smithers can't reach its database. Try again.")

// A role whose model can't be used here is a setting to change, not an outage to wait out: a 4xx, which a caller's
// model step seals as its answer. A 503 was a capacity refusal to the step, which the engine retried six times.
const noRoute = refuse(409, "no_route", "This model isn't available.")

// A person's own model that can't answer here is theirs to save again; it never falls back to the deployment's model.
const ownUnusable = refuse(409, "no_route", "Your model can't be used. Save it again in Settings.")

const INVALID_CAPS = "Send maxTokens as a whole number above 0 and thinkingBudget as a whole number of at least 0."

/**
 * Reads `MODEL_DAILY_TOKEN_BUDGET`, `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_MAX_MESSAGES`, `MODEL_MAX_REQUEST_BYTES`,
 * `MODEL_RESERVATION_EXPIRY`, `SUMMARY_MODEL` and the deployment's default model (`HostModel`) at build time, and
 * returns what admits and meters one call on a role: `admit` bounds the request,
 * picks the person's own model or the role's and, for the role's, reserves the call's worst case; `meter` settles a
 * reservation, and `meterOwn` a person's own call. The endpoint (`make`) and a server flow's own calls (`local`) share
 * them, so every call the deployment pays for spends one budget.
 * `database` opens a Postgres client for each read and write.
 */
const metering = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const budget = yield* Config.schema(positive, "MODEL_DAILY_TOKEN_BUDGET").pipe(
      Config.withDefault(DAILY_TOKEN_BUDGET),
    )
    const maxOutputTokens = yield* Config.schema(positive, "MODEL_MAX_OUTPUT_TOKENS").pipe(
      Config.withDefault(MAX_OUTPUT_TOKENS),
    )
    const maxMessages = yield* Config.schema(positive, "MODEL_MAX_MESSAGES").pipe(Config.withDefault(MAX_MESSAGES))
    const maxBodyBytes = yield* Config.schema(positive, "MODEL_MAX_REQUEST_BYTES").pipe(
      Config.withDefault(MAX_REQUEST_BYTES),
    )
    const expiry = yield* Config.Duration("MODEL_RESERVATION_EXPIRY").pipe(Config.withDefault(RESERVATION_EXPIRY))
    // Alchemy binds settings read while the program builds; keep a bad value as a per-call refusal.
    const summary = yield* ModelRoles.summaryModel.pipe(
      Effect.mapError(() => new HostModelUnusable({ reason: "config" })),
      Effect.result,
    )
    const fallback = yield* HostModel

    /** Logs why the endpoint couldn't serve a role, by code only. */
    const logFailure = (role: ModelRole, errorCode: string) =>
      Effect.logError("model.endpoint").pipe(Effect.annotateLogs({ role, errorCode }))

    /**
     * What the caller may choose (the conversation, its tools and parameters within bounds) and the model that answers:
     * the person's own when `personId` saved one (`PersonalModels`), with its call's ledger row written, else the role's,
     * once the call's worst case is reserved against the deployment's budget: its body's bytes, each counted as a
     * prompt token, plus its output and thinking caps. The reservation or the ledger row is the last step, so no refusal
     * after it leaves one behind. `own` is the person's call, when their model answers it.
     */
    const admit = (role: ModelRole, personId?: string) =>
    (
      request: ModelRequest.ModelRequest,
      admission: ModelProxy.Admission,
    ): Effect.Effect<Admitted, ModelProxy.Refusal, R | PersonalModels> =>
      Effect.gen(function* () {
        if ((request.serverTools?.length ?? 0) > 0) {
          return yield* refuse(400, "invalid_request", "Send no provider-run tools.")
        }
        if (request.messages.length === 0) return yield* refuse(400, "invalid_request", "Send at least one message.")
        if (request.messages.length > maxMessages) {
          return yield* refuse(400, "invalid_request", `Send at most ${maxMessages} messages.`)
        }
        // The reservation counts both caps, so each must be a whole number of tokens: a negative or fractional one
        // would shrink the reservation while the provider still spends (Opus review 4, P2-1).
        const { maxTokens: askedTokens, thinkingBudget: askedThinking } = request.params
        if (
          (askedTokens !== undefined && !(Number.isInteger(askedTokens) && askedTokens > 0)) ||
          (askedThinking !== undefined && !(Number.isInteger(askedThinking) && askedThinking >= 0))
        ) {
          return yield* refuse(400, "invalid_request", INVALID_CAPS)
        }
        const maxTokens = Math.min(askedTokens ?? maxOutputTokens, maxOutputTokens)
        const thinkingBudget = askedThinking === undefined ? undefined : Math.min(askedThinking, maxOutputTokens)
        const params = ModelRequest.GenerationParams.make({
          ...request.params,
          maxTokens,
          ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
        })
        const opened = personId === undefined ? Option.none() : yield* (yield* PersonalModels).open(personId).pipe(
          Effect.tapError((error) =>
            logFailure(role, error instanceof PersonalModelUnusable ? `own_unusable:${error.reason}` : error.errorCode)
          ),
          Effect.mapError((error) => error instanceof PersonalModelUnusable ? ownUnusable : unavailable),
        )
        if (Option.isSome(opened)) {
          const own: PersonalUsage.Call = {
            invocationId: admission.invocationId,
            requestId: admission.requestId,
            personId: personId!,
            role,
            modelId: opened.value.modelId,
            host: opened.value.host,
          }
          yield* PersonalUsage.begin(own).pipe(
            Effect.provide(database),
            Effect.tapError((error) =>
              Effect.andThen(
                Metric.update(Metric.withAttributes(PersonalUsage.errors, { op: "begin" }), 1),
                logFailure(role, codeOf(error)),
              )
            ),
            Effect.mapError(() => unavailable),
          )
          return {
            own,
            prepared: {
              model: opened.value.model,
              request: ModelRequest.ModelRequest.make({ ...request, modelId: opened.value.modelId, params }),
            },
          } satisfies Admitted
        }
        const resolved = yield* ModelRoles.resolve(role, summary).pipe(
          Effect.provide(database),
          Effect.provideService(HostModel, fallback),
          Effect.tapError((error) =>
            logFailure(role, error instanceof HostModelUnusable ? `unusable:${error.reason}` : codeOf(error))
          ),
          Effect.mapError((error) => error instanceof HostModelUnusable ? noRoute : unavailable),
        )
        const reserved = yield* ModelUsage.reserve({
          invocationId: admission.invocationId,
          requestId: admission.requestId,
          role,
          modelId: resolved.modelId,
          tokens: admission.requestBytes + maxTokens + (thinkingBudget ?? 0),
        }, { budget, expiry }).pipe(
          Effect.provide(database),
          Effect.tapError((error) => logFailure(role, codeOf(error))),
          Effect.mapError(() => unavailable),
        )
        if (!reserved) return yield* refuse(429, "quota_exceeded", "Today's model budget is spent.")
        return {
          prepared: {
            model: resolved.model,
            request: ModelRequest.ModelRequest.make({ ...request, modelId: resolved.modelId, params }),
          },
        } satisfies Admitted
      })

    /**
     * Settles a served call's reservation, whether it succeeded, failed or lost its client. A call that ended normally
     * with both counts reported settles to them. A call the provider refused before any output (`rate_limited`, or a
     * provider 4xx: `ModelProxy.refusedCleanly`) spent nothing beyond what the provider reported, so it settles to
     * that, 0 when none (`refused`). Any other usage is unknown, never zero: a call that failed or lost its client may
     * have spent tokens the model never reported, so it keeps its reservation (`kept`). A call that ends after its
     * reservation expired stays charged in full (`expired`). A failed write is logged and counted, never raised into
     * the response, and leaves the reservation counted. First it records what the model reported the call spent, by
     * role and model (`ModelSpend.record`).
     */
    const meter = (role: ModelRole) => (end: ModelProxy.End) => {
      const { inputTokens, outputTokens } = end.usage
      const reported = inputTokens !== undefined && outputTokens !== undefined
        ? "complete"
        : inputTokens !== undefined || outputTokens !== undefined
        ? "partial"
        : "none"
      const refused = ModelProxy.refusedCleanly(end)
      const complete = (end.outcome === "success" && reported === "complete") || refused
      const ids = { role, invocationId: end.invocationId, requestId: end.requestId }
      const failure = end.errorCode === undefined ? {} : { errorCode: end.errorCode }
      const record = (settled: boolean) => {
        const outcome = !settled ? "expired" : refused ? "refused" : complete ? "recorded" : "kept"
        const counted = Metric.update(Metric.withAttributes(usageWrites, { outcome }), 1)
        if (outcome === "recorded") return counted
        const line = outcome === "expired"
          ? Effect.logWarning("model.usage").pipe(
            Effect.annotateLogs({ ...ids, outcome, ended: end.outcome, ...failure }),
          )
          : Effect.logInfo("model.usage").pipe(
            Effect.annotateLogs({ ...ids, outcome, ended: end.outcome, reported, ...failure }),
          )
        return Effect.andThen(counted, line)
      }
      return Effect.andThen(
        ModelSpend.record(role, end),
        ModelUsage.settle({ invocationId: end.invocationId, inputTokens, outputTokens, complete }),
      ).pipe(
        Effect.provide(database),
        Effect.flatMap(record),
        Effect.catchCause((cause) =>
          Effect.andThen(
            Metric.update(Metric.withAttributes(usageWrites, { outcome: "error" }), 1),
            Effect.logError("model.usage").pipe(
              Effect.annotateLogs({ ...ids, errorCode: codeOf(Cause.squash(cause)) }),
            ),
          )
        ),
      )
    }

    /** Settles a person's own call (`PersonalUsage.end`): never the deployment's budget, ledger or spend. */
    const meterOwn = (own: PersonalUsage.Call) => (end: ModelProxy.End) => PersonalUsage.end(own, end, database)

    return { admit, meter, meterOwn, maxBodyBytes, logFailure, budget }
  })

/** An admitted call: what the model is asked, and the person's own call when their model answers it. */
interface Admitted {
  readonly prepared: ModelProxy.Prepared
  readonly own?: PersonalUsage.Call
}

/**
 * The model endpoint's handler for one role, `POST /api/model/<role>`: it refuses a signed-out request and one from a
 * person who may not ask (a Guest, or no role), then admits and meters the call (`metering`). Each admitted call starts
 * its window's spend alert through `Flows.FlowStarter` (`ModelSpend.alerter`, docs/features/spend-alerts.md): on unless
 * `MODEL_SPEND_ALERTS` says otherwise, whose default is `alerts`, on unless set.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, meter, meterOwn, maxBodyBytes, logFailure, budget } = yield* metering(database)
    const alert = yield* ModelSpend.alerter(
      yield* ModelSpend.settings(options.alerts === undefined ? {} : { on: options.alerts }),
      budget,
    )
    /**
     * Who may ask (`repo:ask`, decision 0007), then the call's admission, answered by the person's own model when they
     * saved one and the role is theirs to pay for (`OWN_MODEL_ROLES`: not the timeline's summaries). Only a call the
     * deployment pays for starts a spend alert.
     */
    const prepare = (role: ModelRole) => (request: ModelRequest.ModelRequest, admission: ModelProxy.Admission) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const actor = yield* sessions.resolve.pipe(
          Effect.tapError((error) => logFailure(role, codeOf(error))),
          Effect.mapError(() => unavailable),
        )
        if (Option.isNone(actor)) {
          return yield* refuse(401, "authentication", "Sign in to ask Smithers.")
        }
        // Asking is `repo:ask`, Member or above (decision 0007). `ModelError` has no permission code, so a refusal of
        // a signed-in person is `authentication` with 403, as a provider's 403 classifies.
        if (!canAsk(actor.value)) {
          return yield* refuse(403, "authentication", "Asking Smithers needs the Member role.")
        }
        const admitted = yield* admit(role, OWN_MODEL_ROLES.includes(role) ? actor.value.subject.id : undefined)(
          request,
          admission,
        )
        if (admitted.own === undefined) yield* alert
        return admitted
      })

    /**
     * `POST /api/model/<role>`: one served model call, settled where it was admitted: a person's own call in their
     * ledger, any other against the deployment's budget.
     */
    return (role: ModelRole) =>
      Effect.suspend(() => {
        let own: PersonalUsage.Call | undefined
        return ModelProxy.serve({
          prepare: (request, admission) =>
            Effect.map(prepare(role)(request, admission), (admitted) => {
              own = admitted.own
              return admitted.prepared
            }),
          maxBodyBytes,
          attributes: { role },
          onEnd: (end) => own === undefined ? meter(role)(end) : meterOwn(own)(end),
        })
      })
  })

/** A model a server flow calls with, and the route its durable step keys on (`ModelStep.model` from `@smthrs/agent`). */
export interface Seat {
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
}

/** A refusal of a server flow's own call, as the model error its caller reads: the endpoint's code and status. */
const refusedCall = (refusal: ModelProxy.Refusal) =>
  new ModelError.ModelError({ code: refusal.modelErrorCode, message: refusal.message, httpStatus: refusal.status })

/**
 * The model a flow running on the server calls `role` with, in process: each call is admitted and metered exactly as the
 * endpoint's (`metering`), against the same daily budget and ledger, so a flow no person's device runs (triage on a new
 * issue, decision 0012 §5) spends what a person's call would. It skips the endpoint's who-may-ask check: the flow that
 * calls it was admitted under a person's role, which it re-checks itself. Its step keys on the endpoint's request
 * (`ModelProxy.prepare`), so a resumed run replays the sealed call instead of paying for it again. A refusal fails the
 * stream as a `ModelError` with the endpoint's code: `quota_exceeded` once the day's budget is spent.
 *
 * Given `starter`, where the host starts a flow, each admitted call also starts its window's spend alert, as the
 * endpoint's calls do (`ModelSpend.alerter`, docs/features/spend-alerts.md): a window whose only spend is a `todo` run's
 * agent or triage's judge alerts too. `alerts` is `MODEL_SPEND_ALERTS`' default, on unless set, as `make`'s is.
 *
 * Given `owner`, a call made inside a run (`FlowRuntime.FlowInstance`) whose owner saved a model of their own is
 * answered by that model and kept in their ledger, as their endpoint calls are (docs/features/personal-model.md): a
 * `todo` run works on its committer's key while every device is off. Its refusal fails at once, never falling back.
 */
export const local = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, meter, meterOwn, maxBodyBytes, budget } = yield* metering(database)
    const alert = yield* ModelSpend.alerter(
      yield* ModelSpend.settings(options.alerts === undefined ? {} : { on: options.alerts }),
      budget,
    )
    // What the database layer needs, and the people's own models, captured here, so a model call needs nothing of its
    // caller.
    const context = yield* Effect.context<R | PersonalModels>()
    return (role: ModelRole, starter?: FlowStarter["Service"], owner?: Owner<R>): Seat => {
      const prepare = ModelProxy.prepare({ url: `${MODEL_ROUTE}/${role}` })
      const call = (request: ModelRequest.ModelRequest, executionId: string | undefined) =>
        Effect.gen(function* () {
          // The endpoint's id for a call is its own, never the caller's; so is this one.
          const invocationId = crypto.randomUUID()
          const encoded = yield* prepare(request)
          if (encoded.body.byteLength > maxBodyBytes) {
            return yield* new ModelError.ModelError({ code: "invalid_request", message: "The request is too large.", httpStatus: 413 })
          }
          // The person whose run this is, when `owner` names one: their own model answers it, as it answers their chat.
          const personId = owner === undefined || executionId === undefined || !OWN_MODEL_ROLES.includes(role)
            ? Option.none<string>()
            : yield* owner(executionId).pipe(
              Effect.mapError(() =>
                new ModelError.ModelError({ code: "provider_internal", message: "Smithers can't reach its database." })
              ),
            )
          const admission = { requestId: invocationId, invocationId, requestBytes: encoded.body.byteLength }
          const admitted = yield* admit(role, Option.getOrUndefined(personId))(request, admission).pipe(
            Effect.mapError(refusedCall),
          )
          const { prepared, own } = admitted
          if (own === undefined && starter !== undefined) yield* alert.pipe(Effect.provideService(FlowStarter, starter))
          // What the model reported, merged as `ModelEvent.settledMessage` merges it: a `retry` event starts it over.
          let usage: ModelEvent.Usage = {}
          // Whether the model sent any output, which tells a refusal (that spent nothing) from a failure that may have.
          let produced = false
          return prepared.model.stream(prepared.request).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                usage = ModelEvent.settledMessage([{ type: "usage", ...usage }, event]).usage
                produced ||= ModelProxy.producesOutput(event)
              })
            ),
            Stream.onExit((exit) => {
              const end: ModelProxy.End = {
                requestId: invocationId,
                invocationId,
                modelId: prepared.request.modelId,
                usage,
                produced,
                ...(Exit.isSuccess(exit)
                  ? { outcome: "success" as const }
                  : Cause.hasInterruptsOnly(exit.cause)
                  ? { outcome: "interrupted" as const }
                  : { outcome: "failed" as const, ...ModelProxy.failureOf(exit.cause) }),
              }
              return own === undefined ? meter(role)(end) : meterOwn(own)(end)
            }),
          )
        }).pipe(Effect.provideContext(context))
      return {
        model: Model.make({
          // The run calling, read before the captured context replaces the caller's: its owner's model answers it.
          stream: (request) =>
            Stream.unwrap(
              Effect.map(
                Effect.serviceOption(FlowRuntime.FlowInstance),
                (instance) =>
                  Stream.unwrap(call(request, Option.getOrUndefined(Option.map(instance, (run) => run.executionId))))
                    .pipe(Stream.provideContext(context)),
              ),
            ),
        }),
        route: { prepare },
      }
    }
  })

/**
 * The person a server flow's run is for, by its execution id: a `todo` run's is the person who committed the TODO
 * (`TodoMachine.ownerOf`). None for a run that is nobody's, such as triage, which the deployment pays for.
 */
export type Owner<R = never> = (executionId: string) => Effect.Effect<Option.Option<string>, unknown, R>
