/**
 * Runbook pattern: an ordered list of steps where a step's risk decides
 * whether it is gated by an approval, and a denial either stops the runbook or
 * skips the step.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"
import * as WithApproval from "./WithApproval.ts"

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

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

type Approved = typeof WithApproval.Approved.Type

const decide = Schema.decodeUnknownEffect(WithApproval.Approved)

/**
 * Reports whether a step's risk requires an approval.
 *
 * @category introspection
 * @since 0.1.0
 */
export const gated = (risk: Risk): boolean => risk !== "safe"

/**
 * Reports whether a step's risk raises the approval request to elevated.
 *
 * @category introspection
 * @since 0.1.0
 */
export const elevated = (risk: Risk): boolean => risk === "critical"

const identities = (ids: ReadonlyArray<string>): boolean => new Set(ids).size === ids.length

/**
 * Builds the runbook topology: the steps chained in declaration order, with
 * every non-safe step wrapped by {@link WithApproval.withApproval}.
 *
 * Each step is called with `{ step, risk, elevated, input, previous }`, and the
 * approval that gates a step sees that same envelope, so a built graph shows
 * which step an approval belongs to and whether it is elevated.
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
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
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
  const declared = steps.map((step) =>
    gated(step.risk)
      ? {
        step,
        flow: WithApproval.withApproval(step.flow, {
          reason: `${reason}: ${step.id}`,
          approval: options.approval
        })
      }
      : { step, flow: step.flow }
  )
  const { name, description } = Compose.label("runbook", { steps: ids }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: declared.map((entry) => entry.flow),
    body: Node.capture(captures, (input) => {
      const envelope = (index: number, previous: unknown): unknown => ({
        step: declared[index]!.step.id,
        risk: declared[index]!.step.risk,
        elevated: elevated(declared[index]!.step.risk),
        input,
        previous
      })
      const walk = (index: number, previous: unknown): Node.Node<unknown, unknown> => {
        const current = call(declared[index]!.flow, envelope(index, previous))
        if (index + 1 >= declared.length) return current
        return Node.andThen(
          current,
          Node.capture({ ...captures, step: declared[index + 1]!.step.id }, (value) => walk(index + 1, value))
        )
      }
      return walk(0, undefined)
    })
  })
}

/**
 * Runs a runbook.
 *
 * A safe step runs without asking. A non-safe step asks `approve` first, and
 * the answer must decode as the literal `"approved"`. Under `onDeny: "fail"` a
 * denial fails the runbook on the typed schema-error channel and no later step
 * runs. Under `onDeny: "skip"` the denied step is listed in `skipped`, the
 * runbook continues, and the next step sees the last step that actually ran as
 * its `previous`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Out, E = never, R = never, E2 = never, R2 = never>(
  input: I,
  options: RuntimeOptions<I, Out, E, R, E2, R2>
): Effect.Effect<Result<Out>, E | E2 | PatternError | Schema.SchemaError, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the array, a step record, or the option object in between must
  // not reach it.
  const steps = options.steps.map((step) => ({ id: step.id, risk: step.risk, run: step.run }))
  const approve = options.approve
  const onDeny = options.onDeny
  if (steps.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Runbook requires at least one step" }))
  }
  if (!identities(steps.map((step) => step.id))) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Runbook step ids must be unique" }))
  }
  return Effect.gen(function*() {
    const outputs = new Map<string, Out>()
    const ran: Array<string> = []
    const skipped: Array<string> = []
    let previous: Out | undefined = undefined
    for (const step of steps) {
      const request: Request<I, Out> = {
        step: step.id,
        risk: step.risk,
        elevated: elevated(step.risk),
        input,
        previous
      }
      if (gated(step.risk)) {
        const answer = decide(yield* approve(request))
        const decision: Approved | "denied" = onDeny === "skip"
          ? yield* Effect.catch(answer, () => Effect.succeed("denied" as const))
          : yield* answer
        if (decision === "denied") {
          skipped.push(step.id)
          continue
        }
      }
      const output = yield* step.run(request)
      outputs.set(step.id, output)
      ran.push(step.id)
      previous = output
    }
    return { outputs: Object.fromEntries(outputs), ran, skipped }
  })
}
