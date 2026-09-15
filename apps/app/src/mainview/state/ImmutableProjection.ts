const immutable = new WeakSet<object>()

/** Only values recursively frozen here may reuse identity-based integrity work. */
export const isImmutableProjectionValue = (value: unknown): value is object =>
  value !== null && typeof value === "object" && immutable.has(value)

/** Freeze detached projector values; a shallow Object.freeze is insufficient. */
export const freezeProjectionValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || immutable.has(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error("A projection cannot contain an accessor.")
    freezeProjectionValue(descriptor.value)
  }
  Object.freeze(value)
  immutable.add(value)
  return value
}
