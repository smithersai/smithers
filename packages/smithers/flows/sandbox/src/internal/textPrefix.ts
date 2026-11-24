/**
 * Unicode-safe text bounds for diagnostics and command output.
 *
 * @since 1.0.0-rc.18
 */

/**
 * A prefix bounded in UTF-16 units, keeping complete code points.
 *
 * @since 1.0.0-rc.18
 * @category utilities
 */
export const textPrefix = (value: string, end: number): string =>
  value.slice(0, (value.codePointAt(end - 1) ?? 0) > 0xffff ? end - 1 : end)
