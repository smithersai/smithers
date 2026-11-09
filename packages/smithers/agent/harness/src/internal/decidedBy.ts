/**
 * Who answered a reading, as `decision-settled` names it.
 *
 * `Evaluator.Response.decidedBy` says `seat` when a generation seat answered
 * through the model-to-judge adapter, and is absent when the decision-only
 * model did. A reading keeps that member as it is, and a row spells the
 * absence out as `jev`.
 *
 * @since 1.0.0-rc.1
 * @private
 */

/**
 * The `decidedBy` of a `decision-settled` row.
 *
 * @since 1.0.0-rc.1
 * @private
 * @throws {never}
 */
export const decider = (asked: { readonly decidedBy?: "seat" | undefined }): "jev" | "seat" => asked.decidedBy ?? "jev"

/**
 * The `decidedBy` member a reading keeps of what it asked: present only when a
 * seat answered, so a reading Jev took is the record it always was.
 *
 * @since 1.0.0-rc.1
 * @private
 * @throws {never}
 */
export const answeredBy = (
  asked: { readonly decidedBy?: "seat" | undefined }
): { readonly decidedBy?: "seat" } => asked.decidedBy === undefined ? {} : { decidedBy: asked.decidedBy }
