import { digestSync } from "@smthrs/crypto"
import type { Flow } from "@smthrs/flow"
import { Cause, Context, Effect, Layer, Metric, Option, Schema } from "effect"

/** Repository policy receives identities only. No notification text or credential enters the flow. */
const Identity = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/))
export const Request = Schema.Struct({
  repoId: Identity,
  kind: Schema.Literals(["working", "waiting", "needs_you", "done", "failed", "main", "release"]),
  subject: Schema.String,
  revision: Schema.String,
  owner: Schema.optional(Identity),
  candidates: Schema.Array(Identity),
  defaults: Schema.Array(Identity),
})
export type Request = typeof Request.Type

/** Policy may choose at most 50 people and optionally quiet their copies. It cannot change their content or acts. */
export const Decision = Schema.Struct({
  recipients: Schema.Array(Identity).check(Schema.isMaxLength(50)),
  handling: Schema.optional(Schema.Struct({ quiet: Schema.optional(Schema.Boolean) })),
})
const decodeDecision = Schema.decodeUnknownOption(Decision, { onExcessProperty: "error" })

/** A plugin's repository-scoped decision port. None means this repository has no policy. */
export class RecipientPolicy extends Context.Service<RecipientPolicy, {
  readonly decide: (request: Request) => Effect.Effect<Option.Option<unknown>, unknown>
}>()("@smthrs/mvp/notifications/RecipientPolicy") {}

/**
 * Bind a repository's declared flow on its host. The host supplies its durable engine and registrations; this
 * adapter never starts another runtime. Repeated identical requests reattach to the same execution. A changed
 * audience or event revision gets its own decision, while content and credentials are absent from both.
 */
export const layerFlow = <Tag extends string, E extends Schema.Top, R>(
  repoId: string,
  flow: Flow.Flow<Tag, typeof Request, typeof Decision, E, R>,
) => Layer.effect(RecipientPolicy, Effect.gen(function* () {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof flow.execute>>>()
  return RecipientPolicy.of({
    decide: (request) => request.repoId !== repoId ? Effect.succeed(Option.none()) : flow.execute(request, {
      executionId: `notification-policy-${digestSync(JSON.stringify([flow._tag, request]))}`,
    }).pipe(Effect.provide(context), Effect.map(Option.some)),
  })
}))

export const decisions = Metric.counter("smithers_notification_policy_decisions", {
  description: "Recipient decisions by source and closed fallback reason; no identities or content",
  incremental: true,
})

type Reason = "policy-unavailable" | "policy-failed" | "policy-malformed"
export interface Selection {
  readonly recipients: ReadonlyArray<string>
  readonly quiet?: boolean
  readonly source: "default" | "policy"
  readonly reason?: Reason
}

/** A failed policy keeps the existing audience. Authorization always belongs to the caller, after this returns. */
export const select = (request: Request): Effect.Effect<Selection> => Effect.gen(function* () {
  const fallback = (reason?: Reason): Selection => ({ recipients: request.defaults, source: "default", ...(reason === undefined ? {} : { reason }) })
  const policy = yield* Effect.serviceOption(RecipientPolicy)
  if (Option.isNone(policy)) return fallback()
  // Do not truncate a large built-in audience, and do not send an unbounded request to a policy.
  if (request.candidates.length > 50 || request.defaults.length > 50) return fallback("policy-unavailable")
  return yield* Effect.suspend(() => policy.value.decide(request)).pipe(
    Effect.timeoutOption("10 seconds"),
    Effect.map((response): Selection => {
      if (Option.isNone(response)) return fallback("policy-unavailable")
      if (Option.isNone(response.value)) return fallback()
      const decoded = decodeDecision(response.value.value)
      if (Option.isNone(decoded)) return fallback("policy-malformed")
      return { source: "policy", recipients: [...new Set(decoded.value.recipients)],
        ...(decoded.value.handling?.quiet === undefined ? {} : { quiet: decoded.value.handling.quiet }) }
    }),
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(fallback("policy-failed"))),
  )
}).pipe(
  Effect.tap((selection) => Effect.all([
    Metric.update(Metric.withAttributes(decisions, { source: selection.source, reason: selection.reason ?? "none" }), 1),
    Effect.logInfo("notifications.policy").pipe(Effect.annotateLogs({
      kind: request.kind, source: selection.source, reason: selection.reason ?? "none", selected: selection.recipients.length,
    })),
  ])),
  Effect.withSpan("notifications.policy"),
)
