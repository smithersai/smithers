/**
 * The completion its own cell wrote before reading the calls it made.
 *
 * Several `cell` blocks in one reply run as one program, and the model writes
 * the whole program before any call in it settles. A reply that probes and
 * answers — `const seen = await ctx.call("bash", …)`, `console.log(seen)`,
 * then `ctx.done(…)` — therefore completes the run before the model has read
 * a byte of what it asked to see. Real seats do this about once in three
 * deliveries even when their prompt says to answer in a later reply, and the
 * answer is either an unverified claim or "blocked: output not observed".
 *
 * ## The rule, and what it spares
 *
 * A completion is handed back, once per run, when its own cell made a call,
 * kept that call's result, and left it for the model alone: printed or
 * bound, and read by nothing in the program but `console.*`, so the
 * completion reads no result either. The next frame is shown the results and
 * asked to answer after reading them.
 *
 * Three shapes are spared because nothing in them was written blind:
 *
 * - a completion that reads a call's result — in its output, or in a guard
 *   around it. `if (after.exitCode === 0) ctx.done(…)` is the shape the cell
 *   contract teaches: the program, not the model's memory, decides the
 *   verdict. Reading is transitive through the program's own bindings, so
 *   `result.summary = seen.stdout; ctx.done(JSON.stringify(result))` reads.
 * - a cell whose program acts on a result: passes it into another call, or
 *   branches on it. The contract teaches deriving later inputs from earlier
 *   results inside one cell, and a cell that asked, saved the answer and
 *   completed did what it set out to do without the model reading anything.
 * - a cell whose calls are all effects whose result it discarded, such as
 *   `await ctx.call("edit", …)` as a statement of its own. The cell never
 *   asked to see anything, and a failed effect is `FailedCall`'s demand.
 *
 * The reading is a parse of the cell's source, so it is a pure function of
 * the cell and a replay reaches the same decision. It reads names, not
 * scopes, and what it cannot resolve — a completion reached through an alias
 * — reads as blind: the price of a wrong refusal is one frame, bounded by
 * {@link cap}, and the price of a wrong pass is the answer this exists for.
 *
 * @since 1.0.0-rc.1
 * @private
 */
import { parse } from "@babel/parser"
import type * as Syntax from "@babel/types"

/**
 * How many completions one run may have handed back for unread calls.
 *
 * One, like every measured demand: the frame that answers it has read the
 * results, and asking again would be the loop grading that answer.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const cap = 1

/**
 * The heading of the demand, so a transcript and a test can find it.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const heading = "Answer written before its calls returned"

/** The frame accounting's view of one settled call. */
interface Settled {
  readonly flow: string
  readonly ok: boolean
  readonly ordinal: number
  readonly summary: string
}

/**
 * One call a completion was written without reading.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export interface Unobserved {
  readonly flow: string
  readonly ok: boolean
  readonly ordinal: number
  readonly summary: string
}

type Node = Syntax.Node

const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"

/** Keys that hold positions, comments and parser detail rather than children. */
const skipped = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"])

const children = (node: Node): ReadonlyArray<Node> => {
  const found: Array<Node> = []
  for (const [key, value] of Object.entries(node)) {
    if (skipped.has(key)) continue
    if (Array.isArray(value)) { for (const item of value) if (isNode(item)) found.push(item) }
    if (isNode(value)) found.push(value)
  }
  return found
}

