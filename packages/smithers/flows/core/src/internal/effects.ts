/**
 * Path indexing shared by effect matching and the graph's write-conflict pass.
 *
 * The pattern grammar is exhaustive: an entry ending in `*` matches by string
 * prefix and every other entry matches itself alone. Every path is read a
 * bounded number of times: once to look for a dot segment, once to detect a
 * pattern, and once per comparison a binary search needs while the distinct
 * paths are sorted and each pattern's prefix is located. After that a path is
 * an integer rank and every match is an integer comparison, so matching two
 * declarations costs their combined length plus the matches, whatever the
 * paths' lengths or how many patterns nest. An envelope is prepared once for
 * every step it encloses: its exact entries go into a set and its covering
 * patterns collapse to disjoint sorted prefixes, so a step path costs one
 * lookup and one binary search however wide the envelope is.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 1.0.0-rc.0
 */

import type * as Effects from "../Effects.ts"
import type { GraphBuildError } from "./diagnostic.ts"

const SLASH = 47
const DOT = 46
const STAR = 42

/**
 * Whether `path` contains a whole `.` or `..` segment.
 *
 * A path with no `.` costs one native search. Otherwise the segments from the
 * one holding the first `.` onward are scanned once, without allocating.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const hasDotSegment = (path: string): boolean => {
  const first = path.indexOf(".")
  if (first === -1) return false
  const length = path.length
  let start = path.lastIndexOf("/", first) + 1
  for (let index = start; index <= length; index++) {
    if (index === length || path.charCodeAt(index) === SLASH) {
      const size = index - start
      if (size === 1 && path.charCodeAt(start) === DOT) return true
      if (size === 2 && path.charCodeAt(start) === DOT && path.charCodeAt(start + 1) === DOT) return true
      start = index + 1
    }
  }
  return false
}

/**
 * Whether an entry is a pattern: only a trailing `*` makes one.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isGlob = (entry: string): boolean => entry.charCodeAt(entry.length - 1) === STAR

/**
 * The string prefix a pattern matches by: everything for `*` and `**`,
 * `prefix/` for `prefix/**`, and `prefix` for `prefix*`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const globPrefix = (glob: string): string =>
  glob === "*" || glob === "**" ? "" : glob.endsWith("/**") ? glob.slice(0, -2) : glob.slice(0, -1)

/**
 * Whether a pattern's prefix already holds a whole `.` or `..` segment. Every
 * path under such a prefix carries that segment, so the pattern covers nothing
 * and matches only an identical entry.
 */
const inertPrefix = (prefix: string): boolean => hasDotSegment(prefix.slice(0, prefix.lastIndexOf("/") + 1))

/**
 * The smallest string greater than every string that starts with `prefix`,
 * or `undefined` when no such string exists. Strings starting with `prefix`
 * are exactly those in `[prefix, successor(prefix))` in code-unit order, so a
 * sorted list answers "which entries start with `prefix`" with two binary
 * searches whose comparisons are native.
 */
const successor = (prefix: string): string | undefined => {
  let end = prefix.length
  while (end > 0 && prefix.charCodeAt(end - 1) === 0xffff) end--
  if (end === 0) return undefined
  return prefix.slice(0, end - 1) + String.fromCharCode(prefix.charCodeAt(end - 1) + 1)
}

/** The first position in a sorted list whose entry is not less than `value`. */
const lowerBound = (sorted: ReadonlyArray<string>, value: string): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** The first position in a sorted rank list whose rank is not less than `value`. */
const lowerBoundRank = (sorted: Int32Array, value: number): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * The distinct paths of one or more declarations in code-unit order, with
 * what matching needs to know about each: its rank, whether it carries a dot
 * segment, whether it is a pattern that can cover anything, and for such a
 * pattern the rank interval its prefix covers.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface PathIndex {
  readonly paths: ReadonlyArray<string>
  readonly rank: ReadonlyMap<string, number>
  readonly dotted: Uint8Array
  readonly glob: Uint8Array
  readonly low: Int32Array
  readonly high: Int32Array
}

