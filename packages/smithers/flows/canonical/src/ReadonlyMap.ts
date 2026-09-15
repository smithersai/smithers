/**
 * Immutable facade over a private map.
 *
 * @since 1.0.0
 */

/**
 * Copies entries behind a facade that exposes no mutation methods.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = <K, V>(entries: Iterable<readonly [K, V]> = []): ReadonlyMap<K, V> => {
  const values = new Map(entries)
  const facade: ReadonlyMap<K, V> = {
    get size() {
      return values.size
    },
    get: (key) => values.get(key),
    has: (key) => values.has(key),
    forEach: (callback, thisArg) => values.forEach((value, key) => callback.call(thisArg, value, key, facade)),
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    [Symbol.iterator]: () => values[Symbol.iterator]()
  }
  return Object.freeze(facade)
}
