import { finalFailure } from "./ModelRefusal.ts"
import type { FlowEngineLike } from "@smthrs/agent"
import { FlowRuntime } from "@smthrs/flow"
import { Model, ModelError, ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { Cause, Config, Duration, Effect, Exit, type Layer, Metric, Option, Result, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import type { ModelRole } from "../src/features/model/contract.ts"
import { codeOf } from "./ErrorCode.ts"
import { FlowStarter } from "./Flows.ts"
import * as HostedModel from "./HostedModel.ts"
import * as ModelRoles from "./ModelRoles.vibe"
import * as ModelSpend from "./ModelSpend.vibe"
import * as ModelTiers from "./ModelTiers.vibe"
import * as ModelUsage from "./ModelUsage.vibe"
import { PersonalModels, PersonalModelUnusable } from "./personal/Models.ts"
import * as PersonalUsage from "./personal/Usage.ts"

// In-process model seats for durable server flows. Admission opens a person's own model when available. Otherwise
// an eligible call uses the deployment's configured model and reserves its worst-case cost from the daily budget.

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
 * (worker/flows/TodoAgent.ts), about 128 KiB of text at four bytes a token, and its JSON
 * body adds field names and escapes, so a smaller bound would refuse requests the agent counts as fitting.
 */
export const MAX_REQUEST_BYTES = 192 * 1024

const modelBytes = Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "MODEL_MAX_REQUEST_BYTES").pipe(
  Config.withDefault(MAX_REQUEST_BYTES),
)

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
 * reservation, and `meterOwn` a person's own call.
 * `database` opens a Postgres client for each read and write.
 */
export const metering = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, hostedFallback = false) =>
  Effect.gen(function* () {
    const budget = yield* Config.schema(positive, "MODEL_DAILY_TOKEN_BUDGET").pipe(
      Config.withDefault(DAILY_TOKEN_BUDGET),
    )
    const maxOutputTokens = yield* Config.schema(positive, "MODEL_MAX_OUTPUT_TOKENS").pipe(
      Config.withDefault(MAX_OUTPUT_TOKENS),
    )
    const maxMessages = yield* Config.schema(positive, "MODEL_MAX_MESSAGES").pipe(Config.withDefault(MAX_MESSAGES))
    const maxBodyBytes = yield* modelBytes
    const expiry = yield* Config.Duration("MODEL_RESERVATION_EXPIRY").pipe(Config.withDefault(RESERVATION_EXPIRY))
    // Whether the deployment's model answers when no Admin set it; a value that doesn't parse is off.
    const hostedDefault = yield* HostedModel.hostedModelDefault(hostedFallback).pipe(Effect.orElseSucceed(() => false))
    // Alchemy binds settings while the program builds. Configuration failures stay local to the seat that needs it.
    const host = yield* Effect.serviceOption(HostModel)
    const defaults: ModelRoles.Defaults = {
      summary: yield* ModelRoles.summaryModel.pipe(
        Effect.mapError(() => new HostModelUnusable({ reason: "config" })),
        Effect.result,
      ),
      tiers: yield* ModelRoles.tierModels.pipe(
        Effect.mapError(() => new HostModelUnusable({ reason: "config" })),
        Effect.result,
      ),
      fallback: Option.isSome(host)
        ? Result.succeed({ source: "default", modelId: host.value.modelId, model: host.value.model })
        : yield* ModelRoles.defaultModel.pipe(Effect.result),
    }
    // Which tier answers each role; a value that doesn't parse leaves the defaults, logged once.
    const routes = yield* ModelTiers.roleTiers.pipe(
      Effect.tapError((error) =>
        Effect.logError("model.endpoint").pipe(Effect.annotateLogs({ errorCode: `role_tiers:${codeOf(error)}` }))
      ),
      Effect.orElseSucceed(() => ModelTiers.ROLE_TIERS),
    )

    /** Logs why a role couldn't serve the call, by code only. */
    const logFailure = (role: ModelRole, errorCode: string) =>
      Effect.logError("model.endpoint").pipe(Effect.annotateLogs({ role, errorCode }))

    const resolve = (role: ModelRole, personId: string | undefined, deploymentPays: boolean) =>
      Effect.gen(function* () {
        const route = routes[role]
        const opened = personId === undefined ? Option.none() : yield* (yield* PersonalModels).open(personId, route.tier).pipe(
          Effect.tapError((error) =>
            logFailure(role, error instanceof PersonalModelUnusable ? `own_unusable:${error.reason}` : error.errorCode)
          ),
          Effect.mapError((error) => error instanceof PersonalModelUnusable ? ownUnusable : unavailable),
        )
        if (Option.isSome(opened)) return { kind: "personal" as const, opened: opened.value }
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
          Effect.tapError((error) =>
            logFailure(role, error instanceof HostModelUnusable ? `unusable:${error.reason}` : codeOf(error))
          ),
          Effect.mapError((error) => error instanceof HostModelUnusable ? noRoute : unavailable),
        )
        return { kind: "deployment" as const, resolved }
      })

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
        const chosen = yield* resolve(role, personId, deploymentPays)
        if (chosen.kind === "personal") {
          const own: PersonalUsage.Call = {
            invocationId: admission.invocationId,
            requestId: admission.requestId,
            personId: personId!,
            role,
            modelId: chosen.opened.modelId,
            host: chosen.opened.host,
            connectionId: chosen.opened.connectionId,
            credentialNonce: chosen.opened.credentialNonce,
            protocol: chosen.opened.protocol,
            tier: chosen.opened.tier,
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
              model: chosen.opened.model,
              request: ModelRequest.ModelRequest.make({
                ...request,
                modelId: chosen.opened.modelId,
                params: withEffort(params, yield* ModelTiers.effortFor(role, route, request, chosen.opened.modelId)),
              }),
            },
          } satisfies Admitted
        }
        const resolved = chosen.resolved
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

    return { admit, resolve, meter, meterOwn, maxBodyBytes, logFailure, budget }
  })

