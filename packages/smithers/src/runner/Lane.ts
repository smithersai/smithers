/**
 * `runner/Lane`: a coding-agent lane as a control run on the runner's own
 * host (local mode, a `runner.json` with no `origin`).
 *
 * A lane is a discovered module, `lane`, whose one delegate is the round
 * flow `runner/Lane`. Each round is one external agent step,
 * `runner/Lane/Session` ({@link ExternalAgent.make}), whose job the runner's
 * local store queues and the runner's own claim loop works. A one-shot lane
 * ends with the step's result; a standing lane hands off to its next round
 * with the same brief, in the same lineage, until it is cancelled. Each next
 * round starts from the revision the lane follows, fetched and resolved again
 * by `runner/Lane/Base`, so a lane that runs for weeks works on the current
 * tree.
 *
 *   lane (module, .smithers/flows/lane/flow.ts under the lanes root)
 *     runner/Lane            round: Session, then done (one-shot) or Base and Lane.to (standing)
 *       runner/Lane/Session  the external agent step over the local store
 *       runner/Lane/Base     the next round's base: the followed revision, fetched and resolved
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as ExternalAgent from "@smthrs/agent/ExternalAgent"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import * as Config from "./Config.ts"
import * as Workspace from "./Workspace.ts"

/**
 * The module's registry name, and the directory its descriptor lives in.
 *
 * @category constants
 * @since 1.0.0
 */
export const MODULE = "lane"

/**
 * The agent name every lane's job carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const AGENT = "lane"

/**
 * What a lane works on: the brief its agent is prompted with, the runner
 * profile that runs the agent, the repository (by its `runner.json` id) and
 * the commit its checkout starts from, the change's limits, the hours and
 * restarts each round's agent may have, whether it is standing (a new
 * round after each one) or one-shot, and the revision a standing lane
 * follows: each next round's base is that revision, resolved again.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  brief: Schema.String.check(Schema.isMinLength(1)),
  profile: AgentRunner.Profile,
  repository: Schema.String.check(Schema.isMinLength(1)),
  base: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  limits: AgentRunner.Limits,
  maxHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AgentRunner.MAX_HOURS })),
  restarts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AgentRunner.MAX_RESTARTS })),
  standing: Schema.Boolean,
  follow: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})

/**
 * What a lane works on, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * The job one round asks of the runner.
 *
 * @category constructors
 * @since 1.0.0
 */
export const taskOf = (input: Input): AgentRunner.Task => ({
  agent: { name: AGENT, labels: [], profile: input.profile, maxHours: input.maxHours, restarts: input.restarts },
  repository: input.repository,
  base: input.base,
  system: [],
  prompt: input.brief,
  limits: input.limits
})

/**
 * `runner/Lane/Session`: one round's external agent step.
 *
 * @category flows
 * @since 1.0.0
 */
export const Session = ExternalAgent.make("runner/Lane/Session", { payload: Input, task: taskOf })

/**
 * Decodes what a lane works on.
 *
 * @throws {Schema.SchemaError} When `input` is not an {@link Input}.
 * @category constructors
 * @since 1.0.0
 */
export const decodeInput = Schema.decodeUnknownSync(Input)

/**
 * The commit `rev` names in `mirror`, resolved with jj: exactly one, as 40 hex.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveBase = (mirror: string, rev: string) =>
  Workspace.jj(["-R", mirror, "log", "--no-graph", "-r", rev, "-T", "commit_id ++ \"\\n\""]).pipe(
    Effect.flatMap((ran) => {
      const lines = ran.stdout.split("\n").filter((line) => line !== "")
      return ran.code === 0 && lines.length === 1 && /^[0-9a-f]{40}$/.test(lines[0]!)
        ? Effect.succeed(lines[0]!)
        : Effect.fail(new Config.RunnerConfigError({ message: `--base ${rev} names no single commit in the mirror` }))
    })
  )

/**
 * `runner/Lane/Base`: the base a standing lane's next round starts from. It
 * fetches the repository's mirror from all its remotes, then resolves the
 * followed revision there; a fetch that fails still resolves what the mirror
 * has, and a revision that names no single commit keeps the last base.
 *
 * @category actions
 * @since 1.0.0
 */
