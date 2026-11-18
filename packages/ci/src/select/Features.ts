/**
 * Fast mode's features and labels, as pure functions.
 *
 * The six features are the best set of Machalica, Samylkin, Porth and
 * Chandra, "Predictive Test Selection" (arXiv:1810.05286), section IV-A.
 * Each function reads plain data, so the same code builds rows from a git
 * repository, from a merge queue's logs, or from a fixture.
 *
 * @since 0.1.0
 */

import type { Plan } from "../contract/Plan.ts"
import { type RunRecord, verdictOf } from "../contract/RunRecord.ts"
import type { Features, Row } from "../contract/Selection.ts"

/**
 * One day, in milliseconds.
 *
 * @category constants
 * @since 0.1.0
 */
export const day = 86_400_000

/**
 * How far back the features read, in days: the longest window.
 *
 * @category constants
 * @since 0.1.0
 */
export const horizonDays = 56

/**
 * The graph distance of a target no changed file reaches.
 *
 * @category constants
 * @since 0.1.0
 */
export const unreachable = -1

/**
 * One past commit: when it was made and the files it changed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Commit {
  readonly at: number
  readonly files: ReadonlyArray<string>
}

/**
 * A row and the time of its change, in milliseconds since the epoch. The
 * ledger keeps these, and the eval splits them by time.
 *
 * @category models
 * @since 0.1.0
 */
export interface Observation {
  readonly at: number
  readonly row: Row
}

/**
 * The project a target belongs to: the directory part of its label. The
 * root package is `.`.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const projectOf = (label: string): string => {
  const path = label.replace(/^\/\//, "").replace(/:[^:]*$/, "")
  return path === "" ? "." : path
}

/** True when `file` is inside `project`. */
const inside = (project: string, file: string): boolean => project === "." || file.startsWith(`${project}/`)

/**
 * What every changed file with no extension counts as.
 *
 * @category constants
 * @since 0.1.0
 */
export const noExtension = "(none)"

/**
 * The extensions of the changed files, lowercased, distinct and sorted.
 * Every file with no extension, such as `Justfile` or `.gitignore`, counts
 * once, as {@link noExtension}.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const extensionsOf = (files: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("/") + 1)
    const dot = name.lastIndexOf(".")
    found.add(dot > 0 ? name.slice(dot).toLowerCase() : noExtension)
  }
  return [...found].sort()
}

/**
 * How many of `history`'s commits changed one of `files` in the 3, 14 and 56
 * days before `at`.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const fileChanges = (
  files: ReadonlyArray<string>,
  at: number,
  history: ReadonlyArray<Commit>
): Features["fileChanges"] => {
  const changed = new Set(files)
  const ages = history
    .filter((commit) => commit.at < at && commit.files.some((file) => changed.has(file)))
    .map((commit) => at - commit.at)
  const within = (days: number): number => ages.filter((age) => age <= days * day).length
  return { d3: within(3), d14: within(14), d56: within(56) }
}

/**
 * The share of a target's earlier runs that failed in the 7, 14, 28 and 56
 * days before `at`. `runs` holds that one target's rows. A flaky run is a run
 * that did not fail. A window with no run is 0.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const failureRates = (at: number, runs: ReadonlyArray<Observation>): Features["failureRates"] => {
  const earlier = runs.filter((observation) => observation.at < at)
  const rate = (days: number): number => {
    const window = earlier.filter((observation) => at - observation.at <= days * day)
    return window.length === 0 ? 0 : window.filter((observation) => observation.row.failed).length / window.length
  }
  return { d7: rate(7), d14: rate(14), d28: rate(28), d56: rate(56) }
}

/**
 * How many of `files` are tests inside `project`: a file in a `test`,
 * `tests`, `spec` or `__tests__` directory, or with one of those words in
 * its name.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const testCount = (files: ReadonlyArray<string>, project: string): number =>
  files.filter((file) => inside(project, file) && /(^|[/._-])(tests?|spec|__tests__)([/._-]|$)/i.test(file)).length

/**
 * The shortest dependency-graph distance from a changed file to each target.
 *
 * A changed file belongs to the deepest project that holds it, and every
 * target of that project is at distance 0. A target that depends on a target
 * at distance `n` is at most at `n + 1`. A target no changed file reaches is
 * {@link unreachable}. With no plan there are no dependencies, so only a
 * changed file's own project is reached.
 *
 * @category features
 * @since 0.1.0
 * @throws {never}
 */
