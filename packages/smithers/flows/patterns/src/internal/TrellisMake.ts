/**
 * The declaration side of `Trellis`: its types and `make`, `compile` and `validate`, which throws a
 * `PatternError` for a declaration it cannot build. `Trellis.vibe`
 * re-exports all of it beside `execute`, the pattern's Effect form.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"
import type * as Recursion from "../Recursion.ts"
import * as Compose from "./Compose.ts"
import * as FailureSchema from "./Failure.ts"
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"

/**
 * Stable Trellis failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TrellisErrorCode = Schema.Literals([
  "invalid_envelope",
  "invalid_plan",
  "depth_exceeded",
  "fanout_exceeded",
  "fuel_exhausted"
])

/**
 * Stable Trellis failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type TrellisErrorCode = typeof TrellisErrorCode.Type

/**
 * A rejected plan or envelope, naming its plan path.
 *
 * Trellis owns this failure rather than reusing `PatternError` because every
 * rejection carries a plan path, and a path is what an author has to read to
 * repair the plan. `cause` carries the settled rounds a refused round leaves
 * behind. It never carries the caller input.
 *
 * @category errors
 * @since 0.1.0
 */
export class TrellisError extends Schema.TaggedError<TrellisError>()("flows/patterns/TrellisError", {
  code: TrellisErrorCode,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * The bounds a plan is admitted under: total leaf calls, nesting depth, and
 * the width of any one container.
 *
 * @category models
 * @since 0.1.0
 */
export type Envelope = Recursion.Envelope

/**
 * One unit of delegated work a model asked for.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Agent = Schema.Struct({
  goal: Schema.NonEmptyString,
  seat: Schema.optional(Schema.String)
})

/**
 * A model-authored plan: one agent, an ordered sequence, or a parallel group.
 *
 * A container holds at least one member. An empty one names no work, costs no
 * fuel, and would let a trampoline round make no progress, so both the type and
 * the {@link Plan} codec refuse it.
 *
 * @category models
 * @since 0.1.0
 */
export type Plan =
  | {
    readonly agent: {
      readonly goal: string
      readonly seat?: string | undefined
    }
  }
  | { readonly sequence: readonly [Plan, ...ReadonlyArray<Plan>] }
  | { readonly parallel: readonly [Plan, ...ReadonlyArray<Plan>] }

// Keep excess keys until the one-key check can reject them instead of
// letting Struct decoding discard them. Child plans use this same codec.
const PlanSchema: Schema.Codec<Plan> = Schema.suspend(
  (): Schema.Codec<Plan> =>
    Schema.Union([
      Schema.StructWithRest(
        Schema.Struct({
          agent: Agent,
          sequence: Schema.optionalKey(Schema.Never),
          parallel: Schema.optionalKey(Schema.Never)
        }),
        [Schema.Record(Schema.String, Schema.Unknown)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          sequence: Schema.NonEmptyArray(PlanSchema),
          agent: Schema.optionalKey(Schema.Never),
          parallel: Schema.optionalKey(Schema.Never)
        }),
        [Schema.Record(Schema.String, Schema.Unknown)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          parallel: Schema.NonEmptyArray(PlanSchema),
          agent: Schema.optionalKey(Schema.Never),
          sequence: Schema.optionalKey(Schema.Never)
        }),
        [Schema.Record(Schema.String, Schema.Unknown)]
      )
    ]).check(Schema.isMaxProperties(1))
)

/**
 * Schema for a model-authored plan. Declare it as an author flow's output so
 * the model is shown the closed grammar it may answer in.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Plan = PlanSchema

/**
 * One compiled leaf: the goal a leaf flow is called with, the seat the model
 * asked for, and the plan path the leaf came from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Leaf {
  readonly goal: string
  readonly seat?: string | undefined
  readonly path: string
}

/**
 * Shared with the Effect forms in the public module.
 *
 * @since 0.1.0
 * @private
 * @throws {never}
 */
export const container = (plan: Plan): ReadonlyArray<Plan> | undefined =>
  "sequence" in plan ? plan.sequence : "parallel" in plan ? plan.parallel : undefined

/**
 * Shared with the Effect forms in the public module.
 *
 * @since 0.1.0
 * @private
 * @throws {never}
 */
