/**
 * One seam that runs a pattern's declared form and its `run` form on the same
 * scripted members and requires the same outcome.
 *
 * Every dual-form pattern has two engines: `make` declares a flow the
 * interpreter executes, and `run` is an in-memory Effect. Topology tests pin
 * `make` and behavior tests pin `run`, so a divergence between them is
 * invisible unless something executes both on the same inputs. This module is
 * that something.
 *
 * A role is scripted ONCE, as a pure answer from the payload it is handed. The
 * declared form calls it as an action, because a flow body answers while the
 * graph builds and cannot see a run-time value; the run form calls it as an
 * Effect. Both record the call on a tape, so a case compares the settled
 * results and the multiset of roles each form called, per role, in order.
 */
import { Action, Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { type Executable, execute } from "./Execute.ts"

/**
 * Every field any dual-form pattern hands a member. An action declares its
 * payload, so one shared optional struct covers every role; a field outside it
 * would be dropped by the decode, which the answers below never read.
 */
const fields = Object.fromEntries(
  [
    "alert",
    "applied",
    "attempt",
    "authored",
    "authoring",
    "baseline",
    "board",
    "budget",
    "candidate",
    "check",
    "column",
    "comparison",
    "completed",
    "context",
    "continuation",
    "depth",
    "derisk",
    "deriskExhausted",
    "derisked",
    "dryRun",
    "elevated",
    "envelope",
    "error",
    "failure",
    "feedback",
    "fixes",
    "fuel",
    "goal",
    "id",
    "index",
    "input",
    "issue",
    "issues",
    "item",
    "items",
    "iteration",
    "leaf",
    "leafIndex",
    "leaves",
    "level",
    "mapped",
    "opinions",
    "output",
    "outputs",
    "path",
    "phase",
    "plan",
    "plans",
    "position",
    "previous",
    "primary",
    "priority",
    "prompt",
    "proponent",
    "proposal",
    "ran",
    "reason",
    "remaining",
    "request",
    "result",
    "results",
    "retriable",
    "review",
    "risk",
    "role",
    "round",
    "rounds",
    "rung",
    "scope",
    "score",
    "scores",
    "seat",
    "settlement",
    "shadow",
    "shard",
    "snapshot",
    "stage",
    "state",
    "step",
    "task",
    "tasks",
    "tier",
    "transcript",
    "value",
    "verdict",
    "work",
    "workerType"
  ].map((name) => [name, Schema.optional(Schema.Unknown)])
) as Record<string, Schema.optional<Schema.Unknown>>

const Failure = Symbol.for("@smthrs/patterns/test/Parity/Failure")

/** An answer that fails the member with `error` instead of succeeding. */
export interface Failed {
  readonly [Failure]: unknown
}

/** Makes a role fail with `error`, identically in both forms. */
export const fail = (error: unknown): Failed => ({ [Failure]: error })

const isFailed = (value: unknown): value is Failed => typeof value === "object" && value !== null && Failure in value

/** A role's scripted answer, computed from the payload the pattern hands it. */
export type Answer = (payload: any) => unknown

/** Roles by name. */
export type Script = Readonly<Record<string, Answer>>

/** One recorded member call. */
export interface Call {
  readonly role: string
  readonly payload: Readonly<Record<string, unknown>>
}

const declarations = new Map<string, ReturnType<typeof declare>>()

const declare = (role: string) =>
  Action.make(`parity/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown
  })

/**
 * The action a role is called through. Declarations are memoized by role, so a
 * case that calls `scripted` twice gets the same step identity both times.
 */
export const action = (role: string): ReturnType<typeof declare> => {
  const existing = declarations.get(role)
  if (existing !== undefined) return existing
  const declared = declare(role)
  declarations.set(role, declared)
  return declared
}

const flows = new Map<string, Flow.Any>()

/**
 * A role called through a whole flow, for the pattern options that take a
 * `Flow` rather than any member (an approval, a decorated stage). The flow's
 * body passes its payload to the role's action, so the answer is still read at
 * run time.
 */
export const flow = (role: string): Flow.Any => {
  const existing = flows.get(role)
  if (existing !== undefined) return existing
  const declared = Flow.make(`parity-flow/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: (payload: Readonly<Record<string, unknown>>) => action(role).call(payload as never)
  }) as unknown as Flow.Any
  flows.set(role, declared)
  return declared
}

