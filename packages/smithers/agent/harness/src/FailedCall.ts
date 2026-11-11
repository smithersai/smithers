/**
 * The completion its own cell wrote before a call in it failed.
 *
 * A cell is authored blind: the model writes the whole program, `ctx.done`
 * included, before any call in it settles, and a failed call resolves
 * `{ ok: false, error }` rather than throwing, so the rest of the cell runs.
 * A cell that makes a request and completes in the same program therefore
 * reports the request as made whatever the request did. The sentence is not a
 * lie the model told; it is a sentence written about a result that did not
 * exist yet.
 *
 * It is not hypothetical. A TUI coordinator on a small seat ran
 * `ctx.call("agent.delegate", …)` and `ctx.done("Delegated the estimation
 * system design to codex astra.")` in one cell. The delegation failed with
 * "Three workers are active; wait for a completion", the cell ran on, and the
 * user was told work was running that never started.
 *
 * ## What the harness does, and why it reads no prose
 *
 * The rule is structural. A completion whose own frame settled a failed call
 * was written before that failure existed, and no earlier frame showed it to
 * the model. The harness cannot decide from the sentence whether it states
 * the failure, and it does not try: it hands the frame back once with the
 * failure, as a demand, so the next completion is written by a model that has
 * read the result. Two exact tests spare a failed call the cell was written to
 * handle: a cell whose code reads the `ok` or `error` of the envelope that
 * call returned, the branch the cell prompt teaches, and a completion that
 * already quotes the flow's own failure reason. Each is decided per failed
 * call: a branch on another call's envelope, or `ok` in a string or a comment,
 * spares nothing. Neither reads what the claim means; each reads whether the
 * claim could have depended on the result at all.
 *
 * Where no frame is left to hand back, or the demand was already spent, the
 * completion stands with the failure appended to it by {@link state}. The
 * harness never lets a claim written before a failure be the whole answer, and
 * it never asks a model whether the claim is true: a weak seat's honesty is
 * not a control.
 *
 * @since 1.0.0-rc.1
 */

import type * as Syntax from "@babel/types"
import * as Source from "./internal/unobservedCall.ts"

type Node = Source.Node

/**
 * How many completions one run may have handed back for a failed call.
 *
 * One, like every measured demand: the answer to it is written by a model
 * that has read the failure, and asking twice would be the loop grading that
 * answer.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const cap = 1

/**
 * The heading of the demand, so a transcript and a test can find it.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const heading = "Call failed before completion"

/**
 * The line {@link state} appends a failure under.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const stated = "Failed before this answer was written:"

/**
 * One call a completing frame settled as a failure.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Failure {
  /** The flow the call named. */
  readonly flow: string
  /** What the flow said about its failure, verbatim; empty when it said nothing. */
  readonly message: string
}

/** The frame accounting's view of one settled call. */
interface Settled {
  readonly flow: string
  readonly ok: boolean
  readonly message: string | undefined
}

const reasonPrefix = /^Flow \S+ failed: /

/**
 * The flow's own words for why a call failed, without the harness's prefix.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const reason = (failure: Failure): string => failure.message.replace(reasonPrefix, "").trim()

/** Whether a member or pattern key spells an envelope's `ok` or `error`. */
const envelopeKey = (key: Node, computed: boolean): boolean => {
  const name = !computed && key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : ""
  return name === "ok" || name === "error"
}

/**
 * Whether a `ctx.call` site could have made a call to `flow`: it names that
 * flow, or names one only the run computes.
 */
const makes = (site: Node, flow: string | undefined): boolean => {
  const [named] = (site as Syntax.CallExpression).arguments
  return flow === undefined || named?.type !== "StringLiteral" || named.value === flow
}

/** Strips what only retypes or awaits a value: `(await r)!` is `r`. */
const unwrap = (node: Node): Node => {
  switch (node.type) {
    case "AwaitExpression":
      return unwrap(node.argument)
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return unwrap(node.expression)
    default:
      return node
  }
}

/** The names holding an envelope one of `sites` returned, directly or through the program's own copies. */
const holders = (moves: ReturnType<typeof Source.flows>, sites: ReadonlySet<Node>): ReadonlySet<string> => {
  const held = new Set<string>()
  const holds = (node: Node): boolean =>
    sites.has(node) ||
    (node.type === "Identifier" ? held.has(node.name) : Source.referencing(node).some(holds))
  for (let grew = true; grew;) {
    grew = false
    for (const [names, from] of moves) {
      if (names.every((name) => held.has(name)) || !holds(from)) continue
      for (const name of names) held.add(name)
      grew = true
    }
  }
  return held
}