const ctxMember = (node: Node, name: string): boolean =>
  (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed &&
  node.object.type === "Identifier" && node.object.name === "ctx" &&
  node.property.type === "Identifier" && node.property.name === name

const ctxCall = (node: Node, name: string): boolean =>
  (node.type === "CallExpression" || node.type === "OptionalCallExpression") && ctxMember(node.callee, name)

/**
 * The nodes a reference can hide in: a non-computed property or key names
 * nothing, so `x.seen` does not read `seen`.
 */
const referencing = (node: Node): ReadonlyArray<Node> => {
  switch (node.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return node.computed ? [node.object, node.property] : [node.object]
    case "ObjectProperty":
      return node.computed ? [node.key, node.value] : [node.value]
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassPrivateMethod":
      return [...node.params, node.body]
    default:
      return children(node)
  }
}

/** Whether an expression makes a call or reads a name that holds a result. */
const reads = (node: Node, results: ReadonlySet<string>): boolean => {
  if (ctxCall(node, "call")) return true
  if (node.type === "Identifier") return results.has(node.name)
  return referencing(node).some((child) => reads(child, results))
}

/** The names a binding or assignment target writes; a member target writes its root. */
const targets = (node: Node): ReadonlyArray<string> => {
  switch (node.type) {
    case "Identifier":
      return [node.name]
    case "MemberExpression":
    case "OptionalMemberExpression":
      return targets(node.object)
    case "ObjectPattern":
      return node.properties.flatMap((property) => targets(property.type === "RestElement" ? property : property.value))
    case "ArrayPattern":
      return node.elements.flatMap((element) => element === null ? [] : targets(element))
    case "RestElement":
      return targets(node.argument)
    case "AssignmentPattern":
      return targets(node.left)
    default:
      return []
  }
}

/** The names `ctx` and `console` are the realm's, never a result's. */
const realm = new Set(["ctx", "console"])

/** Every way the program moves a value into a name: `[targets, source]`. */
const flows = (root: Node): ReadonlyArray<readonly [ReadonlyArray<string>, Node]> => {
  const found: Array<readonly [ReadonlyArray<string>, Node]> = []
  const visit = (node: Node): void => {
    switch (node.type) {
      case "VariableDeclarator":
        if (node.init !== null && node.init !== undefined) found.push([targets(node.id), node.init])
        break
      case "AssignmentExpression":
        found.push([targets(node.left), node.right])
        break
      case "FunctionDeclaration":
        // A script's function declaration always has a name; only a module's
        // default export may omit it, and a cell is never a module.
        found.push([[node.id!.name], node.body])
        break
      case "ForOfStatement":
      case "ForInStatement":
        found.push([
          targets(node.left.type === "VariableDeclaration" ? node.left.declarations[0]!.id : node.left),
          node.right
        ])
        break
      case "CallExpression":
      case "OptionalCallExpression":
        // `results.push(seen)` keeps a result in `results`.
        if (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") {
          for (const argument of node.arguments) found.push([targets(node.callee.object), argument])
        }
        break
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  return found.map(([names, source]) => [names.filter((name) => !realm.has(name)), source] as const)
}

/** Every name that holds, directly or through the program's own bindings, a call's result. */
const resultNames = (root: Node): ReadonlySet<string> => {
  const moves = flows(root)
  const results = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [names, source] of moves) {
      if (names.every((name) => results.has(name)) || !reads(source, results)) continue
      for (const name of names) results.add(name)
      grew = true
    }
  }
  return results
}

/**
 * Whether the program acts on a result: reads one in a call's input, in the
 * completion's output, or in a condition — the guard a completion sits under
 * included. A read inside `console.*` is addressed to the model, and one that
 * only copies a result into another name is followed through that name.
 */
const actsOn = (root: Node, results: ReadonlySet<string>): boolean => {
  const visit = (node: Node, acting: boolean): boolean => {
    if (node.type === "Identifier") return acting && results.has(node.name)
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") &&
      node.callee.object.type === "Identifier" && node.callee.object.name === "console"
    ) return false
    if (ctxCall(node, "call") || ctxCall(node, "done")) {
      return (node as Syntax.CallExpression).arguments.some((argument) => visit(argument, true))
    }
    switch (node.type) {
      case "IfStatement":
      case "ConditionalExpression":
      case "WhileStatement":
      case "DoWhileStatement":
        if (visit(node.test, true)) return true
        break
      case "LogicalExpression":
        if (visit(node.left, true)) return true
        break
      case "SwitchStatement":
        if (visit(node.discriminant, true)) return true
        break
      case "SwitchCase":
        if (node.test != null && visit(node.test, true)) return true
        break
    }
    return referencing(node).some((child) => visit(child, acting))
  }
  return visit(root, false)
}

/** Whether a call's result is used at all, rather than discarded as a statement of its own. */
const keepsResult = (root: Node): boolean => {
  const calls: Array<Node> = []
  const discarded = new Set<Node>()
  const visit = (node: Node): void => {
    if (ctxCall(node, "call")) calls.push(node)
    if (node.type === "ExpressionStatement" || (node.type === "UnaryExpression" && node.operator === "void")) {
      const inner = node.type === "ExpressionStatement" ? node.expression : node.argument
      discarded.add(inner.type === "AwaitExpression" ? inner.argument : inner)
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  return calls.some((call) => !discarded.has(call))
}

/**
 * Whether a completing cell's source wrote its completion blind: it kept a
 * call's result for the model alone and completed from code that reads none.
 * A source that does not parse is never read as blind, because nothing here
 * can say what it did.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const blind = (source: string): boolean => {
  let program: Syntax.File
  try {
    program = parse(source, {
      sourceType: "script",
      plugins: ["typescript"],
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true
    })
  } catch {
    return false
  }
  if (!keepsResult(program.program)) return false
  return !actsOn(program.program, resultNames(program.program))
}

/**
 * The calls a completion was written without reading, oldest first: every
 * call its own frame settled, when the cell wrote the completion blind.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const find = (calls: ReadonlyArray<Settled>, source: string): ReadonlyArray<Unobserved> =>
  calls.length === 0 || !blind(source)
    ? []
    : calls.map((call) => ({ flow: call.flow, ok: call.ok, ordinal: call.ordinal, summary: call.summary }))

/**
 * The demand a blind completion is handed back with: the results it never
 * read, then the correction.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const demand = (calls: ReadonlyArray<Unobserved>): string =>
  `${heading}:
${calls.map((call) => `- ${call.ordinal}. ${call.flow} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`).join("\n")}

Answer after reading the calls' output, in a reply of its own.`