/** An admitted call: what the model is asked, and the person's own call when their model answers it. */
interface Admitted {
  readonly prepared: ModelProxy.Prepared
  readonly own?: PersonalUsage.Call
}

/** The TODO has no personal or configured deployment coding seat. */
export class NoSeat extends Schema.TaggedError<NoSeat>()("@smthrs/mvp/todo/NoSeat", {}) {}

/** A model a server flow calls with, and the route its durable step keys on (`ModelStep.model` from `@smthrs/agent`). */
export interface Seat {
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
}

/** A refusal of a server flow's own call, as the model error its caller reads: the endpoint's code and status. */
const refusedCall = (refusal: ModelProxy.Refusal) =>
  new ModelError.ModelError({ code: refusal.modelErrorCode, message: refusal.message, httpStatus: refusal.status })

/**
 * Builds the role-specific models server flows call in process. `owner` identifies the person whose saved model
 * answers. The flow's durable model step keys on `route.prepare` so replay can reuse its sealed answer. A hosted
 * call reserves and settles against the deployment's budget, and `starter` starts its window's spend alert.
 */
export const local = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean; readonly hosted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, resolve, meter, meterOwn, maxBodyBytes, budget } = yield* metering(database, options.hosted)
    const alert = yield* ModelSpend.alerter(
      yield* ModelSpend.settings(options.alerts === undefined ? {} : { on: options.alerts }),
      budget,
    )
    // What the database layer needs, and the people's own models, captured here, so a model call needs nothing of its
    // caller.
    const context = yield* Effect.context<R | PersonalModels>()
    return (role: ModelRole, starter?: FlowStarter["Service"], owner?: Owner<R>) => {
      // Keep the historical route identity so already sealed model calls remain replayable.
      const prepare = ModelProxy.prepare({ url: `/api/model/${role}` })
      const call = (request: ModelRequest.ModelRequest, executionId: string | undefined) =>
        Effect.gen(function* () {
          // Each model call has a fresh id for its ledger reservation.
          const invocationId = crypto.randomUUID()
          const encoded = yield* prepare(request)
          if (encoded.body.byteLength > maxBodyBytes) {
            return yield* new ModelError.ModelError({ code: "invalid_request", message: "The request is too large.", httpStatus: 413 })
          }
          // A run's owner supplies their own model or uses an eligible deployment seat (ruling AUTH-8).
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
        requireSeat: (owner: Owned) => resolve(role, owner.personId, owner.deploymentPays).pipe(
          Effect.asVoid,
          Effect.mapError((error) =>
            error.modelErrorCode === "no_route" ? new NoSeat() : error
          ),
          Effect.provideContext(context),
        ),
      } satisfies Seat & { readonly requireSeat: (owner: Owned) => Effect.Effect<void, NoSeat | ModelProxy.Refusal> }
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
