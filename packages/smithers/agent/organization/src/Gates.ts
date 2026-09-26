/**
 * Configurable backpressure at flow boundaries, built only from `@smthrs/flow`.
 *
 * An organization runs autonomously. A {@link GatePolicy} attaches gates at
 * named boundaries — a flow, a task, a tool, a handoff, an external write, a
 * release — and {@link before} places the selected gates in front of the node
 * that crosses the boundary. With no matching gate {@link before} returns that
 * node unchanged, so an empty or removed policy adds no node to the graph.
 *
 * Two kinds run:
 *
 * - **Approval** asks a person through `HumanTask` (kind `json`). The question
 *   is named `gate/<id>/<first 16 hex of the subject digest>` and its schema
 *   admits only an answer that repeats the subject digest, so an answer is
 *   bound to exactly what was asked. The deadline settles the gate as
 *   `expired`; silence is never consent. The channel that records the answer
 *   authenticates the person (a Slack adapter checks the owner's user id, the
 *   CLI holds the control credential); {@link answer} is the call both make.
 * - **Review** asks another principal for an independent verdict through a
 *   {@link Reviewer}: by default the declared {@link ReviewTask} action, whose
 *   implementation a host supplies (see `GatesLive.layer`). Only `approve` from
 *   the configured reviewer passes.
 *
 * Budget, Concurrency, Window, and Condition are accepted by the schema so a
 * policy can be written ahead of them, and refused by {@link unsupported}
 * (and so by policy loading and by {@link before}) until they are
 * implemented; none of them passes silently.
 *
 * Every decision is the sealed `organization/gate-decide` step, whose result is
 * a {@link GateRecord}: gate id, kind, boundary, target, policy revision,
 * subject digest, outcome, and who decided when. A gate that does not pass
 * fails the flow with {@link GateRefused} carrying that record.
 *
 * @since 1.0.0
 */
import { Action, HumanTask } from "@smthrs/flow"
import type * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import type { FlowRuntime } from "@smthrs/flow/FlowRuntime"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Profile from "./Profile.ts"

const pattern = (regex: RegExp, expected: string) => Schema.isPattern(regex, { expected })

/**
 * Where a gate can attach.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Boundary = Schema.Literals(["flow", "task", "tool", "handoff", "external-write", "release"])

/**
 * Where a gate can attach.
 *
 * @category models
 * @since 1.0.0
 */
export type Boundary = typeof Boundary.Type

/**
 * A gate id: lowercase words joined by single hyphens, at most 63 characters.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GateId = Schema.String.check(
  pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "a lowercase gate id"),
  Schema.isMaxLength(63)
)

const targetName = "[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}"

/**
 * What a gate attaches to at its boundary: a flow id, a role id, an action
 * tag, a `from->to` handoff, or `*` for every target.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Target = Schema.String.check(
  pattern(new RegExp(`^(?:\\*|${targetName}(?:->${targetName})?)$`), "a target id, a from->to handoff, or *")
)

/**
 * One boundary crossing: the boundary kind and the concrete target.
 *
 * @category schemas
 * @since 1.0.0
 */
export const At = Schema.Struct({ boundary: Boundary, target: Target })

/**
 * One boundary crossing.
 *
 * @category models
 * @since 1.0.0
 */
export type At = typeof At.Type

/**
 * A policy revision label, pinned by every record a gate writes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Revision = Schema.String.check(
  pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "a revision label")
)

/**
 * The longest configured approval prompt, in UTF-16 code units.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPromptLength = 4_096

/**
 * The longest configurable wait: one year of milliseconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxTimeoutMs = 31_536_000_000

const Millis = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxTimeoutMs }))

/**
 * A person approves the exact subject: `approver` is `owner` or a principal.
 * Without `timeoutMs` the question stays open until answered.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Approval = Schema.TaggedStruct("Approval", {
  id: GateId,
  approver: Profile.Superior,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxPromptLength)),
  timeoutMs: Schema.optionalKey(Millis)
})

/**
 * Another principal reviews the subject and must return `approve`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Review = Schema.TaggedStruct("Review", {
  id: GateId,
  reviewer: Profile.PrincipalId
})

/**
 * Tokens left for a principal and its ancestors. Not yet supported.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Budget = Schema.TaggedStruct("Budget", {
  id: GateId,
  principal: Profile.PrincipalId,
  tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

/**
 * A free permit for a key. Not yet supported.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Concurrency = Schema.TaggedStruct("Concurrency", {
  id: GateId,
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  retryAfterMs: Millis
})

/**
 * A time window opening. Not yet supported.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Window = Schema.TaggedStruct("Window", {
  id: GateId,
  cron: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  timezone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  openForMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_080 }))
})

/**
 * A named external signal. Not yet supported.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Condition = Schema.TaggedStruct("Condition", {
  id: GateId,
  signal: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  timeoutMs: Schema.optionalKey(Millis)
})

/**
 * Every gate kind a policy may name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GateSpec = Schema.Union([Approval, Review, Budget, Concurrency, Window, Condition])

/**
 * Every gate kind a policy may name.
 *
 * @category models
 * @since 1.0.0
 */
