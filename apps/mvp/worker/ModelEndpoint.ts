import { finalFailure } from "./ModelRefusal.ts"
import type { FlowEngineLike } from "@smthrs/agent"
import { FlowRuntime } from "@smthrs/flow"
import { Model, ModelError, ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { Cause, Config, Duration, Effect, Exit, type Layer, Metric, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import { MODEL_ROUTE, type ModelRole } from "../src/features/model/contract.ts"
import { canAsk, Sessions } from "./Actor.ts"
import { codeOf } from "./ErrorCode.ts"
import { FlowStarter } from "./Flows.ts"
import * as HostedModel from "./HostedModel.ts"
import * as ModelRoles from "./ModelRoles.ts"
import * as ModelSpend from "./ModelSpend.ts"
import * as ModelTiers from "./ModelTiers.ts"
import * as ModelUsage from "./ModelUsage.ts"
import { PersonalModels, PersonalModelUnusable } from "./personal/Models.ts"
import * as PersonalUsage from "./personal/Usage.ts"

// The metered model endpoint (docs/features/model-endpoint.md): every model call the browser's agent makes is one
// `POST /api/model/<role>`, served by `ModelProxy.serve` from @smthrs/model. Before the model runs it refuses a
// signed-out request and bounds the request. Each role maps to a tier and an effort (`ModelTiers`, decision 0107). A
// person who saved a key of their own (docs/features/personal-model.md) is answered by the model the role's tier
// resolves to among their keys, with that key, outside the budget, and their call is kept in their own ledger: anyone
// signed in, since where they may ask ChatApi decides by their role on each conversation's repository (ruling AUTH-8).
// Anyone else is answered by the role's deployment model only while hosted inference is on (`HostedModel`, decision
// 0099), and only as a Member or above of the deployment's own repository, whose spend the deployment's owner pays: it
// reserves the call's worst case against the deployment's daily budget and settles the reservation to what the call
// spent. Otherwise the call is refused, never answered on the deployment's model. The key never leaves the Worker, and refusals carry codes, never provider text.

/** `params` with `effort` set on them; unchanged when there is none. */
const withEffort = (params: ModelRequest.GenerationParams, effort: ModelRequest.ReasoningEffort | undefined) =>
  effort === undefined ? params : ModelRequest.GenerationParams.make({ ...params, reasoningEffort: effort })

/** Terminal model quota and credit refusals, with no provider text or credentials. */
export const quotaRefusals = Metric.counter("smithers_model_quota_refusals", { incremental: true })

const recordRefusal = (role: ModelRole, error: Model.ModelFailure) => {
  if (!(error instanceof ModelError.ModelError) || (error.code !== "quota_exceeded" && error.code !== "out_of_credit")) {
    return Effect.void
  }
  const attributes = { role, errorCode: error.code, httpStatus: error.httpStatus ?? 0 }
  return Effect.andThen(
    Metric.update(Metric.withAttributes(quotaRefusals, { role, errorCode: error.code }), 1),
    Effect.logWarning("model.quota.refused").pipe(Effect.annotateLogs(attributes)),
  ).pipe(Effect.withSpan("model.quota.refused", { attributes }))
}

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

// Hosted inference is off (decision 0099): a person without a model of their own adds one; nobody's call is refused.
const hostedOff = refuse(409, "no_route", "Add your model in Settings to ask Smithers.")

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
const metering = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, hostedFallback = false) =>
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
    // Whether the deployment's model answers when no Admin set it; a value that doesn't parse is off.
    const hostedDefault = yield* HostedModel.hostedModelDefault(hostedFallback).pipe(Effect.orElseSucceed(() => false))
    // Alchemy binds settings read while the program builds; keep a bad value as a per-call refusal.
    const defaults: ModelRoles.Defaults = {
      summary: yield* ModelRoles.summaryModel.pipe(
        Effect.mapError(() => new HostModelUnusable({ reason: "config" })),
        Effect.result,
      ),
      tiers: yield* ModelRoles.tierModels.pipe(
        Effect.mapError(() => new HostModelUnusable({ reason: "config" })),
        Effect.result,
      ),
    }
    // Which tier answers each role; a value that doesn't parse leaves the defaults, logged once.
    const routes = yield* ModelTiers.roleTiers.pipe(
      Effect.tapError((error) =>
        Effect.logError("model.endpoint").pipe(Effect.annotateLogs({ errorCode: `role_tiers:${codeOf(error)}` }))
      ),
      Effect.orElseSucceed(() => ModelTiers.ROLE_TIERS),
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
     * after it leaves one behind. `own` is the person's call, when their model answers it. `deploymentPays` says whether
     * the deployment's model may answer a call no model of the person's own does: only a Member or above of the
     * deployment's own repository's, or nobody's (ruling AUTH-8).
     */
    const admit = (role: ModelRole, personId?: string, deploymentPays = true) =>
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
        const route = routes[role]
        const opened = personId === undefined ? Option.none() : yield* (yield* PersonalModels).open(personId, route.tier).pipe(
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
            protocol: opened.value.protocol,
            tier: opened.value.tier,
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
              request: ModelRequest.ModelRequest.make({
                ...request,
                modelId: opened.value.modelId,
                params: withEffort(params, yield* ModelTiers.effortFor(role, route, request, opened.value.modelId)),
              }),
            },
          } satisfies Admitted
        }
        // No model of the person's own: the deployment's answers only its own Members (ruling AUTH-8), and only while
        // hosted inference is on.
        if (!deploymentPays) {
          yield* logFailure(role, "hosted_members_only")
          return yield* hostedOff
        }
        const hosted = yield* HostedModel.enabled(hostedDefault).pipe(
          Effect.provide(database),
          Effect.tapError((error) => logFailure(role, codeOf(error))),
          Effect.mapError(() => unavailable),
        )
        if (!hosted) {
          yield* logFailure(role, "hosted_off")
          return yield* hostedOff
        }
        const resolved = yield* ModelRoles.resolve(role, route.tier, defaults).pipe(
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
            model: Model.Model.of({
              ...resolved.model,
              stream: (request) => resolved.model.stream(request).pipe(
                Stream.mapError(finalFailure),
                Stream.tapError((error) => recordRefusal(role, error)),
              ),
            }),
            request: ModelRequest.ModelRequest.make({
              ...request,
              modelId: resolved.modelId,
              // The record's effort when it sets one, else the role's hint where the model takes one.
              params: withEffort(
                params,
                yield* ModelTiers.effortFor(role, route, request, resolved.modelId, resolved.reasoningEffort),
              ),
            }),
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
        ModelUsage.settle({
          invocationId: end.invocationId,
          inputTokens,
          outputTokens,
          complete,
          ended: {
            outcome: end.outcome === "success"
              ? "answered"
              : end.outcome === "interrupted"
              ? "aborted"
              : refused
              ? "refused"
              : "failed",
            ...(end.errorCode === undefined ? {} : { errorCode: end.errorCode }),
            ...(end.httpStatus === undefined ? {} : { httpStatus: end.httpStatus }),
          },
        }),
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
 * The model endpoint's handler for one role, `POST /api/model/<role>`: it refuses a signed-out request, then admits and
 * meters the call (`metering`). Each admitted call starts
 * its window's spend alert through `Flows.FlowStarter` (`ModelSpend.alerter`, docs/features/spend-alerts.md): on unless
 * `MODEL_SPEND_ALERTS` says otherwise, whose default is `alerts`, on unless set.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean; readonly hosted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, meter, meterOwn, maxBodyBytes, logFailure, budget } = yield* metering(database, options.hosted)
    const alert = yield* ModelSpend.alerter(
      yield* ModelSpend.settings(options.alerts === undefined ? {} : { on: options.alerts }),
      budget,
    )
    /**
     * Anyone signed in, then the call's admission, answered by the person's own model when they saved one, whatever the
     * role, the timeline's summaries included (decision 0099), and by the deployment's model only for a Member or above
     * of its own repository, the session's role (ruling AUTH-8). Only a call the deployment pays for starts a spend
     * alert.
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
        // The session's role is the one on the deployment's own repository: its Members' calls are the deployment's to
        // pay for when they have no model of their own.
        const admitted = yield* admit(role, actor.value.subject.id, canAsk(actor.value))(request, admission)
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
 * stream as a `ModelError` with the endpoint's code: `quota_exceeded` once the day's budget is spent, `no_route` for a
 * call nobody's own model answers while hosted inference is off (decision 0099), which such a flow checks first
 * (`HostedModel.enabled`) to skip with a truthful state instead.
 *
 * Given `starter`, where the host starts a flow, each admitted call also starts its window's spend alert, as the
 * endpoint's calls do (`ModelSpend.alerter`, docs/features/spend-alerts.md): a window whose only spend is a `todo` run's
 * agent or triage's judge alerts too. `alerts` is `MODEL_SPEND_ALERTS`' default, on unless set, as `make`'s is.
 *
 * Given `owner`, a call made inside a run (`FlowRuntime.FlowInstance`) whose owner saved a model of their own is
 * answered by that model and kept in their ledger, as their endpoint calls are (docs/features/personal-model.md): a
 * `todo` run works on its committer's key while every device is off. Its refusal fails at once, never falling back.
 * Without a model of their own, the deployment's answers only an owner who is one of its own Members (ruling AUTH-8).
 */
