/**
 * Triage every open issue in a GitHub repository into a board grouped by type.
 *
 * Port of the 0.x `github-issues.jsx`. One triager agent fetches the open
 * issues with the `gh` CLI and gives each a type, a priority and up to three
 * suggested labels in a single pass. A pure step then groups the issues into
 * four columns, bug, feature, question and chore, in that order.
 *
 * 0.x's header promised three parallel triage lanes, but its code ran one agent pass; the port keeps the code's single pass. `Kanban` does not fit: it moves each item through per-column steps that 0.x never had.
 * 0.x gave the triager a `bash` tool for `gh`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The board's columns, in the order 0.x built them. */
export const types = ["bug", "feature", "question", "chore"] as const

/** One triaged issue. */
export const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  type: Schema.Literals(types),
  priority: Schema.Literals(["P0", "P1", "P2", "P3"]),
  suggestedLabels: Schema.Array(Schema.String)
})

/** The triager's answer: every open issue, triaged. */
export const Triaged = Schema.Struct({
  repo: Schema.String,
  issues: Schema.Array(Issue)
})

/** The board the flow settles with. */
export const Board = Schema.Struct({
  repo: Schema.String,
  total: Schema.Number,
  columns: Schema.Array(Schema.Struct({
    name: Schema.String,
    cards: Schema.Array(Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      priority: Schema.String
    }))
  }))
})

/** Fetches and triages every open issue in one pass. */
export const TriageIssues = AgentAction.make("examples/GitHubIssues/Triage", {
  payload: { repo: Schema.String },
  output: Triaged,
  seat,
  system: [
    `You triage GitHub issues. Fetch the OPEN issues for the given
repo with: gh issue list --repo <repo> --state open --limit 100 --json number,title,labels
Then, for every issue, decide its type (bug | feature | question | chore), a
priority (P0-P3), and up to 3 suggested labels. Return all issues, no omissions.`
  ],
  prompt: ({ repo }) =>
    `Triage every open issue in ${repo}. Use the gh CLI to fetch them, then classify, prioritize, and label each one.`
})

/**
 * Groups the triaged issues by type. Pure, so it is a `Node.map`, not a step.
 * The board names the repository the flow was asked about, as 0.x did, not the
 * one the triager echoed.
 */
const board = (
  { issues, repo }: { readonly repo: string; readonly issues: ReadonlyArray<typeof Issue.Type> }
): typeof Board.Type => ({
  repo,
  total: issues.length,
  columns: types.map((name) => ({
    name,
    cards: issues
      .filter((issue) => issue.type === name)
      .map(({ number, priority, title }) => ({ number, title, priority }))
  }))
})

/** The flow: triage every open issue, then build the board. */
export const GitHubIssues = Flow.make("examples/GitHubIssues", {
  payload: { repo: Schema.optional(Schema.String) },
  success: Board,
  error: AgentAction.AgentFailure,
  body: ({ repo = "smithersai/smithers" }) =>
    Node.bindPlanned(
      TriageIssues.call({ repo }),
      (triaged: Planned.Planned<typeof Triaged.Type>) => Node.map(Node.succeed({ repo, issues: triaged.issues }), board)
    )
})

/** Every step the flow calls. */
export const layer = TriageIssues.layer