/**
 * Indexes the union of the given path lists.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const indexPaths = (lists: Iterable<ReadonlyArray<string>>): PathIndex => {
  const distinct = new Set<string>()
  for (const list of lists) {
    for (const path of list) distinct.add(path)
  }
  const paths = [...distinct].sort()
  const rank = new Map<string, number>()
  const count = paths.length
  const dotted = new Uint8Array(count)
  const glob = new Uint8Array(count)
  const low = new Int32Array(count).fill(-1)
  const high = new Int32Array(count).fill(-1)
  for (let index = 0; index < count; index++) {
    const path = paths[index]!
    rank.set(path, index)
    if (hasDotSegment(path)) dotted[index] = 1
    if (!isGlob(path)) continue
    const prefix = globPrefix(path)
    if (inertPrefix(prefix)) continue
    glob[index] = 1
    low[index] = lowerBound(paths, prefix)
    const next = successor(prefix)
    high[index] = next === undefined ? count : lowerBound(paths, next)
  }
  return { paths, rank, dotted, glob, low, high }
}

/**
 * One declaration's paths as ranks of a {@link PathIndex}: every path in
 * ascending rank order, and the patterns whose prefix intervals are not
 * contained in another of the declaration's patterns. Those intervals are
 * disjoint and ascending, so enumerating them visits each covered rank once.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Ranked {
  readonly ranks: Int32Array
  readonly globs: Int32Array
}

/**
 * Ranks a declaration's paths against an index that contains them.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const rankPaths = (index: PathIndex, paths: ReadonlyArray<string>): Ranked => {
  const ranks = Int32Array.from(paths, (path) => index.rank.get(path)!).sort()
  let distinct = 0
  for (let position = 0; position < ranks.length; position++) {
    if (position === 0 || ranks[position] !== ranks[position - 1]) ranks[distinct++] = ranks[position]!
  }
  const unique = ranks.subarray(0, distinct)
  const candidates: Array<number> = []
  for (const rank of unique) {
    if (index.glob[rank] === 1 && index.low[rank]! < index.high[rank]!) candidates.push(rank)
  }
  candidates.sort((left, right) => index.low[left]! - index.low[right]! || index.high[right]! - index.high[left]!)
  const globs: Array<number> = []
  let coveredTo = -1
  for (const rank of candidates) {
    if (index.high[rank]! <= coveredTo) continue
    globs.push(rank)
    coveredTo = index.high[rank]!
  }
  return { ranks: unique, globs: Int32Array.from(globs) }
}

/** The ranks two ascending rank lists share, ascending. */
const shared = (a: Int32Array, b: Int32Array): Array<number> => {
  const matches: Array<number> = []
  let left = 0
  let right = 0
  while (left < a.length && right < b.length) {
    const x = a[left]!
    const y = b[right]!
    if (x === y) {
      matches.push(x)
      left++
      right++
    } else if (x < y) {
      left++
    } else {
      right++
    }
  }
  return matches
}

/** Merges ascending, duplicate-free rank lists into one, dropping repeats. */
const union = (lists: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const merged: Array<number> = []
  const cursors = lists.map(() => 0)
  while (true) {
    let smallest = -1
    for (let list = 0; list < lists.length; list++) {
      const cursor = cursors[list]!
      if (cursor < lists[list]!.length && (smallest === -1 || lists[list]![cursor]! < smallest)) {
        smallest = lists[list]![cursor]!
      }
    }
    if (smallest === -1) return merged
    merged.push(smallest)
    for (let list = 0; list < lists.length; list++) {
      const cursor = cursors[list]!
      if (cursor < lists[list]!.length && lists[list]![cursor] === smallest) cursors[list] = cursor + 1
    }
  }
}

