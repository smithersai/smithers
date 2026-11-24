/**
 * Inert reads of a failure's identifying fields.
 *
 * A defect or a typed failure is any thrown value: a Proxy whose traps throw,
 * or an object whose `message` or `_tag` is an accessor that throws or does
 * work. Diagnostics read such values only through {@link field}, which never
 * runs an accessor and never lets a trap's exception replace the failure the
 * diagnostic describes.
 *
 * @since 1.0.0
 */

/** How far up a prototype chain {@link field} looks. */
const maximumDepth = 64

/**
 * The value of `key` on `value` when it is a data property, own or inherited;
 * `undefined` for a primitive, a missing key, an accessor, a cyclic or
 * overlong prototype chain, or any Proxy trap that throws.
 *
 * @private
 * @since 1.0.0
 */
export const field = (value: unknown, key: string): unknown => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined
  try {
    let current: object | null = value
    for (let depth = 0; current !== null && depth < maximumDepth; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined
      current = Object.getPrototypeOf(current) as object | null
    }
  } catch {
    // An uninspectable failure has no readable field.
  }
  return undefined
}

/**
 * {@link field} when it is a string.
 *
 * @private
 * @since 1.0.0
 */
export const stringField = (value: unknown, key: string): string | undefined => {
  const found = field(value, key)
  return typeof found === "string" ? found : undefined
}