export const graphDistances = (
  files: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
  plan: Plan | undefined
): ReadonlyMap<string, number> => {
  const labels = [...new Set([...targets, ...(plan?.targets ?? []).map((target) => target.label)])]
  const projects = [...new Set(labels.map(projectOf))].sort((a, b) => b.length - a.length)
  const owners = new Set(files.flatMap((file) => projects.find((project) => inside(project, file)) ?? []))
  const dependents = new Map<string, Array<string>>()
  for (const target of plan?.targets ?? []) {
    for (const dependency of target.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), target.label])
    }
  }
  const distances = new Map<string, number>()
  let frontier = labels.filter((label) => owners.has(projectOf(label)))
  for (let distance = 0; frontier.length > 0; distance++) {
    const next: Array<string> = []
    for (const label of frontier) {
      if (distances.has(label)) continue
      distances.set(label, distance)
      next.push(...(dependents.get(label) ?? []))
    }
    frontier = next
  }
  return new Map(labels.map((label) => [label, distances.get(label) ?? unreachable]))
}

/**
 * What a run record says about each target that ran: its attempts, and
 * whether it failed or was flaky. A target that never ran, a cache hit or a
 * skip, has no outcome and is not a row. A target with no recorded attempts
 * has one, its status.
 *
 * @category labels
 * @since 0.1.0
 * @throws {never}
 */
export const outcomes = (record: RunRecord): ReadonlyArray<Pick<Row, "target" | "attempts" | "failed" | "flaky">> =>
  record.results.flatMap((result) => {
    if (result.status !== "ran" && result.status !== "failed") return []
    const attempts = (result.attempts ?? []).map((attempt) => attempt.passed)
    const verdict = verdictOf(result)
    return [{
      target: result.label,
      attempts: attempts.length === 0 ? [result.status === "ran"] : attempts,
      failed: verdict === "fail",
      flaky: verdict === "flaky"
    }]
  })

/**
 * What {@link build} reads about one change.
 *
 * @category models
 * @since 0.1.0
 */
export interface Change {
  /** The commit the run record names. */
  readonly commit: string
  /** When the change was made, in milliseconds since the epoch. */
  readonly at: number
  /** The files the change touched. */
  readonly files: ReadonlyArray<string>
  /** Earlier commits, back to {@link horizonDays} before the change. */
  readonly history: ReadonlyArray<Commit>
  /** Every file of the repository at the change. */
  readonly tree: ReadonlyArray<string>
  /** Earlier rows of the same repository. */
  readonly past: ReadonlyArray<Observation>
  /** The change's plan, when one is known. */
  readonly plan: Plan | undefined
}

/**
 * One row per target that ran in `record`, with the six features.
 *
 * @category rows
 * @since 0.1.0
 * @throws {never}
 */
export const build = (record: RunRecord, change: Change): ReadonlyArray<Row> => {
  const labelled = outcomes(record)
  const distances = graphDistances(change.files, labelled.map((outcome) => outcome.target), change.plan)
  const extensions = extensionsOf(change.files)
  const changes = fileChanges(change.files, change.at, change.history)
  const runs = new Map<string, Array<Observation>>()
  for (const observation of change.past) {
    if (observation.row.commit === change.commit) continue
    const known = runs.get(observation.row.target)
    if (known === undefined) runs.set(observation.row.target, [observation])
    else known.push(observation)
  }
  const tests = new Map<string, number>()
  return labelled.map((outcome) => {
    const project = projectOf(outcome.target)
    if (!tests.has(project)) tests.set(project, testCount(change.tree, project))
    return {
      commit: change.commit,
      target: outcome.target,
      features: {
        extensions,
        fileChanges: changes,
        failureRates: failureRates(change.at, runs.get(outcome.target) ?? []),
        project,
        testCount: tests.get(project)!,
        graphDistance: distances.get(outcome.target)!
      },
      attempts: outcome.attempts,
      failed: outcome.failed,
      flaky: outcome.flaky
    }
  })
}
