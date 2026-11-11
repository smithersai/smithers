/**
 * The declaration side of `Runbook`: its types and `make`, which throws a
 * `PatternError` for a declaration it cannot build. `Runbook.vibe`
 * re-exports all of it beside `run`, the pattern's Effect form.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Pattern from "../Pattern.ts"
import { PatternError } from "../PatternError.ts"
import * as Approval from "./Approval.ts"
import * as Compose from "./Compose.ts"
import * as Decorate from "./Decorate.ts"
import * as Failure from "./Failure.ts"
import { OpaqueInput } from "./Payload.ts"

const ApprovalInput = Schema.Struct({ input: Schema.Unknown, reason: Schema.String, scope: Schema.String })

const DEFAULT_REASON = "run the step"

/**
 * How much authority a step needs before it runs.
 *
 * A `safe` step runs unasked. A `risky` step needs an approval. A `critical`
 * step needs an approval too, and its request carries `elevated: true`.
 *
 * @category models
 * @since 0.1.0
 */
export type Risk = "safe" | "risky" | "critical"

/**
 * What a denial does to the rest of the runbook.
 *
 * `"skip"` is a {@link run} option only. {@link make} refuses it, because a
 * declared plan cannot express it.
 *
 * @category models
 * @since 0.1.0
 */
export type OnDeny = "fail" | "skip"

/**
 * One declared step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
  readonly id: string
  readonly flow: Flow.Any
  readonly risk: Risk
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly steps: ReadonlyArray<Step>
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
   */
  readonly approval: Flow.Any
  readonly onDeny: OnDeny
  readonly reason?: string | undefined
}

/**
 * What an approval sees before a gated step runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request<I, Out> {
  readonly step: string
  readonly risk: Risk
  readonly elevated: boolean
  readonly input: I
  readonly previous: Out | undefined
}

/**
 * One step at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, Out, E, R> {
  readonly id: string
  readonly risk: Risk
  readonly run: (args: Request<I, Out>) => Effect.Effect<Out, E, R>
}

/**
 * Operational callbacks for {@link run}.
 *
 * `approve` must produce the literal `"approved"`; anything else is a denial
 * and fails the typed schema decode.
 *
 * `run` snapshots `steps`, each step's `id`, `risk`, and `run`, `approve`, and
 * `onDeny` at the call, so a later edit to the array, a step record, or the
 * option object does not alter that run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R, E2, R2> {
  readonly steps: ReadonlyArray<RuntimeStep<I, Out, E, R>>
  readonly approve: (request: Request<I, Out>) => Effect.Effect<unknown, E2, R2>
  readonly onDeny: OnDeny
}

/**
 * What a runbook did.
 *
 * `ran` and `skipped` are disjoint and together name every step. `outputs`
 * holds one entry per step in `ran`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out> {
  readonly outputs: Record<string, Out>
  readonly ran: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
}

/**
 * Reports whether a step's risk requires an approval.
 *
 * @category introspection
 * @since 0.1.0
 * @throws {never}
 */
export const gated = (risk: Risk): boolean => risk !== "safe"

/**
 * Reports whether a step's risk raises the approval request to elevated.
 *
 * @category introspection
 * @since 0.1.0
 * @throws {never}
 */
export const elevated = (risk: Risk): boolean => risk === "critical"

/**
 * Whether every step id is distinct.
 *
 * @since 0.1.0
 * @private
 * @throws {never}
 */
export const identities = (ids: ReadonlyArray<string>): boolean => new Set(ids).size === ids.length

/**
 * The declared form of a runbook.
 *
 * @category models
 * @since 0.1.0
 */