export const childPath = (path: string, plan: Plan, index: number): string =>
  `${path}.${"sequence" in plan ? "sequence" : "parallel"}[${index}]`

/**
 * Lists a plan's leaves in plan order. The count is what the plan costs in
 * fuel, and the paths are the stable identifiers a caller keys leaf outputs by.
 *
 * @category introspection
 * @since 0.1.0
 */
export const leaves = (plan: Plan): ReadonlyArray<Leaf> => {
  const collected: Array<Leaf> = []
  const visit = (node: Plan, path: string): void => {
    const members = container(node)
    if (members === undefined) {
      const agent = (node as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
      collected.push(
        agent.seat === undefined ? { goal: agent.goal, path } : { goal: agent.goal, seat: agent.seat, path }
      )
      return
    }
    members.forEach((member, index) => visit(member, childPath(path, node, index)))
  }
  visit(plan, "root")
  return collected
}

const bounded = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

// The three bounds as own fields, so an effect or a declaration built now
// never reads a caller's envelope object again.
const copiedEnvelope = (envelope: Envelope): Envelope => ({
  fuel: envelope.fuel,
  depth: envelope.depth,
  fanout: envelope.fanout
})

// A structural copy of a plan, so an effect that runs later visits the leaves
// the plan named when the effect was built.
/**
 * Shared with the Effect forms in the public module.
 *
 * @since 0.1.0
 * @private
 */
export const copiedPlan = (plan: Plan): Plan => {
  const members = container(plan)
  if (members === undefined) {
    const agent = (plan as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
    return { agent: agent.seat === undefined ? { goal: agent.goal } : { goal: agent.goal, seat: agent.seat } }
  }
  const copies: readonly [Plan, ...ReadonlyArray<Plan>] = [copiedPlan(members[0]!), ...members.slice(1).map(copiedPlan)]
  return "sequence" in plan ? { sequence: copies } : { parallel: copies }
}

/**
 * Shared with the Effect forms in the public module.
 *
 * @since 0.1.0
 * @private
 */
export const admissionRefusal = (options: {
  readonly envelope?: Envelope | undefined
  readonly concurrency?: number | undefined
}): TrellisError | undefined => {
  const envelope = options.envelope
  if (
    envelope !== undefined &&
    (!bounded(envelope.fuel) || !bounded(envelope.depth) || !bounded(envelope.fanout))
  ) {
    return new TrellisError({
      code: "invalid_envelope",
      path: "root",
      message: "Trellis envelope fuel, depth, and fanout must be positive safe integers"
    })
  }
  const concurrency = options.concurrency
  if (concurrency !== undefined && !bounded(concurrency)) {
    return new TrellisError({
      code: "invalid_envelope",
      path: "root",
      message: `Trellis concurrency must be a positive safe integer, received ${concurrency}`
    })
  }
  return undefined
}

const shape = (value: unknown): "agent" | "sequence" | "parallel" | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1) return undefined
  const key = keys[0]
  return key === "agent" || key === "sequence" || key === "parallel" ? key : undefined
}

const namesNoWork = (value: unknown, depth: number): boolean => {
  // Stop at the admission bound so validate can report an over-deep value.
  if (depth < 1) return false
  const kind = shape(value)
  if (kind === undefined || kind === "agent") return false
  const members = (value as { readonly [key: string]: unknown })[kind]
  return Array.isArray(members) && members.every((member) => namesNoWork(member, depth - 1))
}