export const local = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean; readonly hosted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, meter, meterOwn, maxBodyBytes, budget } = yield* metering(database, options.hosted)
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
          // The person whose run this is, when `owner` names one: their own model answers it, as it answers their chat,
          // and the deployment's only when they are one of its own Members (ruling AUTH-8).
          const owned = owner === undefined || executionId === undefined
            ? Option.none<Owned>()
            : yield* owner(executionId).pipe(
              Effect.mapError(() =>
                new ModelError.ModelError({ code: "provider_internal", message: "Smithers can't reach its database." })
              ),
            )
          const admission = { requestId: invocationId, invocationId, requestBytes: encoded.body.byteLength }
          const admitted = yield* admit(
            role,
            Option.getOrUndefined(Option.map(owned, (run) => run.personId)),
            Option.match(owned, { onNone: () => true, onSome: (run) => run.deploymentPays }),
          )(request, admission).pipe(
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
 * The person a server flow's run is for (`personId`), and whether the deployment pays for its calls their own model
 * doesn't answer (`deploymentPays`: a Member or above of the deployment's own repository, ruling AUTH-8).
 */
export interface Owned {
  readonly personId: string
  readonly deploymentPays: boolean
}

/**
 * The person a server flow's run is for, by its execution id: a `todo` run's is the person who committed the TODO
 * (`TodoMachine.ownerOf`). None for a run that is nobody's, such as triage, which the deployment pays for.
 */
export type Owner<R = never> = (executionId: string) => Effect.Effect<Option.Option<Owned>, unknown, R>
