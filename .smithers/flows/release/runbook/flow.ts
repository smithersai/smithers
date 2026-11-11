/**
 * `release/runbook`: the maintainer's release, from cut to npm, as one durable
 * `Runbook`. The run is the release record: every step's input, output and
 * approval is in its journal.
 *
 * | Step       | Flow                | Risk     |
 * | ---------- | ------------------- | -------- |
 * | `cut`      | `release/cut`       | risky    |
 * | `rehearse` | `release/rehearsal` | safe     |
 * | `pack`     | `release/pack`      | safe     |
 * | `smoke`    | `release/smoke`     | safe     |
 * | `publish`  | `release/publish`   | critical |
 *
 * `cut` writes the version, changelog and lockfiles and commits and tags them
 * locally; it asks first. `publish` asks again, elevated, and publishes the
 * smoked candidate's exact tarballs: approve it only after the release commit
 * has landed on `main` and its tag is pushed. A denial fails the run with
 * {@link Denied}, and no later step runs. Publication reads `RELEASE_TAG` and
 * the npm credential from the environment, never from the payload.
 *
 * ```sh
 * RELEASE_TAG=v1.0.0 smthrs flow start release/runbook --data '{"version":"1.0.0"}' --wait
 * smthrs runs list --flow release/runbook
 * ```
 *
 * @since 1.0.0
 */
import { Flow, HumanTask } from "@smthrs/flow"
import * as Pattern from "@smthrs/patterns/Pattern"
import { PatternError } from "@smthrs/patterns/PatternError"
import * as Runbook from "@smthrs/patterns/Runbook"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
import { ModuleFailed } from "../../automation/run-module.ts"
import CutStep, { layer as cutLayer } from "../cut/flow.ts"
import PackStep, { layer as packLayer } from "../pack/flow.ts"
import PublishStep, { layer as publishLayer } from "../publish/flow.ts"
import RehearsalStep, { layer as rehearsalLayer } from "../rehearsal/flow.ts"
import SmokeStep, { layer as smokeLayer } from "../smoke/flow.ts"

/**
 * The version to release, and the candidate directory (`dist/release-packs`
 * when omitted).
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  version: Schema.NonEmptyString,
  directory: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * A maintainer declined a gated step.
 *
 * @since 1.0.0
 * @category errors
 */
export const Denied = Schema.TaggedStruct("release/runbook/Denied", { reason: Schema.String })

/** What `Runbook` hands every step. */
const Envelope = Schema.Struct({
  step: Schema.String,
  risk: Schema.String,
  elevated: Schema.Boolean,
  input: Request,
  previous: Schema.Unknown
})

const directoryOf = (request: typeof Request.Type): string => request.directory ?? "dist/release-packs"

/** One runbook step: the envelope's request, mapped to a release step flow's payload. */
const step = <P, R>(
  id: string,
  flow: { readonly call: (payload: P) => Node.Node<void, ModuleFailed, R> },
  payload: (request: typeof Request.Type) => P
) =>
  Flow.make(`release/runbook/${id}`, {
    payload: Envelope,
    success: Schema.Void,
    error: ModuleFailed,
    body: Node.capture({ id }, (envelope: typeof Envelope.Type) => flow.call(payload(envelope.input)))
  })

/**
 * The approval every gated step asks: a confirm `HumanTask` whose prompt names
 * the step. Yes answers `"approved"`; no fails with {@link Denied}.
 *
 * @since 1.0.0
 * @category flows
 */
export const Approve = Flow.make("release/runbook/approve", {
  payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
  success: Pattern.Approved,
  error: Schema.Union([Denied, HumanTask.HumanTaskFailed]),
  body: Node.capture(
    {},
    (
      request: { readonly reason: string }
    ): Node.Node<Pattern.Approved, typeof Denied.Type | HumanTask.HumanTaskFailed> =>
      Node.branch(
        HumanTask.action.call({ name: "release-runbook", kind: "confirm", prompt: request.reason, maxAttempts: 3 }),
        {
          if: (answer) => answer === true,
          then: () => Node.succeed("approved" as const),
          // A plain tagged record: the plan stores a failure as its JSON projection.
          else: () => Node.fail({ _tag: "release/runbook/Denied" as const, reason: request.reason })
        }
      )
  )
})

/**
 * The step flows' implementations.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = Layer.mergeAll(cutLayer, rehearsalLayer, packLayer, smokeLayer, publishLayer)

const Steps = Runbook.make({
  name: "release/runbook/steps",
  reason: "release step",
  onDeny: "fail",
  approval: Approve,
  steps: [
    { id: "cut", risk: "risky", flow: step("cut", CutStep, (request) => ({ version: request.version, commit: true })) },
    {
      id: "rehearse",
      risk: "safe",
      flow: step("rehearse", RehearsalStep, (request) => ({ tag: `v${request.version}` }))
    },
    { id: "pack", risk: "safe", flow: step("pack", PackStep, (request) => ({ directory: directoryOf(request) })) },
    { id: "smoke", risk: "safe", flow: step("smoke", SmokeStep, (request) => ({ directory: directoryOf(request) })) },
    {
      id: "publish",
      risk: "critical",
      flow: step("publish", PublishStep, (request) => ({ directory: directoryOf(request) }))
    }
  ]
})

/**
 * What the run did: each step's output, and the steps that ran, in order.
 *
 * @since 1.0.0
 * @category models
 */
export const Result = Schema.Struct({
  outputs: Schema.Record(Schema.String, Schema.Unknown),
  ran: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String)
})

/**
 * Why a run stopped: a declined step, an unanswered approval, a step module's
 * failure, or a refused gate.
 *
 * @since 1.0.0
 * @category errors
 */
export const Failure = Schema.Union([Denied, HumanTask.HumanTaskFailed, ModuleFailed, PatternError])

/**
 * What the runbook settles to. `Runbook` declares its value and failures as
 * unknown; it settles to `Result` and fails with an approval's, a step's or
 * its own error. The alias keeps a type argument list, whose comma discovery
 * reads as a property separator, out of the default declaration.
 */
type Settled = Node.Node<typeof Result.Type, typeof Failure.Type>

// Discovery reads the default export as a literal `Flow.make`, so the runbook
// is called from one rather than exported itself.
export default Flow.make("release/runbook", {
  description: "Release Smithers from cut to npm as one durable runbook; the run is the release record.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:bash *",
    "proc:spawn:jj *",
    "proc:spawn:git *",
    "proc:spawn:pnpm *",
    "proc:spawn:bun *",
    "proc:spawn:sleep *",
    "net:get:**",
    "net:private:**",
    "net:post:registry.npmjs.org/**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Result,
  error: Failure,
  body: (input) => Steps.call({ input }) as Settled
})