const validatePlan = (plan: unknown, envelope: Envelope, firstOnly: boolean): ReadonlyArray<TrellisError> => {
  const invalid = admissionRefusal({ envelope })
  if (invalid !== undefined) return [invalid]
  const found: Array<TrellisError> = []
  let leafCount = 0
  const ancestors = new Set<unknown>()
  const visit = (value: unknown, path: string, depth: number): void => {
    const kind = shape(value)
    if (kind === undefined) {
      found.push(
        new TrellisError({
          code: "invalid_plan",
          path,
          message: "A plan node must be exactly one of agent, sequence, or parallel"
        })
      )
      return
    }
    if (firstOnly && ancestors.has(value)) {
      found.push(
        new TrellisError({ code: "invalid_plan", path, message: "A plan node must not contain a cycle" })
      )
      return
    }
    if (depth > envelope.depth) {
      found.push(
        new TrellisError({
          code: "depth_exceeded",
          path,
          message: `Plan depth ${depth} exceeds the envelope depth ${envelope.depth}`
        })
      )
      return
    }
    if (kind === "agent") {
      const agent = (value as { readonly agent: unknown }).agent
      if (typeof agent !== "object" || agent === null) {
        found.push(
          new TrellisError({ code: "invalid_plan", path: `${path}.agent`, message: "agent must be an object" })
        )
        return
      }
      const goal = (agent as { readonly goal?: unknown }).goal
      const seat = (agent as { readonly seat?: unknown }).seat
      if (typeof goal !== "string" || goal.length === 0) {
        found.push(
          new TrellisError({
            code: "invalid_plan",
            path: `${path}.agent.goal`,
            message: "agent.goal must be a non-empty string"
          })
        )
      }
      if (seat !== undefined && typeof seat !== "string") {
        found.push(
          new TrellisError({ code: "invalid_plan", path: `${path}.agent.seat`, message: "agent.seat must be a string" })
        )
      }
      leafCount += 1
      return
    }
    const members = (value as { readonly [key: string]: unknown })[kind]
    if (!Array.isArray(members)) {
      found.push(
        new TrellisError({ code: "invalid_plan", path: `${path}.${kind}`, message: `${kind} must be an array` })
      )
      return
    }
    if (members.length === 0) {
      found.push(
        new TrellisError({
          code: "invalid_plan",
          path,
          message: `${kind} must hold at least one member`
        })
      )
      return
    }
    if (members.length > envelope.fanout) {
      found.push(
        new TrellisError({
          code: "fanout_exceeded",
          path,
          message: `${kind} declares ${members.length} members, above the envelope fan-out ${envelope.fanout}`
        })
      )
      return
    }
    // A hole is a missing member `forEach` would skip, so walk every index.
    // Execution needs only the first refusal, including for a huge sparse array.
    ancestors.add(value)
    for (let index = 0; index < members.length && (!firstOnly || found.length === 0); index++) {
      const memberPath = `${path}.${kind}[${index}]`
      if (index in members) {
        visit(members[index], memberPath, depth + 1)
      } else {
        found.push(
          new TrellisError({
            code: "invalid_plan",
            path: memberPath,
            message: "A plan node must not be a missing member"
          })
        )
      }
    }
    ancestors.delete(value)
  }
  visit(plan, "root", 1)
  if (found.length === 0 && leafCount > envelope.fuel) {
    found.push(
      new TrellisError({
        code: "fuel_exhausted",
        path: "root",
        message: `Plan needs ${leafCount} leaf calls but only ${envelope.fuel} fuel remains`
      })
    )
  }
  return found
}

/**
 * Checks a model-authored value against an envelope and returns every reason
 * it was refused, each naming the plan path it was found at. An accepted plan
 * returns no reasons.
 *
 * Fuel is charged per leaf and checked for the whole plan, so a plan is
 * admitted or refused as a unit and no leaf runs on a budget the plan already
 * overspent.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (plan: unknown, envelope: Envelope): ReadonlyArray<TrellisError> =>
  validatePlan(plan, envelope, false)

/**
 * A call-time plan snapshot or its first shape refusal. Validation and copying
 * share one guarded boundary so unreadable or excessively nested input never
 * escapes the Effect form as a synchronous exception.
 *
 * @since 0.1.0
 * @private
 * @throws {never}
 */
export const admittedPlan = (plan: Plan): Plan | TrellisError => {
  try {
    return validatePlan(plan, {
      fuel: Number.MAX_SAFE_INTEGER,
      depth: Number.MAX_SAFE_INTEGER,
      fanout: Number.MAX_SAFE_INTEGER
    }, true)[0] ?? copiedPlan(plan)
  } catch {
    return new TrellisError({
      code: "invalid_plan",
      path: "root",
      message: "The plan could not be read or copied"
    })
  }
}

