/**
 * Field paths as a refusal names them: `contributes.views[0].scope`.
 *
 * @private
 * @since 1.1.0
 */

const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/

/**
 * Appends an index or a bounded identifier. Other keys are replaced with
 * their entry index, so refusal paths never echo arbitrary key text.
 *
 * @private
 * @since 1.1.0
 */
export const append = (path: string, segment: PropertyKey, index = 0): string => {
  if (typeof segment === "number") return `${path}[${segment}]`
  return typeof segment === "string" && identifier.test(segment)
    ? path === "" ? segment : `${path}.${segment}`
    : `${path}[key:${index}]`
}

/**
 * Prefixes an already admitted relative path, preserving bracket segments.
 *
 * @private
 * @since 1.1.0
 */
export const prefix = (path: string, relative: string): string =>
  path === "" ? relative : `${path}${relative.startsWith("[") ? "" : "."}${relative}`

/**
 * Joins segments from the root. Unknown keys use the segment index.
 *
 * @private
 * @since 1.1.0
 */
export const join = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>((path, segment, index) => append(path, segment, index), "")
