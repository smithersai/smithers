/**
 * Derives one root's per-cause facts from an explained `affected` selection:
 * every (file, cause) of every source that reaches the root, read as
 * `changes[i]` for each `i` in `changeSets[s]` for each `s` in the source's
 * `changes`, with the source's
 * label and rule and one shortest dependency route from the root down to the
 * source, read through `edges`. Conservative selections give each global cause.
 *
 * This is the derivation a consumer of `--list` performs; the suites assert
 * through it that the factored shape loses no fact.
 */
import type * as Affected from "../../src/Affected.ts"

/** One shortest route from `from` to `to` through `edges`, or undefined. */
export const route = (
  edges: Affected.ExplainedSelection["edges"],
  from: string,
  to: string
): ReadonlyArray<string> | undefined => {
  const previous = new Map<string, string | undefined>([[from, undefined]])
  for (const label of previous.keys()) {
    if (label === to) {
      const path: Array<string> = []
      for (let at: string | undefined = label; at !== undefined; at = previous.get(at)) path.unshift(at)
      return path
    }
    for (const dependent of edges[label] ?? []) if (!previous.has(dependent)) previous.set(dependent, label)
  }
  return undefined
}

export interface Cause {
  readonly file: string
  readonly kind: Affected.Change["kind"] | Affected.GlobalCause["kind"]
  readonly input?: Affected.Change["input"]
  readonly readPath?: string
  readonly label?: string
  readonly rule?: string
  readonly dependencyPath?: ReadonlyArray<string>
}

/** Every cause that selected `label`, ordered by file, then source, then cause. */
export const causes = (selection: Affected.ExplainedSelection, label: string): ReadonlyArray<Cause> => {
  const row = selection.targets.find((target) => target.label === label)
  if (row === undefined) return []
  if (selection.conservative) return selection.globalCauses
  const found = row.sources!.flatMap((index) => {
    const source = selection.sources[index]!
    const dependencyPath = [...route(selection.edges, source.label, label)!].reverse()
    const indexes = [...new Set(source.changes.flatMap((set) => selection.changeSets[set]!))].sort((l, r) => l - r)
    return indexes.map((change) => ({
      ...selection.changes[change]!,
      label: source.label,
      rule: source.rule,
      dependencyPath
    }))
  })
  return found.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
}

/** The changed files that reach `label`: the union of its sources' change files. */
export const reasons = (selection: Affected.ExplainedSelection, label: string): ReadonlyArray<string> =>
  [...new Set(causes(selection, label).map((cause) => cause.file))].sort()
