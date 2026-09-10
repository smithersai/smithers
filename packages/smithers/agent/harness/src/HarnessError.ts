/**
 * Stable failures reported at the harness translation boundary.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable harness failure codes.
 *
 * The set is closed to codes this package and `@smthrs/agent` actually raise;
 * `test/Contracts.test.ts` pins every member to a construction site under
 * `src`. Interrupting a run does not raise one: `CellTurn` emits
 * `AgentEvent.Aborted` and forwards the interrupt cause unchanged, and a
 * failed projection is `Transcript.TranscriptError`. A foreign CLI adapter declares its own error family beside the adapter in
 * `@smthrs/agent` rather than borrowing this one.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const HarnessErrorCode = Schema.Literals([
  "assembly_failed",
  "incompatible_journal",
  "render_failed",
  "model_failed",
  "engine_failed",
  "read_only_cap",
  "suspended"
])

/**
 * Stable harness failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type HarnessErrorCode = typeof HarnessErrorCode.Type

/**
 * A failure while translating a recorded agent turn.
 *
 * `cause` is {@link Schema.Defect} rather than {@link Schema.Unknown}: a
 * `HarnessError` is a member of `@smthrs/agent/AgentAction`'s `AgentFailure`
 * union, which is encoded through the durable exit schema for journaling. A
 * raw `Error` (or any other non-JSON value) attached as `cause` has no safe
 * JSON representation under `Schema.Unknown`, so encoding it dies with a
 * `SchemaError` that replaces the real failure instead of reporting it.
 * `Schema.Defect` decodes to the same `unknown` type but encodes any value —
 * including a real `Error` — to JSON, with the same graceful degradation
 * `Cause` defects already rely on elsewhere in this codebase.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: HarnessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
