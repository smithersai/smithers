/**
 * Workspace-only test support shared by target consumers.
 *
 * Reads the action calls one target plans, and the success value it shapes.
 *
 * A rule's argv lives in its `implementation`, which is the Flow body. Nothing
 * runs here: the body is evaluated against the target's own validated attrs
 * and the resulting plan AST is interpreted, so an argv assertion is about the
 * plan a declaration produces rather than about spawning anything.
 *
 * The interpreter stands each call in for its own result, which is what makes
 * the success shape readable: a rule that combines two runs into one record
 * reports which run landed under which field, and a `map` that never runs is
 * a rule whose success value nothing proved.
 */
import * as Node from "@smthrs/plan/Node"
import * as Target from "../src/Target.ts"

/** One planned action call: which action, and the payload it carries. */
export interface PlannedCall {
  readonly action: string
  readonly payload: Record<string, unknown>
}

/**
 * Interprets one plan AST, recording every call and returning the value the
 * plan's own maps and continuations shape out of them.
 */
const evaluate = (
  ast: Node.Ast,
  calls: Array<PlannedCall>,
  result: (call: PlannedCall) => unknown
): unknown => {
  switch (ast._tag) {
    case "Succeed": {
      return ast.value
    }
    case "ActionCall": {
      const call: PlannedCall = { action: ast.action, payload: ast.payload as Record<string, unknown> }
      calls.push(call)
      return result(call)
    }
    case "FlowCall": {
      const call: PlannedCall = { action: ast.flow, payload: ast.payload as Record<string, unknown> }
      calls.push(call)
      return result(call)
    }
    case "All": {
      const value: Record<string, unknown> = {}
      for (const [name, nested] of Object.entries(ast.nodes)) value[name] = evaluate(nested, calls, result)
      return value
    }
    case "Map": {
      const first = evaluate(ast.first, calls, result)
      const mapper = Node.mapper(ast)
      return mapper === undefined ? first : mapper(first)
    }
    case "AndThen": {
      const first = evaluate(ast.first, calls, result)
      // The continuation is only reachable through the side table the plan
      // package keeps for the interpreter; evaluating it against the upstream
      // call is what graph building itself does.
      const build = Node.continuation(ast)
      if (build !== undefined) {
        const next = build(first as never)
        return Node.isNode(next) ? evaluate(next.ast, calls, result) : next
      }
      return ast.next === undefined ? first : evaluate(ast.next, calls, result)
    }
    case "Branch": {
      return evaluate(ast.first, calls, result)
    }
    case "Catch": {
      return evaluate(ast.protected, calls, result)
    }
  }
}

/** Interprets one target's body against its own validated attrs. */
const interpret = (
  target: Target.AnyTarget,
  result: (call: PlannedCall) => unknown = (call) => call
): { readonly calls: Array<PlannedCall>; readonly value: unknown } => {
  const calls: Array<PlannedCall> = []
  const value = evaluate(Target.plan(target).ast, calls, result)
  return { calls, value }
}

/** Every action call one target's plan records, in order. */
export const plannedCalls = (target: Target.AnyTarget): ReadonlyArray<PlannedCall> => interpret(target).calls

/**
 * The success value one target's plan shapes, with each planned call standing
 * in for its own result.
 */
export const plannedValue = (
  target: Target.AnyTarget,
  result?: (call: PlannedCall) => unknown
): unknown => interpret(target, result).value

/** The argv of the first exec-shaped call one target plans. */
export const plannedArgv = (target: Target.AnyTarget): ReadonlyArray<string> => {
  const call = plannedCalls(target).find((entry) => Array.isArray(entry.payload["argv"]))
  if (call === undefined) throw new Error(`${Target.metadata(target).target} plans no exec call`)
  return call.payload["argv"] as ReadonlyArray<string>
}
