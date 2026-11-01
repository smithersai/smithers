/**
 * The answer text of a reply that is still streaming.
 *
 * A cell reply has no prose path: the answer is the `output` a cell passes to
 * `ctx.done`, and a reply without a cell is rejected. So a host that shows the
 * answer while the model writes it reads that argument out of the partial
 * reply. {@link project} does: it returns the decoded prefix of the string or
 * template literal passed to the last `ctx.done(` in the reply's cell blocks.
 *
 * The projection is display, never a record. The sealed events stay
 * authoritative: a host replaces the live text with the completed output when
 * the run settles, and a replay folds the recorded deltas through the same
 * function.
 *
 * Governing design: decision 0003 of `apps/mvp`, "Streaming".
 *
 * @since 1.0.0-rc.16
 */
import { Option } from "effect";
/**
 * The decoded prefix of the string or template literal passed to the last
 * `ctx.done(` in a reply's cell blocks, or `Option.none()`.
 *
 * `reply` is the model's text so far: prose and fenced `cell` blocks, the
 * last of which may still be open. Only cell blocks are read, joined as
 * `Cell.extract` joins them, and a `ctx.done(` inside a string, a comment, a
 * regular expression or template text is not the call.
 *
 * - Before the literal's opening quote arrives, and for an argument that is
 *   not a literal, the result is `none`.
 * - Escapes decode as a strict-mode string or untagged template decodes them,
 *   and a template's raw CR LF reads as LF.
 * - Text stops at a template's `${`, at an escape strict code refuses, and at
 *   an escape the input cut short.
 * - A cut-off prefix drops a high surrogate whose pair has not arrived.
 *
 * So every result is a prefix of the literal's value, and a closed literal
 * projects to its whole value.
 *
 * @example
 * ```ts
 * import { DoneText } from "@smthrs/harness"
 *
 * const fence = "`".repeat(3)
 * DoneText.project(`${fence}cell\nawait ctx.call("app/theme/set", { mode: "dark" })\nctx.done("Switched to dar`)
 * // Option.some("Switched to dar")
 * ```
 *
 * @category projections
 * @since 1.0.0-rc.16
 */
export declare const project: (reply: string) => Option.Option<string>;