export type GateSpec = typeof GateSpec.Type

/**
 * The gate kinds that run today.
 *
 * @category models
 * @since 1.0.0
 */
export type Supported = typeof Approval.Type | typeof Review.Type

/**
 * The gate kinds that run today.
 *
 * @category constants
 * @since 1.0.0
 */
export const supportedKinds: ReadonlyArray<GateSpec["_tag"]> = ["Approval", "Review"]

/**
 * Why a gate kind cannot be used yet, or `undefined` when it runs.
 *
 * @category predicates
 * @since 1.0.0
 */
export const unsupported = (spec: GateSpec): string | undefined =>
  spec._tag === "Approval" || spec._tag === "Review"
    ? undefined
    : `${spec._tag} gates are not yet supported; only Approval and Review gates run`

/**
 * One policy entry: where a gate attaches and what it is.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Entry = Schema.Struct({ at: At, spec: GateSpec })

/**
 * The gates an organization attaches, under a revision label.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GatePolicy = Schema.Struct({
  revision: Revision,
  gates: Schema.Array(Entry).check(
    Schema.makeFilter<ReadonlyArray<typeof Entry.Type>>((gates) =>
      new Set(gates.map((gate) => gate.spec.id)).size === gates.length ? undefined : "gate ids must be unique"
    )
  )
})

/**
 * The gates an organization attaches, under a revision label.
 *
 * @category models
 * @since 1.0.0
 */
export type GatePolicy = typeof GatePolicy.Type

/**
 * The policy with no gates: every boundary runs without backpressure.
 *
 * @category constructors
 * @since 1.0.0
 */
export const empty = (revision: string): GatePolicy => ({ revision, gates: [] })

/**
 * The gates attached at `at`, in policy order: those naming its boundary and
 * either its exact target or `*`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const select = (policy: GatePolicy, at: At): ReadonlyArray<GateSpec> =>
  policy.gates
    .filter((gate) => gate.at.boundary === at.boundary && (gate.at.target === "*" || gate.at.target === at.target))
    .map((gate) => gate.spec)

/**
 * How a gate settled. `passed` lets the guarded node run; `denied` and
 * `expired` fail the flow with {@link GateRefused}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Outcome = Schema.Literals(["passed", "denied", "expired"])

/**
 * How a gate settled.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome = typeof Outcome.Type

/**
 * A lowercase hexadecimal SHA-256.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Digest = Schema.String.check(pattern(/^[0-9a-f]{64}$/, "a lowercase hex SHA-256"))

/**
 * The decision one gate made about one subject.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GateRecord = Schema.Struct({
  gateId: GateId,
  kind: Schema.Literals(["Approval", "Review"]),
  boundary: Boundary,
  target: Target,
  revision: Revision,
  subjectDigest: Digest,
  outcome: Outcome,
  reason: Schema.optionalKey(Schema.String),
  decidedBy: Schema.optionalKey(Profile.Superior),
  decidedAt: Schema.Int
})

/**
 * The decision one gate made about one subject.
 *
 * @category models
 * @since 1.0.0
 */
export type GateRecord = typeof GateRecord.Type

/**
 * A gate that did not pass. The guarded node never ran.
 *
 * @category errors
 * @since 1.0.0
 */
export class GateRefused extends Schema.TaggedError<GateRefused>()("@smthrs/organization/Gates/GateRefused", {
  record: GateRecord,
  message: Schema.String
}) {}

/**
 * A gate kind that cannot run yet reached {@link before}. Thrown while the
 * plan is built, before anything runs.
 *
 * @category errors
 * @since 1.0.0
 */