/**
 * A role called as an approval flow: `WithApproval` binds it to the slot
 * `{ input, reason, scope }`, so its payload is exactly that struct.
 */
export const approval = (role: string): Flow.Any => {
  const key = `approval:${role}`
  const existing = flows.get(key)
  if (existing !== undefined) return existing
  const declared = Flow.make(`parity-approval/${role}`, {
    payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
    success: Schema.Literal("approved"),
    error: Schema.Unknown,
    body: (payload) => action(role).call(payload as never) as never
  }) as unknown as Flow.Any
  flows.set(key, declared)
  return declared
}

const answerWith = (answer: Answer, payload: unknown): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    const value = answer(payload)
    return isFailed(value) ? Effect.fail(value[Failure]) : Effect.succeed(value)
  })

const record = (tape: Array<Call>, role: string, payload: unknown): void => {
  tape.push({
    role,
    payload: typeof payload === "object" && payload !== null ? { ...payload } : { value: payload }
  })
}

/** Members for `make`, effects for `run`, and the tapes they record. */
export interface Scripted {
  readonly members: Readonly<Record<string, ReturnType<typeof declare>>>
  readonly effects: Readonly<Record<string, (payload: any) => Effect.Effect<any, any>>>
  readonly layer: Layer.Layer<any, any, any>
  readonly declaredTape: Array<Call>
  readonly ranTape: Array<Call>
}

/** Builds both forms of every role in `script`, each recording to its own tape. */
export const scripted = (script: Script): Scripted => {
  const declaredTape: Array<Call> = []
  const ranTape: Array<Call> = []
  const entries = Object.entries(script)
  const members = Object.fromEntries(entries.map(([role]) => [role, action(role)]))
  const effects = Object.fromEntries(
    entries.map(([role, answer]) => [
      role,
      (payload: unknown) =>
        Effect.suspend(() => {
          record(ranTape, role, payload)
          return answerWith(answer, payload)
        })
    ])
  )
  const layers = entries.map(([role, answer]) =>
    action(role).toLayer((payload) =>
      Effect.suspend(() => {
        record(declaredTape, role, payload)
        return answerWith(answer, payload)
      })
    )
  )
  return {
    members,
    effects,
    layer: Layer.mergeAll(...(layers as unknown as [Layer.Layer<any, any, any>])),
    declaredTape,
    ranTape
  }
}

/** A settled outcome: the success value, or `{ failed }`. */
export type Settled = unknown

/** Settles a declared flow, turning a rejection into `{ failed }`. */
export const settleDeclared = (
  flow: Executable,
  payload: unknown,
  executionId: string,
  layer: Layer.Layer<any, any, any>
): Promise<Settled> =>
  execute(flow, payload, executionId, layer).then((ok) => ok, (error: unknown) => ({ failed: error }))

/** Settles a run effect, turning a failure into `{ failed }`. */
export const settleRun = (effect: Effect.Effect<unknown, unknown, never>): Promise<Settled> =>
  Effect.runPromise(Effect.match(effect, { onFailure: (error) => ({ failed: error }), onSuccess: (ok) => ok }))

/** The roles a tape called, in order. */
export const roles = (tape: ReadonlyArray<Call>): ReadonlyArray<string> => tape.map((call) => call.role)

/**
 * The calls each role received, in order. Two concurrent roles may interleave
 * differently in the two forms; one role's own sequence may not.
 */
