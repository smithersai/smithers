/**
 * The declaration side of `Intervene`: its types and `make`, which throws a
 * `PatternError` for a declaration it cannot build. `Intervene.vibe`
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
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"
import { OpaqueInput } from "./Payload.ts"

const ApprovalInput = Schema.Struct({ input: Schema.Unknown, reason: Schema.String, scope: Schema.String })

const DEFAULT_REASON = "apply the proposed intervention"

/**
 * Configuration for {@link make}.
 *
 * `dryRun` removes the apply call from the declaration itself, so a dry-run
 * plan cannot reach a writing step. The optional `approval` flow must produce
 * the literal `"approved"` before apply runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly read: Member<R>
  readonly propose: Member<R>
  /**
   * The writing stage, called after the optional approval flow settles.
   */
  readonly apply: Flow.Any
  readonly report: Member<R>
  readonly dryRun: boolean
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
   */
  readonly approval?: Flow.Any | undefined
  readonly reason?: string | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * Each stage receives the same `phase` envelope as its declared flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5> {
  readonly read: (args: {
    readonly phase: "read"
    readonly input: I
  }) => Effect.Effect<Context, E, R>
  readonly propose: (args: {
    readonly phase: "propose"
    readonly input: I
    readonly context: Context
  }) => Effect.Effect<Proposal, E2, R2>
  readonly apply: (args: {
    readonly phase: "apply"
    readonly input: I
    readonly proposal: Proposal
  }) => Effect.Effect<Applied, E3, R3>
  readonly report: (args: {
    readonly phase: "report"
    readonly input: I
    readonly proposal: Proposal
    readonly applied: Applied | undefined
    readonly dryRun: boolean
  }) => Effect.Effect<Report, E4, R4>
  readonly dryRun: boolean
  readonly approval?:
    | ((args: {
      readonly input: I
      readonly proposal: Proposal
    }) => Effect.Effect<unknown, E5, R5>)
    | undefined
}

/**
 * The declared form of an intervention.
 *
 * @category models
 * @since 0.1.0
 */
export type InterveneFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Builds the intervention topology: read, propose, then either report the
 * proposal alone (dry run) or apply it and report what was written.
 *
 * When `approval` is supplied, the built graph calls it ahead of apply and
 * runs apply only when it answers the literal `"approved"`. Any other answer
 * fails the flow with a `PatternError` (`invalid_input`) carrying the answer,
 * and apply never starts.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): InterveneFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { read: options.read, propose: options.propose, report: options.report }
  const dryRun = options.dryRun
  const reason = options.reason ?? DEFAULT_REASON
  const apply = options.apply
  if (options.approval !== undefined && reason.trim().length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Approval reason must not be empty" })
  }
  const approval = options.approval === undefined
    ? undefined
    : Pattern.bind(Pattern.slot({ input: ApprovalInput, output: Pattern.Approved }), options.approval)
  const captures = { dryRun, gated: options.approval !== undefined, reason }
  const { name, description } = Compose.label("intervene", { dryRun }, options, [
    stages.read,
    stages.propose,
    apply,
    stages.report,
    options.approval
  ])
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> =>
    Node.bindPlanned(
      callMember(stages.read, { phase: "read", input }),
      Node.capture(captures, (context: Planned.Planned<unknown>) =>
        Node.bindPlanned(
          callMember(stages.propose, { phase: "propose", input, context }),
          Node.capture(captures, (proposal: Planned.Planned<unknown>) =>
            dryRun
              ? callMember(stages.report, {
                phase: "report",
                input,
                proposal,
                applied: undefined,
                dryRun: true
              })
              : Node.bindPlanned(
                approval === undefined
                  ? Decorate.call<R>(apply, { phase: "apply", input, proposal })
                  : Approval.gate(
                    Decorate.call<R>(approval, { input: { phase: "apply", input, proposal }, reason, scope: "run" }),
                    () => Decorate.call<R>(apply, { phase: "apply", input, proposal }),
                    captures
                  ),
                Node.capture(captures, (applied: Planned.Planned<unknown>) =>
                  callMember(stages.report, {
                    phase: "report",
                    input,
                    proposal,
                    applied,
                    dryRun: false
                  }))
              ))
        ))
    )
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // The engine encodes a typed failure through this schema: a refused gate's
    // `PatternError`, and whatever a stage or the approval failed with.
    error: Failure.schemaFor(
      [PatternError],
      [stages.read, stages.propose, apply, stages.report, options.approval]
    ) as typeof Schema.Unknown,
    body: Node.capture(captures, body)
  })
}