/**
 * Options accepted by {@link compile}.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompileOptions<R = never> {
  readonly leaf: Member<R>
}

const ordinal = (key: string): number => Number(key.slice(key.lastIndexOf("-") + 1))

/**
 * Compiles a validated plan into one static node: an agent becomes a leaf
 * call, a sequence becomes an ordered chain of member results, and a parallel
 * becomes a `Node.all` join returned in plan order.
 *
 * A sequence carries its members' planned references and hands them over as one
 * array when the chain settles, because a planned result may be read by field
 * and passed on but never spread into a new array while the graph builds.
 *
 * @category constructors
 * @since 0.1.0
 */
export const compile = <R = never>(plan: Plan, options: CompileOptions<R>): Node.Node<unknown, unknown, R> => {
  const visit = (node: Plan, path: string): Node.Node<unknown, unknown, R> => {
    const members = container(node)
    if (members === undefined) {
      const agent = (node as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
      const leaf: Leaf = agent.seat === undefined
        ? { goal: agent.goal, path }
        : { goal: agent.goal, seat: agent.seat, path }
      return callMember(options.leaf, leaf)
    }
    if ("parallel" in node) {
      const joined: Record<string, Node.Node<unknown, unknown, R>> = {}
      members.forEach((member, index) => {
        joined[`member-${index}`] = visit(member, childPath(path, node, index))
      })
      return Node.map(
        Node.all(joined),
        Node.capture({ members: members.length }, (values: Readonly<Record<string, unknown>>) =>
          Object.keys(values)
            .sort((left, right) => ordinal(left) - ordinal(right))
            .map((key) => values[key]))
      )
    }
    // Each member gates the next, so the chain runs in plan order, and the
    // settled array is built from the references the chain collected.
    const chain = (
      index: number,
      carried: ReadonlyArray<Planned.Planned<unknown>>
    ): Node.Node<unknown, unknown, R> => {
      const member = members[index]
      if (member === undefined) return Node.succeed(carried)
      return Node.bindPlanned(
        visit(member, childPath(path, node, index)),
        Node.capture({ index }, (value) => Node.andThen(Node.succeed(value), chain(index + 1, [...carried, value])))
      )
    }
    return chain(0, [])
  }
  return visit(plan, "root")
}

/**
 * Options accepted by {@link make}.
 *
 * `author` is called with the caller's `input` and answers the first plan.
 * `leaf` is called once per agent the plan names, with a {@link Leaf}.
 * `continue`, when supplied, is called after each round with a
 * {@link Continuation} and answers the next plan; `null`, `undefined`, or a
 * value whose only content is empty `sequence` or `parallel` containers within
 * the envelope depth, ends the trellis. Without `continue` the trellis runs one
 * plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly author: Member<R>
  readonly leaf: Member<R>
  readonly continue?: Member<R> | undefined
  readonly envelope: Envelope
}

/**
 * What {@link make} hands `continue` after a round settles.
 *
 * @category models
 * @since 0.1.0
 */
export interface Continuation {
  readonly plan: Plan
  readonly result: unknown
  readonly round: number
  readonly remaining: number
}

/**
 * One executed round: the plan the model authored and what it produced.
 *
 * @category models
 * @since 0.1.0
 */
export interface Round {
  readonly plan: Plan
  readonly result: unknown
}

/**
 * What a trellis settles with: every round it executed and the fuel left over.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunResult {
  readonly rounds: ReadonlyArray<Round>
  readonly remaining: number
}

/**
 * The state one plan round is handed: the plan to run, its round number, the
 * fuel left before it runs, and the rounds already settled.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RoundState = Schema.Struct({
  plan: Schema.Unknown,
  round: Schema.Number,
  remaining: Schema.Number,
  rounds: Schema.Array(Schema.Unknown)
})

/**
 * What a trellis flow is called with. A caller passes `input` alone; the
 * trellis hands itself `round` when it opens the next round.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Payload = Schema.Struct({
  input: Schema.Unknown,
  round: Schema.optionalKey(RoundState)
})

/**
 * What a trellis fails with: a {@link TrellisError}, encoded through its own
 * schema, or the error of the author, a leaf, or the continuation. A declared
 * trellis's runtime schema also names the error schema each member flow
 * declares, so a durable journal encodes a member's tagged error too.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Failure = Schema.Union([TrellisError, Schema.Unknown])

/**
 * The declared form of a trellis.
 *
 * @category models
 * @since 1.0.0
 */
export type TrellisFlow<R = never> = Flow.Flow<
  string,
  typeof Payload,
  typeof Schema.Unknown,
  typeof Failure,
  R
>

/**
 * Whether round state agrees with itself and the envelope: the round follows
 * every settled round, each settled plan is one the envelope admits, and the
 * fuel left is the envelope's less what those plans cost.
 */
const consistent = (state: typeof RoundState.Type, envelope: Envelope): boolean => {
  if (!Number.isSafeInteger(state.round) || state.round !== state.rounds.length + 1) return false
  let spent = 0
  for (const settled of state.rounds) {
    const plan = typeof settled === "object" && settled !== null
      ? (settled as { readonly plan?: unknown }).plan
      : undefined
    if (validate(plan, envelope).length > 0) return false
    spent += leaves(plan as Plan).length
  }
  return state.remaining === envelope.fuel - spent && state.remaining >= 0
}

/** A refusal as plain data: what a plan may hold while its graph is built. */
interface Refusal {
  readonly code: TrellisErrorCode
  readonly path: string
  readonly message: string
}

/** The data one refused round fails with, before it is minted as an error. */
interface Refused extends Refusal {
  readonly rounds: ReadonlyArray<unknown>
  readonly remaining: number
  readonly refusals?: ReadonlyArray<Refusal> | undefined
}

const refusalOf = (error: TrellisError): Refusal => ({ code: error.code, path: error.path, message: error.message })

const mint = (refused: Refused): TrellisError =>
  new TrellisError({
    code: refused.code,
    path: refused.path,
    message: refused.message,
    cause: refused.refusals === undefined
      ? { rounds: refused.rounds, remaining: refused.remaining }
      : {
        rounds: refused.rounds,
        remaining: refused.remaining,
        refusals: refused.refusals
      }
  })

/**
 * Fails a round with a {@link TrellisError}. A plan holds only data while its
 * graph is built, and an error is a class instance, so the refusal travels as
 * data and is minted when the round runs.
 */
const refuse = <R>(refused: Refused): Node.Node<unknown, unknown, R> =>
  Node.bindPlanned(
    Node.map(Node.succeed(refused), Node.capture({ refused: refused.code }, mint)),
    Node.capture({ refused: refused.code }, (failure: Planned.Planned<TrellisError>) => Node.fail(failure))
  )

/**
 * Declares a trellis that runs the plans a model authors, one durable round
 * per plan.
 *
 * The first round calls `author` with the caller's `input` and hands the plan
 * off to the next round with the `To` outcome `@smthrs/flow` defines. A round
 * receives its plan as payload, so it is real data while that round's graph is
 * built: the round validates it against the envelope and the fuel left, and
 * compiles it with {@link compile} into exactly the leaf calls it names, with
 * their goals, seats, and plan paths. Each round is its own journal segment,
 * so a crash resumes at the round boundary and never re-authors a settled
 * plan.
 *
 * When `continue` is supplied, a settled round calls it with a
 * {@link Continuation} and hands its answer to the next round; otherwise, or
 * when the answer names no work, the trellis settles with a {@link RunResult}.
 * Fuel is charged per leaf after a round validates, so every round costs at
 * least one unit and the lineage ends within `fuel` plan rounds, plus one that
 * can only refuse. The flow's `maxRounds` is `fuel + 2` as a backstop. A
 * `round` handed in by a caller is checked against its own history: a round
 * number or fuel balance its settled rounds and the envelope do not account
 * for fails `invalid_envelope`.
 *
 * A refused plan fails the round with a {@link TrellisError} whose `cause`
 * carries `rounds` (the settled residue), `remaining`, and, for a validation
 * refusal, every reason in `refusals` as `{ code, path, message }` data, so a
 * durable engine can journal it. No leaf of a refused plan runs. A leaf
 * failure fails the round with the leaf's own error.
 *
 * `make` throws `invalid_envelope` for a bound that is not a positive safe
 * integer, and snapshots its options at the call.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): TrellisFlow<R> => {
  // The body runs when each round is planned, later than this call, so it
  // reads these snapshots and never the caller's options again.
  const envelope = copiedEnvelope(options.envelope)
  const author = options.author
  const leaf = options.leaf
  const continuation = options.continue
  const invalid = admissionRefusal({ envelope })
  if (invalid !== undefined) throw invalid
  const captured = {
    fuel: envelope.fuel,
    depth: envelope.depth,
    fanout: envelope.fanout,
    continue: continuation !== undefined
  }
  const { name, description } = Compose.label(
    "trellis",
    {
      fuel: envelope.fuel,
      depth: envelope.depth,
      fanout: envelope.fanout
    },
    options,
    [author, leaf, continuation]
  )
  const runRound = (
    input: unknown,
    state: typeof RoundState.Type
  ): Node.Node<unknown, unknown, R> => {
    const { plan: authored, remaining, round } = state
    // The state is payload a caller could hand in directly, so its round
    // number and fuel are checked against its own settled history before the
    // round pays for anything: a round follows every settled one, and the fuel
    // left is the envelope's less what those rounds' plans cost.
    if (!consistent(state, envelope)) {
      return refuse({
        code: "invalid_envelope",
        path: "root",
        message: `Trellis round ${round} claims ${remaining} fuel, which its settled rounds and the envelope fuel ` +
          `${envelope.fuel} do not account for`,
        rounds: [],
        remaining: 0
      })
    }
    const rounds = state.rounds as ReadonlyArray<Round>
    const refusals = validate(authored, envelope)
    if (refusals.length > 0) {
      return refuse({ ...refusalOf(refusals[0] as TrellisError), rounds, remaining, refusals: refusals.map(refusalOf) })
    }
    const plan = authored as Plan
    const cost = leaves(plan).length
    if (cost > remaining) {
      return refuse({
        code: "fuel_exhausted",
        path: "root",
        message: `Round ${round} needs ${cost} leaf calls but only ${remaining} fuel remains`,
        rounds,
        remaining
      })
    }
    const left = remaining - cost
    const marks = { ...captured, round, remaining: left }
    return Node.bindPlanned(
      compile(plan, { leaf }),
      Node.capture(marks, (result: Planned.Planned<unknown>) => {
        const settled = [...rounds, { plan, result }]
        const done = (): Node.Node<unknown, unknown, R> => Flow.done({ rounds: settled, remaining: left })
        if (continuation === undefined) return done()
        return Node.branch(callMember(continuation, { plan, result, round, remaining: left }), {
          // A continuation is a request for another round. Nothing (`null`, the
          // JSON a durable step can answer, or `undefined`), or a plan that
          // names no work, is the same answer: the trellis is done.
          if: Node.capture(
            marks,
            (next: unknown) => next === null || next === undefined || namesNoWork(next, envelope.depth)
          ),
          then: () => done(),
          else: (next) => self.to({ input, round: { plan: next, round: round + 1, remaining: left, rounds: settled } })
        })
      })
    )
  }
  const body = (payload: typeof Payload.Type): Node.Node<unknown, unknown, R> =>
    payload.round !== undefined
      ? runRound(payload.input, payload.round)
      : Node.bindPlanned(
        callMember(author, payload.input),
        Node.capture(captured, (plan: Planned.Planned<unknown>) =>
          self.to({
            input: payload.input,
            round: { plan, round: 1, remaining: envelope.fuel, rounds: [] }
          }))
      )
  // The body names the flow it is the body of, which is how one round opens
  // the next. It is read when a round is planned, long after `Flow.make` has
  // returned, so the binding is initialized by then.
  const self: TrellisFlow<R> = Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: Payload,
    success: Schema.Unknown,
    // A trellis fails with a `TrellisError`, which the durable engine encodes
    // through its schema, or with whatever the author, a leaf, or the
    // continuation failed with.
    error: FailureSchema.schemaFor([TrellisError], [author, leaf, continuation]) as typeof Failure,
    // The author round, at most `fuel` plan rounds, and one more round that
    // can only refuse a plan the remaining fuel cannot pay for.
    maxRounds: envelope.fuel + 2,
    body: Node.capture(captured, body)
  })
  return self
}
