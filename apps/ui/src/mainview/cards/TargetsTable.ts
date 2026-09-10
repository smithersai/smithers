/*
 * The targets table's pure rules (docs/LOCAL-APP.md "Cards"): which rows a
 * filter keeps, what each row's last run says, and the chip vocabularies the
 * data itself supplies. No DOM, no store — the card component and the
 * controller both read these, and the tests pin them without React.
 */
import type { Target, TargetRunVerb } from "@smthrs/rpc/LocalApp"
import type { TargetRunState, TargetsView, TargetsViewMode } from "@smthrs/rpc/Cards"
import type { RunRecord } from "@smthrs/rpc/TargetGraph"

export interface TargetRow {
  readonly target: Target
  /** The most recent recorded run whose root is this label, if any. */
  readonly lastRun: RunRecord | undefined
  readonly state: TargetRunState
  /** The declaration marks this label featured (PACKAGE.ts `featured: true`); a group is featured when a member is. */
  readonly featured: boolean
  /** This user starred the label (target.star). */
  readonly starred: boolean
  /** Present on a grouped row: the name group this row stands for. */
  readonly group?: TargetGroup
}

/** What the user adds to the Featured view beside the declarations' own `featured`: their stars. */
export interface FeaturedFacts {
  readonly starred?: ReadonlyArray<string> | undefined
}

/** A row the Featured view keeps: featured or starred itself, or a group with such a member. */
const lit = (row: TargetRow): boolean =>
  row.featured || row.starred || (row.group?.members.some((member) => member.featured || member.starred) ?? false)

/**
 * The view the card opens on when none was chosen: Featured when any row is
 * featured or starred, otherwise All. An explicit choice always wins.
 */
export const viewMode = (view: TargetsView | undefined, rows: ReadonlyArray<TargetRow>): TargetsViewMode => {
  if (view?.mode !== undefined) return view.mode
  return rows.some(lit) ? "featured" : "all"
}

/** One run of a verb over the whole workspace (`ci //...`): the Featured view's run strip. */
export interface PatternRun {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly workspace: string
  readonly verb: TargetRunVerb
  readonly pattern: string
}

/** The strip's verbs in display order; `run` is left out because run targets are services, not a sweep. */
const STRIP_VERBS: ReadonlyArray<{ readonly verb: TargetRunVerb; readonly title: string; readonly summary: string }> = [
  { verb: "ci", title: "Run everything", summary: "Build, test, lint and docs over every target: the CI job's own step." },
  { verb: "build", title: "Build everything", summary: "Every build target." },
  { verb: "test", title: "Test everything", summary: "Every test target." },
  { verb: "lint", title: "Lint everything", summary: "Every lint target." },
  { verb: "docs", title: "Check every doc", summary: "Every docs target." }
]

/**
 * The pattern runs a repository offers, derived from its targets rather than
 * declared anywhere: `ci //...` whenever there are targets at all, and one
 * `<verb> //...` per kind the targets actually carry, over the root workspace.
 */
export const patternRuns = (targets: ReadonlyArray<Target>): ReadonlyArray<PatternRun> => {
  if (targets.length === 0) return []
  const kinds = new Set(targets.flatMap((target) => target.kinds))
  return STRIP_VERBS
    .filter((entry) => entry.verb === "ci" || kinds.has(entry.verb))
    .map((entry) => ({ id: entry.verb, title: entry.title, summary: entry.summary, workspace: ".", verb: entry.verb, pattern: "//..." }))
}

/**
 * A grouped row (docs/LOCAL-APP.md "Cards"): targets that share a NAME
 * across packages (`//packages/a:lint`, `//packages/b:lint`, …) collapse
 * into one row labelled Bazel-style `//...:lint`. The build CLI has no
 * `:name` wildcard (patterns are exact labels or `//pkg/...` subtrees), so
 * the label is display syntax and a group runs as one target.run per picked
 * member. Singletons stay plain rows.
 */
