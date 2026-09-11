/**
 * The workspace boundary a file write is classified against.
 *
 * @since 0.1.0
 */

/**
 * Options used to classify workspace-relative file writes.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface TierOptions {
  /**
   * The lexical workspace boundary used to classify file writes.
   *
   * A root that normalizes to `.` or the empty string has no lexical boundary
   * and fails closed to `irreversible`. Pass an absolute workspace root. Using
   * `.` makes every write irreversible.
   *
   * @since 0.1.0
   * @category models
   */
  readonly workspaceRoot: string
}
