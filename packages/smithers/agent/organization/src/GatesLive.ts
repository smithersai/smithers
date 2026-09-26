/**
 * The implementations behind `Gates`: subject binding, the decision step, and
 * the reviewer a host plugs in.
 *
 * {@link layer} files `organization/gate-subject`, `organization/gate-decide`,
 * `HumanTask.layer` (the approval question), and a reviewer for
 * `organization/gate-review`. Without a `review` handler the reviewer fails
 * closed: a Review gate is denied, never passed.
 *
 * @since 1.0.0
 */
import { HumanTask } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Gates from "./Gates.ts"
import { canonicalDigest } from "./internal/digest.ts"

/**
 * The subject digest a gate binds: SHA-256 over the canonical JSON of the
 * gate id, boundary, target, policy revision, and subject. An answer or a
 * record for one of these is never valid for another.
 *
 * @category digests
 * @since 1.0.0
 */
export const subjectDigest = (gate: Gates.Gate, subject: unknown): string =>
  canonicalDigest({
    gateId: gate.spec.id,
    boundary: gate.at.boundary,
    target: gate.at.target,
    revision: gate.revision,
    subject
  })

/**
 * The most characters of the subject an approval prompt shows.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxExcerptLength = 4_096

const excerpt = (subject: unknown): string => {
  const text = JSON.stringify(subject, null, 2)
  return text.length <= maxExcerptLength ? text : `${text.slice(0, maxExcerptLength)}\n…`
}

/**
 * Binds a gate to its subject: the digest, the question name
 * `gate/<id>/<digest16>`, and the prompt a person sees.
 *
 * @category digests
 * @since 1.0.0
 */
export const bind = (gate: Gates.Gate, subject: unknown): Gates.Binding => {
  const digest = subjectDigest(gate, subject)
  const heading = gate.spec._tag === "Approval" ? gate.spec.prompt : `Review by ${gate.spec.reviewer}`
  return {
    subjectDigest: digest,
    question: `gate/${gate.spec.id}/${digest.slice(0, 16)}`,
    prompt: `${heading}\n\n${gate.at.boundary} ${gate.at.target} · ${gate.revision} · ${
      digest.slice(0, 16)
    }\n\n\`\`\`json\n${excerpt(subject)}\n\`\`\``
  }
}

const decodeAnswer = Schema.decodeUnknownOption(Gates.ApprovalAnswer)

const unanswered: Record<HumanTask.HumanTaskFailed["code"], { outcome: Gates.Outcome; reason: string }> = {
  timeout: { outcome: "expired", reason: "no answer before the deadline" },
  rejected: { outcome: "denied", reason: "no acceptable answer" },
  request_invalid: { outcome: "denied", reason: "the approval question was invalid" }
}

const judge = (
  gate: Gates.Gate,
  digest: string,
  response: Gates.Response
): Pick<Gates.GateRecord, "outcome" | "reason" | "decidedBy"> => {
  const spec = gate.spec
  switch (response._tag) {
    case "answered": {
      if (spec._tag !== "Approval") return { outcome: "denied", reason: "an answer reached a Review gate" }
      const decoded = decodeAnswer(response.value)
      if (decoded._tag === "None") return { outcome: "denied", reason: "the answer was malformed" }
      if (decoded.value.subjectDigest !== digest) {
        return { outcome: "denied", reason: "the answer was for a different subject" }
      }
      return {
        outcome: decoded.value.approved ? "passed" : "denied",
        ...(decoded.value.reason === undefined ? {} : { reason: decoded.value.reason }),
        decidedBy: spec.approver
      }
    }
    case "unanswered":
      return unanswered[response.failure.code]
    case "reviewed": {
      if (spec._tag !== "Review") return { outcome: "denied", reason: "a review reached an Approval gate" }
      if (response.verdict.reviewer !== spec.reviewer) {
        return { outcome: "denied", reason: "the verdict came from a different reviewer" }
      }
      return {
        outcome: response.verdict.decision === "approve" ? "passed" : "denied",
        reason: response.verdict.reason,
        decidedBy: spec.reviewer
      }
    }
    case "unreviewed":
      return { outcome: "denied", reason: "the reviewer produced no verdict" }
  }
}

/**
 * The record a gate writes for what it saw. Pure: `decidedAt` is given.
 *
 * @category decisions
 * @since 1.0.0
 */
export const decide = (
  gate: Gates.Gate,
  digest: string,
  response: Gates.Response,
  decidedAt: number
): Gates.GateRecord => ({
  gateId: gate.spec.id,
  kind: gate.spec._tag,
  boundary: gate.at.boundary,
  target: gate.at.target,
  revision: gate.revision,
  subjectDigest: digest,
  ...judge(gate, digest, response),
  decidedAt
})

const subjectLayer = Gates.Subject.toLayer(
  ({ gate, subject }) => Effect.succeed(bind(gate, subject)),
  { implementationVersion: "gate-subject/v1" }
)

const decideLayer = Gates.Decide.toLayer(
  ({ gate, response, subjectDigest: digest }) =>
    Effect.gen(function*() {
      const record = decide(gate, digest, response, yield* Clock.currentTimeMillis)
      if (record.outcome === "passed") return record
      return yield* new Gates.GateRefused({
        record,
        message: `gate ${record.gateId} ${record.outcome} at ${record.boundary} ${record.target}`
      })
    }),
  { implementationVersion: "gate-decide/v1" }
)

/**
 * What a host's reviewer does with one request.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewHandler<R> = (
  request: Gates.ReviewRequest
) => Effect.Effect<Gates.ReviewVerdict, Gates.ReviewFailed, R>

const unconfigured: ReviewHandler<never> = () =>
  Effect.fail(new Gates.ReviewFailed({ message: "no reviewer is configured for Review gates" }))

/**
 * Every implementation a gated flow needs. Pass `review` to answer Review
 * gates; without it every Review gate is denied.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <R = never>(options: { readonly review?: ReviewHandler<R> | undefined } = {}) =>
  Layer.mergeAll(
    subjectLayer,
    decideLayer,
    HumanTask.layer,
    Gates.ReviewTask.toLayer(options.review ?? (unconfigured as ReviewHandler<R>))
  )