/**
 * The ranks of the paths two write declarations share, ascending: a path of
 * `b` that `a` names or covers, and a path of `a` that `b` covers unless it is
 * the same pattern or itself covers that pattern. This is the pairwise
 * definition, exact paths matched through the merge of two sorted rank lists
 * and each covering pattern enumerating the ranks of the other declaration
 * inside its interval. Each of the three passes yields an ascending list, so
 * the result is their merge and no sort is needed.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const overlapRanks = (index: PathIndex, a: Ranked, b: Ranked): Array<number> => {
  const covered: Array<number> = []
  for (const glob of a.globs) {
    const high = index.high[glob]!
    for (let position = lowerBoundRank(b.ranks, index.low[glob]!); position < b.ranks.length; position++) {
      const rank = b.ranks[position]!
      if (rank >= high) break
      if (index.dotted[rank] === 0) covered.push(rank)
    }
  }
  const covering: Array<number> = []
  for (const glob of b.globs) {
    const high = index.high[glob]!
    const globDotted = index.dotted[glob] === 1
    for (let position = lowerBoundRank(a.ranks, index.low[glob]!); position < a.ranks.length; position++) {
      const rank = a.ranks[position]!
      if (rank >= high) break
      if (rank === glob || index.dotted[rank] === 1) continue
      if (index.glob[rank] === 1 && !globDotted && index.low[rank]! <= glob && glob < index.high[rank]!) continue
      covering.push(rank)
    }
  }
  const exact = shared(a.ranks, b.ranks)
  if (covered.length === 0 && covering.length === 0) return exact
  return union([exact, covered, covering])
}

/** The first position in a sorted list whose entry is greater than `value`. */
const upperBound = (sorted: ReadonlyArray<string>, value: string): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! <= value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * One envelope list prepared for repeated coverage checks: its distinct
 * entries, matched exactly through a set, and the prefixes of its covering
 * patterns with every pattern nested under another collapsed into the
 * outermost. The kept prefixes are disjoint and sorted, so the only prefix
 * that can cover a path is the greatest one not greater than the path, and
 * one binary search finds it.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Prepared {
  readonly exact: ReadonlySet<string>
  readonly prefixes: ReadonlyArray<string>
}

