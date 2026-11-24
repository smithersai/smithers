/**
 * `smthrs update`: is the installed CLI the current one?
 *
 * The check is a plain registry read of `@smthrs/cli`'s dist-tags and nothing
 * else. rc.0 never installs anything on the operator's behalf: 0.x's
 * self-upgrade path had to know about npm, pnpm, bun, and global versus local
 * installs, and got it wrong often enough that the honest answer is to print
 * the command for the package manager the operator actually uses.
 *
 * Both dist-tags participate in SemVer order so a newer stable release is
 * offered even when the next tag still points at a release candidate.
 *
 * @since 1.0.0
 */

/**
 * The package this CLI ships as.
 *
 * @category constants
 * @since 1.0.0
 */
export const packageName = "@smthrs/cli"

/**
 * The registry endpoint the check reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const registryUrl = `https://registry.npmjs.org/-/package/${packageName}/dist-tags`

/**
 * What the check found.
 *
 * @category models
 * @since 1.0.0
 */
export interface Status {
  readonly current: string
  readonly available: string | undefined
  readonly tag: "next" | "latest" | undefined
  readonly upToDate: boolean
  readonly install: string | undefined
}

// Build metadata after `+` never affects precedence, and the prerelease starts
// at the first `-`: later hyphens belong to its identifiers.
const parse = (version: string) => {
  const [precedence = ""] = version.split("+", 1)
  const dash = precedence.indexOf("-")
  return dash === -1
    ? { core: precedence.split("."), prerelease: [] }
    : { core: precedence.slice(0, dash).split("."), prerelease: precedence.slice(dash + 1).split(".") }
}

const numeric = /^\d+$/

// Numeric identifiers compare numerically and rank below every non-numeric
// identifier, which compares lexically. BigInt keeps digits past 2^53 exact.
const compareIdentifiers = (a: string, b: string): number => {
  const aNumeric = numeric.test(a)
  const bNumeric = numeric.test(b)
  if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

// A longer list outranks a shorter one whose identifiers it shares: rc.1.1
// beats rc.1.
const compareLists = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const order = compareIdentifiers(a, b)
    if (order !== 0) return order
  }
  return 0
}

/**
 * Whether `candidate` is a later version than `current`, by SemVer 2.0.0
 * precedence.
 *
 * The core compares first. On an equal core a release outranks its own
 * prereleases, so `1.0.0` beats `1.0.0-rc.0`, and two prereleases compare
 * identifier by identifier, so `1.0.0-rc.10` beats `1.0.0-rc.9` and
 * `1.0.0-rc.1.1` beats `1.0.0-rc.1`. Build metadata is ignored.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isNewer = (candidate: string, current: string): boolean => {
  const left = parse(candidate)
  const right = parse(current)
  const core = compareLists(left.core, right.core)
  if (core !== 0) return core > 0
  if (left.prerelease.length === 0) return right.prerelease.length > 0
  if (right.prerelease.length === 0) return false
  return compareLists(left.prerelease, right.prerelease) > 0
}

// The SemVer 2.0.0 grammar, loosely: a dist-tag value outside it is never
// offered, because `install` is a command the operator copies into a shell.
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Turns a dist-tag document into a status.
 *
 * A tag whose value is not a SemVer version is ignored.
 *
 * @category constructors
 * @since 1.0.0
 */
export const compare = (current: string, tags: Readonly<Record<string, string>>): Status => {
  const candidates: ReadonlyArray<readonly ["next" | "latest", string | undefined]> = [
    ["next", tags["next"]],
    ["latest", tags["latest"]]
  ]
  let best: Status = { current, available: undefined, tag: undefined, upToDate: true, install: undefined }
  for (const [tag, version] of candidates) {
    if (typeof version === "string" && semver.test(version) && isNewer(version, best.available ?? current)) {
      best = {
        current,
        available: version,
        tag,
        upToDate: false,
        install: `npm install -g ${packageName}@${version}`
      }
    }
  }
  return best
}

/**
 * The human rendering of a status.
 *
 * @category conversions
 * @since 1.0.0
 */
export const render = (status: Status): string =>
  status.upToDate
    ? `${packageName} ${status.current} is current.`
    : `${packageName} ${status.available} is available (${status.tag}); you have ${status.current}.\n${status.install}`
