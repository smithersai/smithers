/**
 * The per-field bound on a permission-error rendering.
 *
 * @since 0.1.0
 */

/**
 * Maximum UTF-16 length of one field in a permission-error rendering.
 *
 * The limit includes the visible truncation marker. It bounds unattended log
 * output while preserving ordinary Unicode and visible control escapes.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxDisplayFieldLength = 256