/**
 * Prepares one envelope list. Each entry is read a bounded number of times:
 * once into the set, once to detect a pattern, and for a pattern once to take
 * its prefix and once to test that prefix for a dot segment, plus the
 * comparisons that sort the prefixes and one prefix comparison that collapses
 * a nested one.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const prepare = (paths: ReadonlyArray<string>): Prepared => {
  const exact = new Set(paths)
  const candidates: Array<string> = []
  for (const entry of exact) {
    if (!isGlob(entry)) continue
    const prefix = globPrefix(entry)
    if (!inertPrefix(prefix)) candidates.push(prefix)
  }
  candidates.sort()
  const prefixes: Array<string> = []
  for (const prefix of candidates) {
    // Strings that start with a prefix are contiguous in code-unit order, so
    // every prefix nested under the last kept one follows it directly.
    if (prefixes.length > 0 && prefix.startsWith(prefixes[prefixes.length - 1]!)) continue
    prefixes.push(prefix)
  }
  return { exact, prefixes }
}

/**
 * Whether a prepared list names or covers `path`. A path carrying a dot
 * segment is never covered, so the path is scanned once for one and, when
 * clean, looked up once and compared against at most one prefix.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const covered = (prepared: Prepared, path: string): boolean => {
  if (hasDotSegment(path)) return false
  if (prepared.exact.has(path)) return true
  const position = upperBound(prepared.prefixes, path) - 1
  return position >= 0 && path.startsWith(prepared.prefixes[position]!)
}

/**
 * The fields of a declaration that narrowing reads. Structural, so this module
 * needs nothing from the public module built on it.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface DeclarationLike {
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: "hermetic" | "expected"
  readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
}

/**
 * An envelope prepared once for every step it encloses.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface PreparedEnvelope {
  readonly reads: Prepared
  readonly writes: Prepared
  readonly mode: "hermetic" | "expected"
  readonly tier: "sealed" | "compensable" | "irreversible"
}

/**
 * The outcome of narrowing a step against a prepared envelope, shaped as the
 * public `NarrowResult`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type NarrowOutcome =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: "effect_outside_envelope" | "effect_mode_widening" | "effect_tier_widening"
    readonly paths: ReadonlyArray<string>
  }

/**
 * Prepares both lists of an envelope.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const prepareEnvelope = (envelope: DeclarationLike): PreparedEnvelope => ({
  reads: prepare(envelope.reads),
  writes: prepare(envelope.writes),
  mode: envelope.mode,
  tier: envelope.tier ?? "sealed"
})

const tierRank = { sealed: 0, compensable: 1, irreversible: 2 } as const

const outside = (prepared: Prepared, paths: ReadonlyArray<string>): Array<string> =>
  paths.filter((path) => !covered(prepared, path))

/**
 * Verifies that a step stays within a prepared envelope: every read and write
 * path must be covered by the matching list, the mode may only tighten, and
 * the tier may only narrow. Each step path costs one coverage check.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const narrowPrepared = (envelope: PreparedEnvelope, step: DeclarationLike): NarrowOutcome => {
  const paths = [...new Set([...outside(envelope.reads, step.reads), ...outside(envelope.writes, step.writes)])].sort()
  if (paths.length > 0) {
    return { ok: false, code: "effect_outside_envelope", paths }
  }
  if (envelope.mode === "hermetic" && step.mode === "expected") {
    return { ok: false, code: "effect_mode_widening", paths: [] }
  }
  if (tierRank[step.tier ?? "sealed"] > tierRank[envelope.tier]) {
    return { ok: false, code: "effect_tier_widening", paths: [] }
  }
  return { ok: true }
}

/**
 * Maximum length, in UTF-16 code units, of one effect path `Graph.build`
 * admits before it refuses the plan with `plan_too_large`. 4096 is `PATH_MAX`
 * on Linux, the longest path a supported host can open, so no path that names
 * a file is refused. Every per-character cost of a build is bounded by it:
 * the one dot-segment scan each path gets, the comparisons that sort the
 * distinct paths, and the comparisons that locate each pattern's prefix. The
 * length is read before any character is, so an over-long path costs one
 * property read.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPathLength = 4096

/**
 * Maximum number of patterns, entries ending in `*`, one read list or one
 * write list of an effect declaration may carry before `Graph.build` refuses
 * the plan with `plan_too_large`. A pattern never costs a match more than a
 * literal path does: its prefix is located once by binary search, patterns
 * nested under another collapse into the outermost before the paths they
 * cover are enumerated, and every match after that is an integer comparison.
 * What a pattern costs beyond a literal is that search, two binary searches
 * of at most 16 comparisons each over a plan at `Graph.maximumPlanEffectPaths`,
 * every comparison reading up to {@link maximumPathLength} code units.
 * 128 keeps that term, 4,096 comparisons per list, below the sort that admits
 * a list of `Graph.maximumEffectPaths` literal paths, while still letting one
 * declaration name a subtree per package of a large monorepo. The count is
 * read from the last character of each path as it is admitted, so a pattern
 * past the limit costs one character read.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGlobs = 128

/**
 * Copies one declaration's paths, refusing before the copy grows past
 * `limit`. A real array is refused by its length before a member is read; any
 * other iterable is copied one path at a time and refused as soon as it
 * exceeds the limit, so a caller-assembled declaration cannot dodge the bound
 * by hiding its size from `length`. Each path is then refused by its length
 * before any character is read, and by the count of patterns the list has
 * carried so far, so an over-long path or a pattern past the limit costs one
 * property read.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const copyPaths = (
  paths: ReadonlyArray<string>,
  limit: number,
  refuse: () => GraphBuildError
): Array<string> => {
  const copy: Array<string> = []
  let globs = 0
  const admit = (path: string): void => {
    if (path.length > maximumPathLength) throw refuse()
    if (isGlob(path) && ++globs > maximumGlobs) throw refuse()
    copy.push(path)
  }
  if (Array.isArray(paths)) {
    const length = paths.length
    if (length > limit) throw refuse()
    for (let index = 0; index < length; index++) admit(paths[index])
    return copy
  }
  for (const path of paths) {
    if (copy.length >= limit) throw refuse()
    admit(path)
  }
  return copy
}

/**
 * Snapshots a declaration into graph-owned data, copying at most `limit`
 * paths in total across its reads and writes.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const boundedEffects = (
  declaration: Effects.Declaration,
  limit: number,
  refuse: () => GraphBuildError
): Effects.Declaration => {
  const reads = copyPaths(declaration.reads, limit, refuse)
  const writes = copyPaths(declaration.writes, limit - reads.length, refuse)
  return {
    reads,
    writes,
    mode: declaration.mode,
    onConflict: declaration.onConflict,
    ...(declaration.tier === undefined ? {} : { tier: declaration.tier })
  }
}
