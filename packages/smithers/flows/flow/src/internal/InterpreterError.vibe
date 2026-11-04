/**
 * The interpreter's refusal, in a module of its own so `Flow.Result` can
 * decode it without importing the interpreter that imports `Flow.Result`.
 * `Interpreter` exports it.
 *
 * @since 1.0.0
 * @internal
 */

import * as Schema from "effect/Schema"

/**
 * A graph the interpreter will not drive.
 *
 * Every code names something the run cannot recover from on its own: a graph
 * whose topology is incomplete, an action with no implementation wired up, a
 * call the interpreter does not execute, and a deferred function that did not
 * survive serialization beside its AST. `missing_implementation_version`
 * names a content-reusable action that lacks the canonical version contract;
 * `implementation_version_mismatch` names a declaration and registry that
 * disagree. Both are preflight failures, before action dispatch.
 * `join_mismatch` names a race, any, or quorum whose journaled decision this
 * plan's members can no longer reproduce. `plan_changed` refuses a durable
 * resume whose rebuilt graph differs from its first recorded plan. Moved
 * declaration sites are not a difference: only the plan's digest is compared.
 * `payload_changed` refuses a durable resume whose recorded payload no longer
 * decodes with the resuming build's payload schema, such as one a deploy
 * added a required field to.
 *
 * A run refused this way settles failed with the error as its defect, and
 * keeps it: `Flow.Result` stores the error's fields and decodes them back
 * into this class, so a caller of `poll` or `result` in any process reads the
 * same `code`. `Interpreter.refusalCode` reads it from a failure's cause.
 *
 * @category errors
 * @since 0.1.0
 */
export class InterpreterError extends Schema.TaggedError<InterpreterError>()(
  "@smthrs/flow/InterpreterError",
  {
    code: Schema.Literals([
      "incomplete_graph",
      "duplicate_node_id",
      "unresolved_action",
      "implementation_version_mismatch",
      "missing_implementation_version",
      "unresolved_reference",
      "unsupported_call",
      "missing_operation",
      "node_record_too_large",
      "plan_changed",
      "payload_changed",
      "join_mismatch"
    ]),
    flow: Schema.String,
    node: Schema.String,
    message: Schema.String
  }
) {}