/**
 * Whether a cell's code reads the `ok` or `error` of an envelope a call to
 * `flow` returned; of any call's envelope when `flow` is omitted.
 *
 * `r.ok`, `r?.error`, `r["ok"]`, `(await ctx.call(…)).ok` and
 * `const { ok, error } = r` all count when `r` holds that call's envelope,
 * directly or through the program's own bindings. Text in a string or a
 * comment never counts, nor does a method call such as `log.error(…)`, nor
 * the envelope of a call to another flow. A call made through code outside
 * the cell, such as a helper an earlier cell defined, cannot be traced to a
 * binding, so for a cell with no `ctx.call` that could have made it a read
 * of any name not holding another call's envelope counts. A cell that reads
 * the envelope wrote a branch for its failure, so its completion is not one
 * written blind.
 *
 * @category predicates
 * @since 1.0.0-rc.1
 */
export const inspects = (source: string, flow?: string): boolean => {
  const program = Source.parseCell(source)
  if (program === undefined) return false
  const all = new Set<Node>()
  const collect = (node: Node): void => {
    if (Source.ctxCall(node, "call")) all.add(node)
    for (const child of Source.children(node)) collect(child)
  }
  collect(program.program)
  const sites = new Set([...all].filter((site) => makes(site, flow)))
  const moves = Source.flows(program.program)
  // Untraceable: the call was made outside the cell, so any name but one
  // holding another call's envelope may hold it.
  const traced = sites.size > 0
  const held = holders(moves, traced ? sites : all)
  const envelope = (node: Node): boolean => {
    const inner = unwrap(node)
    if (inner.type === "MemberExpression" || inner.type === "OptionalMemberExpression") return envelope(inner.object)
    if (inner.type === "Identifier") return traced === held.has(inner.name)
    return sites.has(inner)
  }
  const destructures = (pattern: Node, from: Node | null | undefined): boolean =>
    pattern.type === "ObjectPattern" && from != null && envelope(from) &&
    pattern.properties.some((property) =>
      property.type === "ObjectProperty" && envelopeKey(property.key, property.computed)
    )
  const reads = (node: Node, callee: boolean): boolean => {
    switch (node.type) {
      case "MemberExpression":
      case "OptionalMemberExpression":
        if (!callee && envelopeKey(node.property, node.computed) && envelope(node.object)) {
          return true
        }
        break
      case "VariableDeclarator":
        if (destructures(node.id, node.init)) return true
        break
      case "AssignmentExpression":
        if (destructures(node.left, node.right)) return true
        break
      case "ForOfStatement":
        if (
          node.left.type === "VariableDeclaration" && destructures(node.left.declarations[0]!.id, node.right)
        ) return true
        break
      case "CallExpression":
      case "OptionalCallExpression":
        // `log.error(…)` calls a method; an envelope's `error` is not one.
        return reads(node.callee, true) || node.arguments.some((argument) => reads(argument, false))
    }
    return Source.children(node).some((child) => reads(child, false))
  }
  return reads(program.program, false)
}

/**
 * The failed calls a completion was written before, oldest first.
 *
 * Every call this frame settled with `ok: false`, except one whose envelope
 * the cell's source reads (see {@link inspects}) and one whose reason the
 * claim already quotes: that cell read the result and wrote from it. A branch
 * on one call's envelope spares no other call. A failure with no message is
 * named by its flow alone and is never quoted, so it is reported unless its
 * envelope is read.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const find = (calls: ReadonlyArray<Settled>, claim: string, source: string): ReadonlyArray<Failure> =>
  calls.flatMap((call): ReadonlyArray<Failure> => {
    if (call.ok || inspects(source, call.flow)) return []
    const failure = { flow: call.flow, message: call.message ?? "" }
    const said = reason(failure)
    return said !== "" && claim.includes(said) ? [] : [failure]
  })

const line = (failure: Failure): string => {
  const said = reason(failure)
  return said === "" ? `- ${failure.flow} failed` : `- ${failure.flow} failed: ${said}`
}

/**
 * The demand a completion over failed calls is handed back with.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const demand = (failures: ReadonlyArray<Failure>): string =>
  `${heading} — this cell completed after a call in it had already failed, so the answer was written before its result existed:

${failures.map(line).join("\n")}

Your answer is not the answer that stands yet. Retry the call if the failure is one you can fix, or complete again stating plainly what was not done and why. Never report failed work as requested, started or done.`

/**
 * The answer a completion stands on when it could not be handed back.
 *
 * The claim is kept, because the harness cannot tell a claim that states the
 * failure from one that does not, and the failure is appended in the flow's
 * own words, so a reader sees what happened whatever the claim says.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const state = (claim: string, failures: ReadonlyArray<Failure>): string =>
  failures.length === 0
    ? claim
    : [claim.trim(), [stated, ...failures.map(line)].join("\n")].filter((part) => part !== "").join("\n\n")
