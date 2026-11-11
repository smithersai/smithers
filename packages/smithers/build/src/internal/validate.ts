/**
 * Construction-option validation shared by the two host seams.
 *
 * `Runtime` and `PackageManager` both take options from a composition root and
 * both turn them into a frozen snapshot before any service exists. The rules
 * are the same rules: own enumerable data properties only, no unknown keys,
 * bounded well-formed text, no NUL and no lone surrogate. They live here
 * rather than in whichever module happened to need them first.
 *
 * Nothing here is reachable from outside the package: the export map maps
 * `./internal/*` to `null`.
 *
 * @since 0.1.0
 */

/**
 * Runs an inspection that a hostile object could make throw.
 *
 * A proxy can throw from `getPrototypeOf`, `ownKeys`, or a property getter.
 * Every reflective read below goes through this so a thrown trap becomes one
 * refusal naming the option rather than an opaque proxy error.
 *
 * @private
 * @since 0.1.0
 */
export const inspect = <A>(what: string, operation: () => A): A => {
  try {
    return operation()
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
}

/**
 * Refuses anything but an ordinary object literal.
 *
 * @private
 * @since 0.1.0
 */
export const plainRecord = (value: unknown, what: string): Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} must be a plain object`)
  }
  const prototype = inspect(what, () => Object.getPrototypeOf(value))
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${what} must be a plain object`)
  }
  return value as Record<PropertyKey, unknown>
}

/**
 * Reads one own enumerable data property, refusing accessors.
 *
 * @private
 * @since 0.1.0
 */
export const ownData = (
  value: Record<PropertyKey, unknown>,
  name: string,
  what: string
): unknown => {
  const descriptor = inspect(what, () => Object.getOwnPropertyDescriptor(value, name))
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${what}.${name} must be an enumerable data property`)
  }
  return descriptor.value
}

/**
 * Refuses a property the caller did not mean to pass.
 *
 * An unknown key is a typo or a moved field, and silently ignoring it is how a
 * `platform` option keeps being passed years after it moved to another service.
 *
 * @private
 * @since 0.1.0
 */
export const exactKeys = (
  value: Record<PropertyKey, unknown>,
  allowed: ReadonlySet<string>,
  what: string
): void => {
  const keys = inspect(what, () => Reflect.ownKeys(value))
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(
        `${what} contains unknown property ${typeof key === "string" ? JSON.stringify(key) : "symbol"}`
      )
    }
  }
}

/**
 * Reports whether UTF-8 encoding can preserve a string without replacement.
 *
 * @private
 * @since 0.1.0
 */
export const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/**
 * Counts the UTF-8 bytes of `value` without allocating an encoding.
 *
 * Matches `TextEncoder`: a lone surrogate counts as the three bytes of U+FFFD.
 * Uses no host global, so the seams that call it stay browser-bundleable.
 *
 * @private
 * @since 0.1.0
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/**
 * Refuses anything but non-empty, NUL-free, well-formed, bounded text.
 *
 * @private
 * @since 0.1.0
 */
export const usableText = (value: unknown, maximumBytes: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\0") &&
  isWellFormedText(value) &&
  utf8ByteLength(value) <= maximumBytes

/**
 * Maximum number of entries admitted from a host environment.
 *
 * @private
 * @since 0.1.0
 */
export const maximumEnvironmentEntries = 4_096

/**
 * Maximum total bytes admitted from a host environment.
 *
 * @private
 * @since 0.1.0
 */
export const maximumEnvironmentBytes = 256 * 1024

/** The POSIX convention for an environment name: what `export NAME=` accepts. */
const portableEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The Windows environment block's own rule: `NAME=VALUE` entries separated by
 * NUL, so a name is non-empty and carries neither `=` nor a control character.
 *
 * Windows sets names the POSIX convention never produces. `ProgramFiles(x86)`
 * and `CommonProgramFiles(x86)` are on every 64-bit image, the GitHub Actions
 * `windows-latest` runner included, so holding a Windows host to the POSIX rule
 * refuses the whole environment before any command runs.
 */
const windowsEnvironmentName = /^[^=\u0000-\u001F\u007F]+$/

/**
 * Whether a name is one this host can carry into a child environment.
 *
 * The rule belongs to the host that named the variable, not to the repository.
 * A name the repository declares is a different question and keeps the portable
 * rule: the `.npmrc` placeholder syntax matches only a portable name, and every
 * bootstrap name is portable by construction. Those two lists are the whole of
 * what a child receives, so relaxing the source's rule never puts a
 * non-portable name on a command line or in a child environment.
 *
 * @private
 * @since 0.1.0
 */
export const usableEnvironmentName = (name: string, windows: boolean): boolean =>
  windows ? windowsEnvironmentName.test(name) : portableEnvironmentName.test(name)

/**
 * Snapshots a host environment into a bounded, case-normalized lookup table.
 *
 * The result is a lookup source, never a child environment: a caller selects
 * the names it means to forward out of it. Windows names are upper-cased
 * because the Windows environment block is case-insensitive, and two entries
 * differing only in case would otherwise both be admitted and one of them
 * silently win.
 *
 * @private
 * @since 0.1.0
 */
export const normalizeEnvironment = (
  value: unknown,
  windows: boolean,
  what: string
): ReadonlyMap<string, string> => {
  if (value === undefined) return new Map()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} must be an object of string values`)
  }
  const record = value as Record<PropertyKey, unknown>
  const keys = inspect(what, () => Reflect.ownKeys(record))
  if (keys.length > maximumEnvironmentEntries) {
    throw new TypeError(`${what} has more than ${maximumEnvironmentEntries} entries`)
  }
  const output = new Map<string, string>()
  let bytes = 0
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(`${what} must not contain symbol properties`)
    }
    const name = key
    if (!usableEnvironmentName(name, windows)) {
      throw new TypeError(`${what} name is not portable: ${JSON.stringify(name)}`)
    }
    const descriptor = inspect(what, () => Object.getOwnPropertyDescriptor(record, name))
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${what} ${name} must be an enumerable data property`)
    }
    const member = descriptor.value
    if (member === undefined) continue
    if (typeof member !== "string") {
      throw new TypeError(`${what} ${name} must be a string or undefined`)
    }
    if (member.includes("\0") || !isWellFormedText(member)) {
      throw new TypeError(`${what} ${name} is not usable text`)
    }
    bytes += utf8ByteLength(name) + utf8ByteLength(member)
    if (!Number.isSafeInteger(bytes) || bytes > maximumEnvironmentBytes) {
      throw new TypeError(`${what} exceeds ${maximumEnvironmentBytes} bytes`)
    }
    const normalizedName = windows ? name.toUpperCase() : name
    if (output.has(normalizedName)) {
      throw new TypeError(`${what} repeats a case-insensitive name: ${JSON.stringify(name)}`)
    }
    output.set(normalizedName, member)
  }
  return output
}

/**
 * Reads one name out of a normalized environment snapshot.
 *
 * @private
 * @since 0.1.0
 */
export const sourceValue = (
  source: ReadonlyMap<string, string>,
  name: string,
  windows: boolean
): string | undefined => source.get(windows ? name.toUpperCase() : name)