export class GateUnsupported extends Schema.TaggedError<GateUnsupported>()(
  "@smthrs/organization/Gates/GateUnsupported",
  { gateId: Schema.String, kind: Schema.String, message: Schema.String }
) {}

/**
 * The gate context every gate step carries: the spec, where it attached, and
 * the policy revision it came from.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Gate = Schema.Struct({
  spec: Schema.Union([Approval, Review]),
  at: At,
  revision: Revision
})

/**
 * The gate context every gate step carries.
 *
 * @category models
 * @since 1.0.0
 */
export type Gate = typeof Gate.Type

/**
 * What {@link Subject} binds: the subject digest, and for an approval the
 * question name and prompt the person sees.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Binding = Schema.Struct({
  subjectDigest: Digest,
  question: Schema.String,
  prompt: Schema.String
})

/**
 * What {@link Subject} binds.
 *
 * @category models
 * @since 1.0.0
 */
export type Binding = typeof Binding.Type

/**
 * Binds a gate to its subject: digests it and names the question.
 *
 * @category actions
 * @since 1.0.0
 */
export const Subject = Action.make("organization/gate-subject", {
  implementationVersion: "gate-subject/v1",
  payload: { gate: Gate, subject: Schema.Json },
  success: Binding
})

/**
 * What a person answers an approval with. `subjectDigest` must repeat the
 * digest the question was asked about.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ApprovalAnswer = Schema.Struct({
  approved: Schema.Boolean,
  subjectDigest: Digest,
  reason: Schema.optionalKey(Schema.String)
})

/**
 * What a person answers an approval with.
 *
 * @category models
 * @since 1.0.0
 */
export type ApprovalAnswer = typeof ApprovalAnswer.Type

/**
 * What a reviewer is asked: which gate, where, under which policy revision,
 * and the subject itself.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReviewRequest = Schema.Struct({
  gateId: GateId,
  reviewer: Profile.PrincipalId,
  boundary: Boundary,
  target: Target,
  revision: Revision,
  subject: Schema.Json
})

/**
 * What a reviewer is asked.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewRequest = typeof ReviewRequest.Type

/**
 * A reviewer's verdict. `reviewer` names who reviewed; a verdict from anyone
 * but the configured reviewer is denied.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReviewVerdict = Schema.Struct({
  decision: Schema.Literals(["approve", "request-changes"]),
  reason: Schema.String,
  reviewer: Profile.PrincipalId
})

/**
 * A reviewer's verdict.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewVerdict = typeof ReviewVerdict.Type

/**
 * A reviewer that could not produce a verdict. The gate records `denied`.
 *
 * @category errors
 * @since 1.0.0
 */
export class ReviewFailed extends Schema.TaggedError<ReviewFailed>()("@smthrs/organization/Gates/ReviewFailed", {
  message: Schema.String
}) {}

/**
 * The default reviewer: one declared step whose implementation the host
 * supplies, typically by running the reviewer's role task.
 *
 * @category actions
 * @since 1.0.0
 */
export const ReviewTask = Action.make("organization/gate-review", {
  payload: ReviewRequest,
  success: ReviewVerdict,
  error: ReviewFailed,
  nondeterministic: true
})

/**
 * What one gate saw before it decided.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Response = Schema.Union([
  Schema.TaggedStruct("answered", { value: Schema.Json }),
  Schema.TaggedStruct("unanswered", { failure: HumanTask.HumanTaskFailed }),
  Schema.TaggedStruct("reviewed", { verdict: ReviewVerdict }),
  Schema.TaggedStruct("unreviewed", {})
])

/**
 * What one gate saw before it decided.
 *
 * @category models
 * @since 1.0.0
 */
export type Response = typeof Response.Type

/**
 * Turns what a gate saw into its record, failing with {@link GateRefused}
 * unless it passed.
 *
 * @category actions
 * @since 1.0.0
 */
export const Decide = Action.make("organization/gate-decide", {
  implementationVersion: "gate-decide/v1",
  payload: { gate: Gate, subjectDigest: Digest, response: Response },
  success: GateRecord,
  error: GateRefused
})

/**
 * Builds the node that reviews one subject. `request` fields may be planned
 * references; pass them on, do not compute on them.
 *
 * @category models
 * @since 1.0.0
 */
export type Reviewer<E, R> = (request: Action.PlannedPayload<ReviewRequest>) => Node.Node<ReviewVerdict, E, R>