export interface TargetGroup {
  readonly name: string
  /** `//...:name`. */
  readonly label: string
  readonly members: ReadonlyArray<TargetRow>
  /** Member counts by state, for the summary cell. */
  readonly counts: Readonly<Record<TargetRunState, number>>
}

/** The Bazel-style label a name group wears. */
export const groupLabel = (name: string): string => `//...:${name}`
export const isGroupLabel = (label: string): boolean => label.startsWith("//...:")

/** Worst state wins, so a group with one failure reads failed. */
const STATE_RANK: Readonly<Record<TargetRunState, number>> = { failed: 3, running: 2, passed: 1, never: 0 }

const groupState = (members: ReadonlyArray<TargetRow>): TargetRunState =>
  members.reduce<TargetRunState>((worst, row) => (STATE_RANK[row.state] > STATE_RANK[worst] ? row.state : worst), "never")

/**
 * Rows for the table: every name shared by two or more targets becomes one
 * group row (its `target` is a synthetic `//...:name` with the union of the
 * members' kinds; `group` carries the members), and every other target stays
 * as it is. Loader order is kept by the first member's position.
 */
export const groupRows = (rows: ReadonlyArray<TargetRow>, facts: FeaturedFacts = {}): ReadonlyArray<TargetRow> => {
  const byName = new Map<string, Array<TargetRow>>()
  for (const row of rows) {
    const list = byName.get(row.target.name)
    if (list === undefined) byName.set(row.target.name, [row])
    else list.push(row)
  }
  const starred = new Set(facts.starred ?? [])
  const emitted = new Set<string>()
  const out: Array<TargetRow> = []
  for (const row of rows) {
    const members = byName.get(row.target.name) ?? [row]
    if (members.length < 2) {
      out.push(row)
      continue
    }
    if (emitted.has(row.target.name)) continue
    emitted.add(row.target.name)
    const label = groupLabel(row.target.name)
    const kinds = [...new Set(members.flatMap((member) => member.target.kinds))]
    const latest = members.reduce<RunRecord | undefined>(
      (best, member) => member.lastRun !== undefined && (best === undefined || member.lastRun.startedAt > best.startedAt) ? member.lastRun : best,
      undefined
    )
    const counts: Record<TargetRunState, number> = { never: 0, passed: 0, failed: 0, running: 0 }
    for (const member of members) counts[member.state] += 1
    out.push({
      target: {
        id: groupLabel(row.target.name),
        label,
        target: `${members.length} packages`,
        kinds,
        package: "//...",
        name: row.target.name,
        workspace: row.target.workspace
      },
      lastRun: latest,
      state: groupState(members),
      featured: members.some((member) => member.featured),
      starred: starred.has(label),
      group: { name: row.target.name, label, members, counts }
    })
  }
  return out
}

/** The group's members the user picked to run: the `picked` list when present, else all of them. */
export const pickedMembers = (
  group: TargetGroup,
  picked: Readonly<Record<string, ReadonlyArray<string>>> | undefined
): ReadonlyArray<TargetRow> => {
  const chosen = picked?.[group.label]
  if (chosen === undefined) return group.members
  const set = new Set(chosen)
  return group.members.filter((member) => set.has(member.target.label))
}

