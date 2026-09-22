/**
 * The release gate's checks and the topology that batches them.
 *
 * It lives beside `16-fan-out-fan-in.ts` rather than inside it because two
 * modules declare the same gate: that example, which names it in code, and
 * `16-project/flows/gate/flow.ts`, which is the file a project puts on disk for
 * discovery to find. A shared declaration that lived in either one would make
 * the other import it back, and a module cycle is not a shape a flow file can
 * have: discovery imports the file to run it.
 */
import { Action } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"

/**
 * One check, and the verdict it reports.
 *
 * `after` carries the verdicts the previous batch reported. It is declared
 * rather than ambient because it is the dependency edge: a check that names no
 * predecessor is free to start immediately, and one that names a batch waits
 * for it. The first batch passes `null`.
 */
export const Check = Action.make("examples/Check", {
  payload: {
    name: Schema.String,
    target: Schema.String,
    after: Schema.Json
  },
  success: Schema.String
})

/** The fan-in step: five verdicts arrive as payload fields, one report leaves. */
export const Collect = Action.make("examples/Collect", {
  payload: {
    lint: Schema.String,
    types: Schema.String,
    unit: Schema.String,
    audit: Schema.String,
    licence: Schema.String
  },
  success: Schema.String
})

/** One declared check: what it is called and how urgent it is. */
export interface CheckSpec {
  readonly name: string
  readonly priority: number
}

/**
 * The gate's checks, in declaration order.
 *
 * `audit` blocks a release and `licence` is nearly as urgent, so both carry a
 * priority. The other three state none and keep declaration order behind them.
 */
export const specs: ReadonlyArray<CheckSpec> = [
  { name: "lint", priority: 0 },
  { name: "types", priority: 0 },
  { name: "unit", priority: 0 },
  { name: "audit", priority: 9 },
  { name: "licence", priority: 5 }
]

/**
 * Splits checks into batches of at most `concurrency`, highest priority first
 * and declaration order among equals.
 *
 * The sort is total, so a plan built twice from the same list is identical.
 * That matters, because the batch a check lands in is part of the topology the
 * step keys are derived from.
 *
 * The bound is checked before anything is sorted, because the loop below
 * advances by it: zero never advances, a negative moves away from termination,
 * and a fractional or non-finite bound groups checks the doc line above does
 * not describe. The caller here states a literal, so a refusal is a defect in
 * this example rather than an error to handle, which is why it throws.
 */
export const batches = (
  checks: ReadonlyArray<CheckSpec>,
  concurrency: number
): ReadonlyArray<ReadonlyArray<string>> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`batch concurrency must be a positive integer: ${concurrency}`)
  }
  const order = checks
    .map((spec, index) => ({ spec, index }))
    .sort((left, right) => right.spec.priority - left.spec.priority || left.index - right.index)
    .map((entry) => entry.spec.name)
  const grouped: Array<ReadonlyArray<string>> = []
  for (let offset = 0; offset < order.length; offset += concurrency) {
    grouped.push(order.slice(offset, offset + concurrency))
  }
  return grouped
}

/** The batches the gate declares, before anything runs. */
export const declaredBatches: ReadonlyArray<ReadonlyArray<string>> = batches(specs, 2)

const priorityOf = (name: string): number => specs.find((spec) => spec.name === name)?.priority ?? 0

/** The requirements the gate's two actions carry. */
export type GateRequirements = Action.Requirement<"examples/Check" | "examples/Collect">

/**
 * The gate's topology, given the thing being gated.
 *
 * It is a plain function so both declarations can share it: one is named in
 * code, the other is the file on disk. A body is an ordinary function of its
 * payload, so "the same gate under two declarations" needs no indirection
 * beyond this.
 */
export const gateBody = (target: string): Node.Node<string, never, GateRequirements> => {
  const stage = (
    index: number,
    after: Schema.Json,
    collected: Readonly<Record<string, Planned.Planned<string>>>
  ): Node.Node<string, never, GateRequirements> => {
    const batch = declaredBatches[index]
    if (batch === undefined) {
      return Collect.call({
        lint: collected.lint!,
        types: collected.types!,
        unit: collected.unit!,
        audit: collected.audit!,
        licence: collected.licence!
      })
    }
    const members: Record<string, Node.Node<string, never, Action.Requirement<"examples/Check">>> = {}
    for (const name of batch) {
      members[name] = Node.priority(Check.call({ name, target, after }), priorityOf(name))
    }
    return Node.bindPlanned(
      Node.all(members),
      (verdicts: Planned.Planned<Readonly<Record<string, string>>>) => {
        const next: Record<string, Planned.Planned<string>> = { ...collected }
        const fields = verdicts as unknown as Readonly<Record<string, Planned.Planned<string>>>
        for (const name of batch) next[name] = fields[name]!
        return stage(index + 1, verdicts as unknown as Schema.Json, next)
      }
    )
  }
  return stage(0, null, {})
}