export type RunbookFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Builds the runbook topology: the steps chained in declaration order, with
 * an approval call before every non-safe step.
 *
 * Each step is called with `{ step, risk, elevated, input, previous }`, and the
 * approval that gates a step sees that same envelope. A gated step runs only
 * when its approval answers the literal `"approved"`; any other answer fails
 * the runbook with a `PatternError` (`invalid_input`) carrying the answer. The
 * approval sees the envelope, so a built graph shows
 * which step an approval belongs to and whether it is elevated. The flow
 * settles to the same {@link Result} {@link run} returns, with every step in
 * `ran` and none in `skipped`.
 *
 * `onDeny: "skip"` is not declarable, and `make` refuses it rather than
 * accepting it and building a plan that halts. A skip is a decision about a
 * value the plan does not have: the gated node is one flow whose failure
 * channel carries the denial and the step's own failures together, so the
 * recovery arm that would express a skip also declares that the runbook
 * continues past a FAILED critical step, which no run does. Declaring the
 * runbook with `onDeny: "fail"` and calling {@link run} with `onDeny: "skip"`
 * is how a skipping runbook is expressed today.
 *
 * `make` throws a `PatternError` when there are no steps, when two steps share
 * an id, when the approval flow permits any value other than the literal
 * `"approved"`, or when `onDeny` is `"skip"`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions): RunbookFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these copies and never the caller's step records again.
  const steps: ReadonlyArray<Step> = options.steps.map((step) => ({ id: step.id, flow: step.flow, risk: step.risk }))
  if (steps.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Runbook requires at least one step" })
  }
  const ids = steps.map((step) => step.id)
  if (!identities(ids)) {
    throw new PatternError({ code: "invalid_decorator", message: "Runbook step ids must be unique" })
  }
  if (options.onDeny === "skip") {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Runbook.make does not support onDeny: \"skip\". A declared plan has no branch that drops a " +
        "denied step, and the gated node carries the step's own failures beside the denial, so the arm that " +
        "would skip also declares that the runbook continues past a failed step. Declare the runbook with " +
        "onDeny: \"fail\", and call Runbook.run with onDeny: \"skip\" to skip a denied step at run time."
    })
  }
  const reason = options.reason ?? DEFAULT_REASON
  const captures = { steps: ids, risks: steps.map((step) => step.risk), onDeny: options.onDeny, reason }
  const declared = steps.map((step) => {
    if (!gated(step.risk)) return { step, approval: undefined }
    const stepReason = `${reason}: ${step.id}`
    const approval = Pattern.bind(Pattern.slot({ input: ApprovalInput, output: Pattern.Approved }), options.approval)
    return { step, approval: { flow: approval, reason: stepReason } }
  })
  const { name, description } = Compose.label("runbook", { steps: ids }, options, [
    ...steps.map((step) => step.flow),
    options.approval
  ])
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const envelope = (index: number, previous: unknown): unknown => ({
      step: declared[index]!.step.id,
      risk: declared[index]!.step.risk,
      elevated: elevated(declared[index]!.step.risk),
      input,
      previous
    })
    // Every step's output is carried to one final map that settles the same
    // `{ outputs, ran, skipped }` record `run` returns. A declared runbook
    // refuses `onDeny: "skip"`, so every step it settles ran.
    const walk = (
      index: number,
      previous: unknown,
      outputs: Readonly<Record<string, Planned.Planned<unknown>>>
    ): Node.Node<unknown, unknown, R> => {
      const step = declared[index]
      if (step === undefined) {
        return Node.map(
          Node.succeed(outputs),
          Node.capture(captures, (values: unknown): Result<unknown> => ({
            outputs: { ...(values as Record<string, unknown>) },
            ran: ids,
            skipped: []
          }))
        )
      }
      return Node.bindPlanned(
        step.approval === undefined
          ? Decorate.call<R>(step.step.flow, envelope(index, previous))
          : Approval.gate(
            Decorate.call<R>(step.approval.flow, {
              input: envelope(index, previous),
              reason: step.approval.reason,
              scope: "run"
            }),
            () => Decorate.call<R>(step.step.flow, envelope(index, previous)),
            { step: step.step.id }
          ),
        Node.capture(
          { ...captures, step: step.step.id },
          (value: Planned.Planned<unknown>) => walk(index + 1, value, { ...outputs, [step.step.id]: value })
        )
      )
    }
    return walk(0, undefined, {})
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // The engine encodes a typed failure through this schema: a refused gate's
    // `PatternError`, and whatever a step or the approval failed with.
    error: Failure.schemaFor(
      [PatternError],
      [options.approval, ...steps.map((step) => step.flow)]
    ) as typeof Schema.Unknown,
    body: Node.capture(captures, body)
  })
}