/**
 * The default {@link Reviewer}: {@link ReviewTask}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reviewTask: Reviewer<ReviewFailed, Action.Requirement<"organization/gate-review">> = (request) =>
  ReviewTask.call(request)

/**
 * How many answers one approval accepts before it is denied: a wrong subject
 * digest or a malformed answer is refused and asked again.
 *
 * @category constants
 * @since 1.0.0
 */
export const approvalAttempts = 3

// The JSON Schema an approval answer must satisfy: `subjectDigest` is the one
// digest the question was asked about, so a stale or foreign answer is refused
// where it arrives and asked again.
const answerSchema = (subjectDigest: string | Planned.Planned<string>) => ({
  type: "object",
  properties: {
    approved: { type: "boolean" },
    subjectDigest: { type: "string", enum: [subjectDigest] },
    reason: { type: "string" }
  },
  required: ["approved", "subjectDigest"]
})

/**
 * The requirements every gated node adds, besides its reviewer's.
 *
 * @category models
 * @since 1.0.0
 */
export type Requirements = Action.Requirement<"organization/gate-subject" | "organization/gate-decide">

/**
 * Options for {@link before}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options<RE, RR> {
  /** Builds Review gates' reviewer node; {@link reviewTask} by default. */
  readonly reviewer?: Reviewer<RE, RR> | undefined
}

const approvalNode = (
  gate: Gate & { readonly spec: typeof Approval.Type },
  subject: unknown
): Node.Node<GateRecord, GateRefused, Requirements> =>
  Subject.call({ gate, subject: subject as Schema.Json }).pipe(
    Node.bindPlanned(Node.capture({ gate }, function(binding: Planned.Planned<Binding>) {
      const spec = this.gate.spec
      return Node.all({
        binding: Node.succeed(binding),
        response: HumanTask.action.call({
          name: binding.question,
          kind: "json",
          prompt: binding.prompt,
          schema: answerSchema(binding.subjectDigest),
          maxAttempts: approvalAttempts,
          ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs })
        }).pipe(
          Node.bindPlanned(
            Node.capture(
              {},
              (value: Planned.Planned<Schema.Json>) => Node.succeed({ _tag: "answered" as const, value })
            )
          ),
          // The question's only typed failure is `HumanTaskFailed`, so the
          // whole error channel is caught: a schema filter would carry a
          // process-local class decoder into the graph.
          Node.catch({
            onFailure: Node.capture(
              {},
              (failure: Planned.Planned<HumanTask.HumanTaskFailed>) =>
                Node.succeed({ _tag: "unanswered" as const, failure })
            )
          })
        )
      }).pipe(Node.bindPlanned(Node.capture({ gate: this.gate }, function(seen) {
        return Decide.call({ gate: this.gate, subjectDigest: seen.binding.subjectDigest, response: seen.response })
      })))
    }))
  )

const reviewNode = <RE, RR>(
  gate: Gate & { readonly spec: typeof Review.Type },
  subject: unknown,
  reviewer: Reviewer<RE, RR>
) =>
  Node.all({
    binding: Subject.call({ gate, subject: subject as Schema.Json }),
    response: reviewer({
      gateId: gate.spec.id,
      reviewer: gate.spec.reviewer,
      boundary: gate.at.boundary,
      target: gate.at.target,
      revision: gate.revision,
      subject: subject as Schema.Json
    }).pipe(
      Node.bindPlanned(Node.capture({}, (verdict: Planned.Planned<ReviewVerdict>) =>
        Node.succeed({ _tag: "reviewed" as const, verdict }))),
      // Any reviewer failure is a refusal, not a pass; the failure itself
      // stays in the journal under the reviewer's own step.
      Node.catch({
        onFailure: Node.capture({}, () =>
          Node.succeed({ _tag: "unreviewed" as const }))
      })
    )
  }).pipe(Node.bindPlanned(Node.capture({ gate }, function(seen) {
    return Decide.call({ gate: this.gate, subjectDigest: seen.binding.subjectDigest, response: seen.response })
  })))

