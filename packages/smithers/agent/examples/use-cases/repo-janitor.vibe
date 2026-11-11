/**
 * Scan a repository for maintenance items, apply low-risk fixes by category, and write the cleanup pull request's summary.
 *
 * Port of the 0.x `repo-janitor.jsx`. A scanner agent reports the maintenance
 * items it finds. Five category fixers (warnings, stale TODOs, broken
 * examples, formatting, docs) run three at a time, and each runs only when the
 * scan reported its category with a non-zero count. When the fixes add up to
 * at least one, a PR author agent writes the pull request's title, body and
 * risk level; otherwise the flow settles a fixed "no fixes needed" summary.
 *
 * 0.x's scan writes one `scanResult` row, so at most one category reaches a fixer per run; the port keeps that.
 * Neither 0.x nor this flow declares its schedule; a host trigger starts it. `ScanFixVerify` does not fit: 0.x never verifies or rescans.
 * 0.x's fix and summary prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x's agents opened the PR and edited files through `bash`, `read`, `write` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The maintenance categories, in 0.x's order. */
export const categories = ["warnings", "stale-todos", "broken-examples", "formatting", "docs"] as const

/** What the scanner found in one category. */
export const ScanResult = Schema.Struct({
  category: Schema.Literals(categories),
  items: Schema.Array(Schema.Struct({
    file: Schema.String,
    line: Schema.optional(Schema.Number),
    description: Schema.String,
    severity: Schema.Literals(["low", "medium"])
  })),
  count: Schema.Number
})

/** What one category's fixer changed and skipped. */
export const FixResult = Schema.Struct({
  category: Schema.String,
  filesChanged: Schema.Array(Schema.String),
  fixCount: Schema.Number,
  skipped: Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String })),
  summary: Schema.String
})

/** The cleanup pull request's summary, which the flow settles with. */
export const PrSummary = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  totalFixes: Schema.Number,
  categories: Schema.Array(Schema.String),
  filesChanged: Schema.Array(Schema.String),
  riskLevel: Schema.Literals(["low", "medium"])
})

type Category = (typeof categories)[number]
type FixResult = typeof FixResult.Type

/** Finds maintenance items without changing anything. */
export const Scan = AgentAction.make("examples/RepoJanitor/Scan", {
  payload: { repoRoot: Schema.String, categories: Schema.Array(Schema.String), maxItemsPerCategory: Schema.Number },
  output: ScanResult,
  seat,
  system: [
    `You are a repo scanner. Identify maintenance items in the codebase without
making any changes. Look for compiler warnings, stale TODOs, broken examples, formatting
inconsistencies, and docs drift. Be precise about file paths and line numbers.`
  ],
  prompt: ({ categories, maxItemsPerCategory, repoRoot }) =>
    `Scan the repository for maintenance items.\n\nRepo root: ${repoRoot}\nCategories: ${
      categories.join(", ")
    }\nMax items per category: ${maxItemsPerCategory}`
})

/** What each 0.x fix prompt asked for. */
const asks: Record<Category, string> = {
  warnings: "Fix these compiler warnings",
  "stale-todos": "Resolve or remove these stale TODOs",
  "broken-examples": "Repair these broken examples",
  formatting: "Normalize the formatting of these files",
  docs: "Fix these docs inconsistencies"
}

/** Applies low-risk fixes to one category's items. */
export const Fix = AgentAction.make("examples/RepoJanitor/Fix", {
  payload: { category: Schema.Literals(categories), items: ScanResult.fields.items },
  output: FixResult,
  seat,
  system: [
    `You are a maintenance agent. Apply low-risk, mechanical fixes to the codebase.
Never change logic or public APIs. Stick to safe transformations: removing dead imports,
updating stale comments, fixing broken links, normalizing formatting. If a fix feels risky, skip it.`
  ],
  prompt: ({ category, items }) => `${asks[category]}.\n\nCategory: ${category}\nItems: ${JSON.stringify(items)}`
})

/** Writes the pull request's summary over every fix. */
export const Summarize = AgentAction.make("examples/RepoJanitor/Summarize", {
  payload: {
    fixResults: Schema.Array(FixResult),
    totalFixes: Schema.Number,
    filesChanged: Schema.Array(Schema.String),
    categories: Schema.Array(Schema.String)
  },
  output: PrSummary,
  seat,
  system: [
    `You are a PR author. Create a well-structured pull request summarizing
all maintenance work performed. Use conventional commit style. Group changes by category.`
  ],
  prompt: ({ categories, filesChanged, fixResults, totalFixes }) =>
    `Summarize the maintenance work for one pull request.\n\nTotal fixes: ${totalFixes}\nCategories: ${
      categories.join(", ")
    }\nFiles changed: ${filesChanged.join(", ")}\nFix results: ${JSON.stringify(fixResults)}`
})

/** 0.x's fallback task, settled when nothing was fixed. */
export const empty: typeof PrSummary.Type = {
  title: "chore: repo janitor — no fixes needed",
  body: "Scanned the repository and found no actionable maintenance items.",
  totalFixes: 0,
  categories: [],
  filesChanged: [],
  riskLevel: "low"
}

/** 0.x's task id for each category's fixer. */
const ids: Record<Category, string> = {
  warnings: "fix-warnings",
  "stale-todos": "fix-todos",
  "broken-examples": "fix-examples",
  formatting: "fix-formatting",
  docs: "fix-docs"
}

/** Totals the fixes that ran. Pure, so it is a `Node.map`, not a step. */
const tally = (fixed: Readonly<Record<string, unknown>>) => {
  const fixResults: ReadonlyArray<FixResult> = Object.values(fixed).filter(Schema.is(FixResult))
  return {
    fixResults,
    totalFixes: fixResults.reduce((sum, r) => sum + r.fixCount, 0),
    filesChanged: fixResults.flatMap((r) => r.filesChanged),
    categories: fixResults.map((r) => r.category)
  }
}

/** The flow: scan, fix the reported category, summarize or settle the empty summary. */
export const RepoJanitor = Flow.make("examples/RepoJanitor", {
  payload: { repoRoot: Schema.optional(Schema.String), maxItemsPerCategory: Schema.optional(Schema.Number) },
  success: PrSummary,
  error: AgentAction.AgentFailure,
  body: ({ maxItemsPerCategory = 20, repoRoot = "." }) =>
    Node.bindPlanned(
      Scan.call({ repoRoot, categories: [...categories], maxItemsPerCategory }),
      (scan: Planned.Planned<typeof ScanResult.Type>) => {
        // A fixer whose category the scan did not report settles as null.
        const members = Object.fromEntries(categories.map((category) => [
          ids[category],
          Node.branch(Node.succeed(scan), {
            if: (found) => found.category === category && found.count > 0,
            then: () => Fix.call({ category, items: scan.items }),
            else: () => Node.succeed(null)
          })
        ]))
        const fixed = Bounded.all(members, { concurrency: 3 })
        return Node.branch(Node.map(fixed, tally), {
          if: (totals) => totals.totalFixes > 0,
          then: (totals) => Summarize.call(totals),
          else: () => Node.succeed(empty)
        })
      }
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Scan.layer, Fix.layer, Summarize.layer)
