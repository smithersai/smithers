import { Option, Schema } from "effect"
import { FLOW_NAME } from "./RepoFlow.ts"

// When a repository's flows run (docs/features/ci.md#triggers): the trigger rows of the repository's plugin manifest,
// `.smithers/factory.json` on its default branch (ruling FLOW-10: "a flow file never says when it runs"; decision 0017's
// `Plugin.Manifest`, its `contributes.triggers`), and whether a GitHub event matches one. Pure: the manifest is data the
// host reads, never a program it runs.
//
//   { "apiVersion": 1, ..., "contributes": { "triggers": [
//     { "on": "github.push", "flow": "ci", "branches": ["main"] },
//     { "on": "github.pull_request", "flow": "ci" } ] } }

/** Where a repository's manifest lives. */
export const MANIFEST_PATH = ".smithers/factory.json"

/**
 * The events this slice starts flows on, and `manual`: a person runs the flow by hand (docs/features/actions.md). A row
 * for another event (`cron`, `run.settled`, ...) is skipped.
 */
export const EVENTS = ["github.push", "github.pull_request", "manual"] as const

/** The pull request actions a trigger matches when it names none: GitHub's `pull_request` defaults. */
export const DEFAULT_ACTIONS = ["opened", "synchronize", "reopened"] as const

/** The most trigger rows read from one manifest. */
export const MAX_TRIGGERS = 64

const Patterns = Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).check(
  Schema.isMaxLength(32),
)

/** One trigger row: decision 0017's `Trigger` (`on`, `flow`, `title`) with the filters this slice reads. */
export const Trigger = Schema.Struct({
  on: Schema.Literals(EVENTS),
  flow: Schema.String.check(Schema.isPattern(FLOW_NAME)),
  title: Schema.optional(Schema.String),
  /** Push: the branches pushed to; pull request: its base branch. Every branch when absent, unless `tags` is set. */
  branches: Schema.optional(Patterns),
  /** Push only: the tags pushed. A tag push matches only a trigger that names tags. */
  tags: Schema.optional(Patterns),
  /** Pull request only: its actions, `DEFAULT_ACTIONS` when absent. */
  actions: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
})
export type Trigger = typeof Trigger.Type

const Manifest = Schema.Struct({
  apiVersion: Schema.Literal(1),
  contributes: Schema.optional(Schema.Struct({ triggers: Schema.optional(Schema.Array(Schema.Unknown)) })),
})
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))
const decodeTrigger = Schema.decodeUnknownOption(Trigger)

/**
 * The trigger rows of manifest `text`: none when it isn't a `Plugin.Manifest` (`apiVersion: 1`), as `.smithers/factory.json`
 * written by `S.Factory` isn't. A row this slice can't read (another event, a bad flow name) is skipped; the rest stand.
 */
export const triggersOf = (text: string): ReadonlyArray<Trigger> =>
  Option.match(decodeManifest(text), {
    onNone: () => [],
    onSome: (manifest) =>
      (manifest.contributes?.triggers ?? []).slice(0, MAX_TRIGGERS).flatMap((row) =>
        Option.match(decodeTrigger(row), { onNone: () => [], onSome: (trigger) => [trigger] })
      ),
  })

/** What a trigger is matched against: one GitHub event, as the webhook names it. */
export interface Event {
  readonly event: "push" | "pull_request"
  /** Push: the branch pushed to, or `null` for a tag; pull request: its base branch. */
  readonly branch: string | null
  /** Push: the tag pushed, or `null`. */
  readonly tag: string | null
  /** Pull request: its action. */
  readonly action: string | null
}

/**
 * Whether ref name `name` matches glob `pattern`: `*` is any run of characters but `/`, `**` any run at all, and every
 * other character is itself. A table over the pattern's tokens and the name's characters, never a regular expression,
 * so a pattern can't make matching backtrack: at most 255 by 255 steps.
 */
export const globMatches = (pattern: string, name: string): boolean => {
  const tokens: Array<string> = []
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      tokens.push("**")
      index++
    } else tokens.push(pattern[index]!)
  }
  // `row[j]`: whether the tokens so far match the name's first `j` characters.
  let row = Array.from({ length: name.length + 1 }, (_, j) => j === 0)
  for (const token of tokens) {
    const next = Array.from({ length: name.length + 1 }, () => false)
    for (let j = 0; j <= name.length; j++) {
      if (token === "**" || token === "*") {
        // Nothing, or one more character the wildcard may take.
        next[j] = row[j]! || (j > 0 && next[j - 1]! && (token === "**" || name[j - 1] !== "/"))
      } else {
        next[j] = j > 0 && row[j - 1]! && name[j - 1] === token
      }
    }
    row = next
  }
  return row[name.length]!
}

const any = (patterns: ReadonlyArray<string>, name: string): boolean => patterns.some((pattern) => globMatches(pattern, name))

/** Whether `trigger` starts its flow on `event`. */
export const matches = (trigger: Trigger, event: Event): boolean => {
  if (trigger.on !== `github.${event.event}`) return false
  if (event.event === "pull_request") {
    if (!(trigger.actions ?? DEFAULT_ACTIONS).includes(event.action ?? "")) return false
    return event.branch !== null && (trigger.branches === undefined || any(trigger.branches, event.branch))
  }
  if (event.tag !== null) return trigger.tags !== undefined && any(trigger.tags, event.tag)
  // As on GitHub: a push trigger that names only tags doesn't run on a branch.
  return event.branch !== null &&
    (trigger.branches === undefined ? trigger.tags === undefined : any(trigger.branches, event.branch))
}

/** The flows `triggers` start on `event`, each once, in the manifest's order. */
export const flowsFor = (triggers: ReadonlyArray<Trigger>, event: Event): ReadonlyArray<string> => [
  ...new Set(triggers.filter((trigger) => matches(trigger, event)).map((trigger) => trigger.flow)),
]

/** The flows a person may run by hand: those with a `manual` trigger, each once, in the manifest's order, and its title. */
export const manualFlows = (triggers: ReadonlyArray<Trigger>): ReadonlyArray<{ readonly name: string; readonly title?: string }> => {
  const seen = new Set<string>()
  return triggers.flatMap((trigger) => {
    if (trigger.on !== "manual" || seen.has(trigger.flow)) return []
    seen.add(trigger.flow)
    return [trigger.title === undefined ? { name: trigger.flow } : { name: trigger.flow, title: trigger.title }]
  })
}