/** "3 failed · 34 passed · 2 never run", counting only nonzero states. */
export const groupSummary = (counts: Readonly<Record<TargetRunState, number>>): string =>
  (["failed", "running", "passed", "never"] as const)
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state === "never" ? "never run" : state}`)
    .join(" · ")

/** A recorded run's state in the table's four-word vocabulary. */
export const runStateOf = (run: RunRecord | undefined): TargetRunState => {
  if (run === undefined) return "never"
  if (run.status === "pending" || run.status === "running") return "running"
  if (run.status === "done") return "passed"
  return "failed"
}

/** The latest run per root label (runs arrive newest-first or not; sort by start). */
export const lastRunsByLabel = (runs: ReadonlyArray<RunRecord>): ReadonlyMap<string, RunRecord> => {
  const latest = new Map<string, RunRecord>()
  for (const run of runs) {
    const current = latest.get(run.label)
    if (current === undefined || run.startedAt > current.startedAt) latest.set(run.label, run)
  }
  return latest
}

/** Every row, in loader order, joined with its last run. */
export const targetRows = (
  targets: ReadonlyArray<Target>,
  runs: ReadonlyArray<RunRecord> = [],
  facts: FeaturedFacts = {}
): ReadonlyArray<TargetRow> => {
  const latest = lastRunsByLabel(runs)
  const starred = new Set(facts.starred ?? [])
  return targets.map((target) => {
    const lastRun = latest.get(target.label)
    return {
      target,
      lastRun,
      state: runStateOf(lastRun),
      featured: target.featured === true,
      starred: starred.has(target.label)
    }
  })
}

const has = (list: ReadonlyArray<string> | undefined, value: string): boolean =>
  list === undefined || list.length === 0 || list.includes(value)

/**
 * The rows a view keeps, in the view's order. An absent or empty facet keeps
 * everything. Featured keeps the declarations' featured labels and the
 * user's stars (loader order); Recent keeps only targets with a recorded
 * run, most recent first; All keeps loader order. The mode is resolved by
 * `viewMode` so the card and the tests agree on the default.
 */
export const filterRows = (
  rows: ReadonlyArray<TargetRow>,
  view: TargetsView | undefined,
  mode: TargetsViewMode = view?.mode ?? "all"
): ReadonlyArray<TargetRow> => {
  const scoped = mode === "featured"
    ? rows.filter(lit)
    : mode === "recent"
    ? rows.filter((row) => row.lastRun !== undefined).sort((left, right) =>
      (right.lastRun?.startedAt ?? 0) - (left.lastRun?.startedAt ?? 0)
    )
    : rows
  if (view === undefined) return scoped
  const query = (view.query ?? "").trim().toLowerCase()
  const matchesQuery = (row: TargetRow): boolean =>
    query === "" ||
    row.target.label.toLowerCase().includes(query) ||
    (row.target.summary?.toLowerCase().includes(query) ?? false) ||
    row.target.workspace.toLowerCase().includes(query) ||
    (row.group?.members.some((member) => member.target.label.toLowerCase().includes(query)) ?? false)
  const matchesWorkspace = (row: TargetRow): boolean =>
    view.workspace === undefined || view.workspace === "" ||
    row.target.workspace === view.workspace ||
    (row.group?.members.some((member) => member.target.workspace === view.workspace) ?? false)
  return scoped.filter((row) => {
    const { target, state } = row
    if (!matchesQuery(row)) return false
    if (view.kinds !== undefined && view.kinds.length > 0 && !target.kinds.some((kind) => view.kinds!.includes(kind))) {
      return false
    }
    if (!has(view.states, state)) return false
    return matchesWorkspace(row)
  })
}

/** The kinds the data carries, first-seen order. */
export const kindsOf = (targets: ReadonlyArray<Target>): ReadonlyArray<string> => {
  const seen: Array<string> = []
  for (const target of targets) {
    for (const kind of target.kinds) if (!seen.includes(kind)) seen.push(kind)
  }
  return seen
}

/** The workspaces the data carries, first-seen order. */
export const workspacesOf = (targets: ReadonlyArray<Target>): ReadonlyArray<string> => {
  const seen: Array<string> = []
  for (const target of targets) if (!seen.includes(target.workspace)) seen.push(target.workspace)
  return seen
}

/** Toggle one value in a chip list; an empty result is "no filter". */
export const toggled = (list: ReadonlyArray<string> | undefined, value: string): Array<string> => {
  const current = list ?? []
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
}