/**
 * Places the gates `policy` attaches at `at` in front of `next`.
 *
 * With no matching gate, `next` is returned unchanged: no node is added.
 * Otherwise each gate runs in policy order, and `next` starts only after the
 * last one passed. `subject` is what the gates are about — a task contract, a
 * diff, a release — and may hold planned references to earlier results.
 *
 * `policy` must be concrete when the plan is built: pass it in the flow's
 * payload (so the plan pins the revision) or capture it with `Node.capture`.
 * A gate kind that cannot run yet throws {@link GateUnsupported}.
 *
 * ```ts
 * Gates.before(payload.gates, { boundary: "release", target: "deliver" }, { diff }, Apply.call({ diff }))
 * ```
 *
 * @category combinators
 * @since 1.0.0
 */
export const before = <
  A,
  E,
  R,
  RE = ReviewFailed,
  RR = Action.Requirement<"organization/gate-review">
>(
  policy: GatePolicy | undefined,
  at: At,
  subject: unknown,
  next: Node.Node<A, E, R>,
  options: Options<RE, RR> = {}
): Node.Node<A, E | GateRefused, R | Requirements | RR> => {
  if (policy === undefined) return next
  if (Planned.isPlanned(policy) || Planned.isPlanned(at)) {
    throw new TypeError("Gates.before needs a concrete policy and boundary when the plan is built")
  }
  const reviewer = (options.reviewer ?? reviewTask) as Reviewer<RE, RR>
  let guarded: Node.Node<A, E | GateRefused, R | Requirements | RR> = next
  for (const spec of [...select(policy, at)].reverse()) {
    const refusal = unsupported(spec)
    if (refusal !== undefined) throw new GateUnsupported({ gateId: spec.id, kind: spec._tag, message: refusal })
    const gate = { at: { boundary: at.boundary, target: at.target }, revision: policy.revision }
    const check = spec._tag === "Approval"
      ? approvalNode({ ...gate, spec: spec }, subject)
      : reviewNode({ ...gate, spec: spec as typeof Review.Type }, subject, reviewer)
    guarded = Node.andThen(check, guarded)
  }
  return guarded
}

/**
 * The approval question a parked run is waiting on, read from the waiting
 * row's `request` text: enough for a Slack button or a CLI prompt.
 *
 * @category models
 * @since 1.0.0
 */
export interface Pending {
  readonly gateId: string
  readonly subjectDigest: string
  readonly prompt: string
  readonly attempt: number
  readonly maxAttempts: number
}

const questionName = /^gate\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([0-9a-f]{16})$/

const PendingQuestion = Schema.Struct({
  task: Schema.Literal("human"),
  name: Schema.String,
  kind: Schema.Literal("json"),
  prompt: Schema.String,
  attempt: Schema.Int,
  maxAttempts: Schema.Int,
  schema: Schema.Struct({
    properties: Schema.Struct({
      subjectDigest: Schema.Struct({ enum: Schema.Tuple([Digest]) })
    })
  })
})

const decodePending = Schema.decodeUnknownOption(
  Schema.Union([PendingQuestion, Schema.fromJsonString(PendingQuestion)])
)

/**
 * Reads a waiting row's `request` — the declared question as JSON text, or
 * the value a store decoded from it — as an approval gate question, or
 * `undefined` when it is some other wait.
 *
 * @category combinators
 * @since 1.0.0
 */
export const pending = (request: unknown): Pending | undefined => {
  const decoded = decodePending(request)
  if (decoded._tag === "None") return undefined
  const question = decoded.value
  const match = questionName.exec(question.name)
  const subjectDigest = question.schema.properties.subjectDigest.enum[0]
  if (match === null || !subjectDigest.startsWith(match[2]!)) return undefined
  return {
    gateId: match[1]!,
    subjectDigest,
    prompt: question.prompt,
    attempt: question.attempt,
    maxAttempts: question.maxAttempts
  }
}

/**
 * Records a person's answer to an approval gate. `token` is the waiting
 * row's token; `subjectDigest` must be the digest the question names.
 *
 * The caller authenticates the person first: this call does not know who is
 * answering.
 *
 * @category combinators
 * @since 1.0.0
 */
export const answer = (options: {
  readonly token: DurableDeferred.Token
  readonly subjectDigest: string
  readonly approved: boolean
  readonly reason?: string | undefined
}): Effect.Effect<void, DurableDeferred.TokenInvalid | HumanTask.HumanAnswerInvalid, FlowRuntime> =>
  HumanTask.answer({
    token: options.token,
    value: {
      approved: options.approved,
      subjectDigest: options.subjectDigest,
      ...(options.reason === undefined ? {} : { reason: options.reason })
    }
  })
