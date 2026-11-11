/**
 * `runner/Lane`: a coding-agent lane as a control run on the runner's own
 * host (local mode, a `runner.json` with no `origin`).
 *
 * A lane is a discovered module, `lane`, whose one delegate is the round
 * flow `runner/Lane`. Each round is one external agent step,
 * `runner/Lane/Session` ({@link ExternalAgent.make}), whose job the runner's
 * local store queues and the runner's own claim loop works. A one-shot lane
 * ends with the step's result; a standing lane hands off to its next round
 * with the same brief, in the same lineage, until it is cancelled.
 *
 *   lane (module, .smithers/flows/lane/flow.ts under the lanes root)
 *     runner/Lane            round: Session, then done (one-shot) or Lane.to (standing)
 *       runner/Lane/Session  the external agent step over the local store
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as ExternalAgent from "@smthrs/agent/ExternalAgent"
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"

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
 * restarts each round's agent may have, and whether it is standing (a new
 * round after each one) or one-shot.
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
  standing: Schema.Boolean
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
    return Session.call(input).pipe(
      Node.branch({
        if: () => input.standing,
        then: () => Lane.to(invocation),
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
 * The lane module's registration for a run-capable control host: its
 * executable, the round and step flows, and the step's implementation over
 * the context's {@link AgentRunner.AgentJobs}.
 *
 * @category layers
 * @since 1.0.0
 */
export const registration = Executable.layer({
  delegates: [Lane],
  load: () => Effect.succeed({ default: definition })
}).pipe(
  Layer.provideMerge(Layer.mergeAll(Interpreter.layer(Lane), Interpreter.layer(Session), Session.toLayer())),
  Layer.orDie
)