export const byRole = (tape: ReadonlyArray<Call>): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {}
  for (const call of tape) counts[call.role] = (counts[call.role] ?? 0) + 1
  return counts
}

/** What one parity case states. */
export interface Case<Options> {
  readonly name: string
  readonly script: Script
  /** The declared flow's payload; `{ input }` when omitted. */
  readonly payload?: unknown
  /** The value `run` is handed; the declared payload's `input` when omitted. */
  readonly input?: unknown
  readonly options: Options
  /** The outcome both forms must settle to, when the case pins one. */
  readonly expected?: unknown
  /** Require the same role ORDER, not only the same counts per role. */
  readonly ordered?: boolean
  /**
   * A KNOWN divergence, stated as why the two forms disagree. Both halves are
   * then pinned on their own, `expected` for `run` and `declared` for the
   * declared form, and the case asserts that they still disagree, so fixing
   * the pattern fails the case until this entry is deleted: the registry
   * cannot outlive the defect, and neither half can drift unseen.
   */
  readonly diverges?: string
  /** The declared form's own outcome, pinned when the case `diverges`. */
  readonly declared?: unknown
}

/** How one pattern is driven from a scripted case. */
export interface Pattern<Options> {
  readonly make: (members: Scripted["members"], options: Options) => Executable
  readonly run: (
    effects: Scripted["effects"],
    input: any,
    options: Options
  ) => Effect.Effect<unknown, unknown, never>
  readonly cases: ReadonlyArray<Case<Options>>
}

/** What a failure is compared by: its code and message when it has them. */
const comparable = (settled: Settled): unknown => {
  if (typeof settled !== "object" || settled === null || !("failed" in settled)) return settled
  const error = (settled as { readonly failed: unknown }).failed
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return { failed: { code: error.code, message: error.message } }
  }
  return settled
}

let executions = 0

/** Runs one case through both forms and returns what each settled to and called. */
export const both = async <Options>(
  pattern: Pattern<Options>,
  scenario: Case<Options>
): Promise<{
  readonly declared: Settled
  readonly ran: Settled
  readonly declaredTape: ReadonlyArray<Call>
  readonly ranTape: ReadonlyArray<Call>
}> => {
  const forms = scripted(scenario.script)
  const payload = scenario.payload ?? { input: scenario.input }
  const input = "input" in scenario ? scenario.input : (payload as { readonly input?: unknown }).input
  const declared = await settleDeclared(
    pattern.make(forms.members, scenario.options),
    payload,
    `parity-${++executions}-${scenario.name}`,
    forms.layer
  )
  const ran = await settleRun(pattern.run(forms.effects, input, scenario.options))
  return { declared, ran, declaredTape: forms.declaredTape, ranTape: forms.ranTape }
}

/** Asserts one case: same settled outcome, same calls per role, and `expected`. */
export const check = async <Options>(pattern: Pattern<Options>, scenario: Case<Options>): Promise<void> => {
  const { declared, declaredTape, ran, ranTape } = await both(pattern, scenario)
  if (scenario.diverges !== undefined) {
    expect(
      [comparable(declared), byRole(declaredTape)],
      `known divergence no longer diverges; delete its entry: ${scenario.diverges}`
    ).not.toEqual([comparable(ran), byRole(ranTape)])
    expect(comparable(ran), "run's own outcome").toEqual(comparable(scenario.expected))
    expect(comparable(declared), "the declared form's own outcome").toEqual(comparable(scenario.declared))
    return
  }
  expect(comparable(declared), "declared and run settle to the same outcome").toEqual(comparable(ran))
  expect(byRole(declaredTape), "declared and run call each role the same number of times").toEqual(byRole(ranTape))
  if (scenario.ordered === true) {
    expect(roles(declaredTape), "declared and run call roles in the same order").toEqual(roles(ranTape))
  }
  if ("expected" in scenario) expect(comparable(declared)).toEqual(comparable(scenario.expected))
}
