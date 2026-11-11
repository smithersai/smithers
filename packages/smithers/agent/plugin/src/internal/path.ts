/**
 * Field paths as a refusal names them: `contributes.views[0].scope`.
 *
 * @private
 * @since 1.1.0
 */

const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]*$/

// A refused key can be any length, so a segment keeps its first 64 characters, as the kernel's paths do.
const bounded = (key: string): string => key.length > 64 ? `${key.slice(0, 64)}...` : key

/**
 * Appends one segment to a path: a number as `[n]`, an identifier as `.name`
 * (bare at the root), anything else as a quoted key. A key past 64
 * characters keeps its first 64 and `...`.
 *
 * @private
 * @since 1.1.0
 */
export const append = (path: string, segment: PropertyKey): string => {
  if (typeof segment === "number") return `${path}[${segment}]`
  const key = bounded(String(segment))
  return identifier.test(key) ? path === "" ? key : `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

/**
 * Joins segments from the root.
 *
 * @private
 * @since 1.1.0
 */
export const join = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>((path, segment) => append(path, segment), "")