export const Base = Action.make("runner/Lane/Base", {
  payload: { repository: Schema.String, follow: Schema.String, last: Schema.String },
  success: Schema.String,
  implementationVersion: "runner/lane/base/v1",
  nondeterministic: true
})

/** What a round's step requires of the engine it runs on. */
type SessionRequirement = ReturnType<typeof Session.call> extends Node.Node<any, any, infer R> ? R : never

/** Declared, so the body may name the flow it is the body of. */
type LaneFlow = Flow.Flow<
  "runner/Lane",
  typeof Executable.Invocation,
  typeof ExternalAgent.Result,
  typeof Session.errorSchema,
  SessionRequirement
>

/**
 * `runner/Lane`: one round. A one-shot lane ends with the round's result; a
 * standing one opens its next round with the same invocation.
 *
 * @category flows
 * @since 1.0.0
 */
export const Lane: LaneFlow = Flow.make("runner/Lane", {
  description: "Run one round of a coding-agent lane on this runner.",
  payload: Executable.Invocation,
  success: ExternalAgent.Result,
  // The step's own failures: why its agent ended without a change, the store unavailable, its job lost or timed out.
  error: Session.errorSchema,
  body: (invocation: Executable.Invocation) => {
    const input = decodeInput(invocation.input)
    const follow = input.follow
    return Session.call(input).pipe(
      Node.branch({
        if: () => input.standing,
        then: () =>
          follow === undefined
            ? Lane.to(invocation)
            : Base.call({ repository: input.repository, follow, last: input.base }).pipe(
              Node.bindPlanned((base) => Lane.to({ ...invocation, input: { ...input, base } }))
            ),
        else: (result) => Flow.done(result)
      })
    )
  }
})

/**
 * The descriptor the lanes root holds at `.smithers/flows/lane/flow.ts`: what
 * discovery reads, without importing it.
 *
 * @category constants
 * @since 1.0.0
 */
export const DESCRIPTOR_SOURCE = `// Written by \`smthrs runner serve\`: the coding-agent lane module.
export default ({
  name: "${MODULE}",
  description: "A coding-agent lane on this runner.",
  capabilities: [],
  flows: ["runner/Lane"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`

const definition = {
  name: MODULE,
  description: "A coding-agent lane on this runner.",
  input: Input,
  output: Schema.Unknown,
  capabilities: [],
  flows: ["runner/Lane"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

/**
 * `runner/Lane/Base`'s implementation over the mirrors `config` names. A
 * repository `runner.json` no longer names keeps the last base.
 *
 * @category layers
 * @since 1.0.0
 */
export const baseLayer = (config: Config.Checked) =>
  Base.toLayer(({ repository, follow, last }) =>
    Effect.gen(function*() {
      const mirror = config.repositories[repository]?.mirror
      if (mirror === undefined) return last
      const fetched = yield* Workspace.jj(["-R", mirror, "git", "fetch", "--all-remotes"], 300_000)
      const base = yield* resolveBase(mirror, follow).pipe(Effect.orElseSucceed(() => last))
      yield* Effect.logInfo("runner.lane").pipe(
        Effect.annotateLogs({
          repository,
          fetched: fetched.code === 0,
          outcome: base === last ? "base_kept" : "base_moved"
        })
      )
      return base
    }), { implementationVersion: "runner/lane/base/v1" })

/**
 * The lane module's registration for a run-capable control host: its
 * executable, the round and step flows, the step's implementation over the
 * context's {@link AgentRunner.AgentJobs}, and the next round's base over the
 * mirrors `config` names.
 *
 * @category layers
 * @since 1.0.0
 */
export const registration = (config: Config.Checked) =>
  Executable.layer({
    delegates: [Lane],
    load: () => Effect.succeed({ default: definition })
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Interpreter.layer(Lane), Interpreter.layer(Session), Session.toLayer(), baseLayer(config))
    ),
    Layer.orDie
  )
