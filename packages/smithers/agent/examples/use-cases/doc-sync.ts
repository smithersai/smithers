/**
 * Compare docs with the code they describe, fix each discrepancy, and open one pull request.
 *
 * Port of the 0.x `doc-sync.jsx`. An auditor agent compares the docs directory
 * with the source directory and lists discrepancies. Each discrepancy that is
 * not `info` goes to a fixer agent, three at a time, and a failing fixer drops
 * only its own result. When any fix reports `fixed`, one pull request carries
 * those files; otherwise none is opened.
 *
 * `ScanFixVerify` does not fit: 0.x neither verifies the fixes nor scans again.
 * 0.x re-rendered its tree once the audit landed; here the fixers run in a `.child()` flow whose body plans over the real discrepancies.
 * 0.x's PR agent ran five fixed `git` and `gh` commands; here that is the deterministic `OpenPullRequest` action a host implements.
 * 0.x named the branch `docs/auto-sync-${Date.now()}` while rendering; a plan must not read the clock, so the host appends the time to `branchPrefix`.
 * 0.x gave the agents `read`, `grep`, `bash` and `edit` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One place a doc disagrees with the code it describes. */
export const Discrepancy = Schema.Struct({
  docFile: Schema.String,
  codeFile: Schema.String,
  issue: Schema.Literals(["outdated-api", "missing-param", "wrong-example", "missing-doc", "stale-reference"]),
  description: Schema.String,
  severity: Schema.Literals(["critical", "warning", "info"])
})

/** The auditor's answer. */
export const Audit = Schema.Struct({
  discrepancies: Schema.Array(Discrepancy),
  totalDocsChecked: Schema.Number
})

/** What one fixer did with its doc. */
export const FixResult = Schema.Struct({
  file: Schema.String,
  changes: Schema.String,
  status: Schema.Literals(["fixed", "needs-human", "skipped"])
})

/** The pull request a host is asked to open: 0.x's fixed `git` and `gh` commands as data. */
export const PullRequestRequest = Schema.Struct({
  branchPrefix: Schema.String,
  files: Schema.Array(Schema.String),
  commitMessage: Schema.String,
  title: Schema.String,
  body: Schema.String
})

/** The pull request the host opened. */
export const PullRequest = Schema.Struct({
  branch: Schema.String,
  prUrl: Schema.optional(Schema.String),
  filesChanged: Schema.Number,
  summary: Schema.String
})

/** What the flow settles with: every 0.x output, and `null` when no pull request was needed. */
export const Output = Schema.Struct({
  audit: Audit,
  fixes: Schema.Array(FixResult),
  pullRequest: Schema.NullOr(PullRequest)
})

type FixResult = typeof FixResult.Type
type PullRequestRequest = typeof PullRequestRequest.Type

/** Audits the docs against the source. */
export const AuditDocs = AgentAction.make("examples/DocSync/Audit", {
  payload: { docsDir: Schema.String, srcDir: Schema.String, format: Schema.String },
  output: Audit,
  seat,
  system: [
    `You are a docs auditor. Compare documentation files against the actual
source code. Check that API signatures, parameter names, return types, and examples
all match the current implementation. Be thorough and precise.`
  ],
  prompt: ({ docsDir, format, srcDir }) =>
    `Audit documentation against source code:\n\nDocs directory: ${docsDir}\nSource directory: ${srcDir}\nDoc format: ${format}\n\nFor each doc file:\n1. Find the corresponding source code\n2. Verify all API signatures match\n3. Check that examples are valid\n4. Flag any stale references`
})

/** Fixes one discrepancy. */
export const FixDoc = AgentAction.make("examples/DocSync/Fix", {
  payload: Discrepancy,
  output: FixResult,
  seat,
  system: [
    `You are a technical writer. Fix documentation to match the actual code.
Preserve the existing style and tone. Only fix factual inaccuracies — don't rewrite
for style. Make minimal, surgical edits.`
  ],
  prompt: ({ codeFile, description, docFile, issue }) =>
    `Fix this documentation discrepancy:\nFile: ${docFile}\nIssue: ${issue} - ${description}\nReference code: ${codeFile}\n\nMake minimal edits to fix the factual error.`
})

/**
 * Opens the pull request. Deterministic: a host implements it with `git` and `gh`.
 * Irreversible with no idempotency key, so the engine runs it at most once
 * rather than open a second pull request on a retry.
 */
export const OpenPullRequest = Action.make("examples/DocSync/OpenPullRequest", {
  payload: PullRequestRequest,
  success: PullRequest,
  tier: "irreversible"
})

/**
 * Fixes every discrepancy that is not `info`. It runs as a child execution, so
 * its payload is real when its body plans and it can fan out over the list.
 */
export const FixAll = Flow.make("examples/DocSync/FixAll", {
  payload: { discrepancies: Schema.Array(Discrepancy) },
  success: Schema.Array(FixResult),
  body: Node.capture({}, ({ discrepancies }) => {
    const fixable = discrepancies.filter((d) => d.severity !== "info")
    if (fixable.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed fixer settles as null instead of failing its siblings.
    const members = Object.fromEntries(fixable.map((discrepancy, i) => [
      `fix-${i}`,
      Node.catch(FixDoc.call(discrepancy), { onFailure: Node.capture({}, () => Node.succeed(null)) })
    ]))
    const joined = Bounded.all(members, { concurrency: 3 })
    return Node.map(joined, Node.capture({}, (fixed) => Object.values(fixed).filter(Schema.is(FixResult))))
  })
})

/** The pull request 0.x's PR prompt spelled out, over the files a fixer fixed. Pure. */
const request = (fixes: ReadonlyArray<FixResult>): PullRequestRequest => {
  const files = fixes.filter((f) => f.status === "fixed").map((f) => f.file)
  return {
    branchPrefix: "docs/auto-sync-",
    files,
    commitMessage: "docs: sync documentation with source code",
    title: "docs: auto-sync documentation",
    body: `Fixes ${files.length} documentation discrepancies found by automated audit`
  }
}

/** The flow: audit, fix, and open a pull request when anything was fixed. */
export const DocSync = Flow.make("examples/DocSync", {
  payload: {
    docsDir: Schema.optional(Schema.String),
    srcDir: Schema.optional(Schema.String),
    format: Schema.optional(Schema.String)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: Node.capture({}, ({ docsDir = "docs/", format = "mdx", srcDir = "src/" }) =>
    Node.bindPlanned(
      AuditDocs.call({ docsDir, srcDir, format }),
      Node.capture({}, (audit: Planned.Planned<typeof Audit.Type>) =>
        Node.bindPlanned(
          FixAll.child({ discrepancies: audit.discrepancies }),
          Node.capture({}, (fixes: Planned.Planned<ReadonlyArray<FixResult>>) =>
            Node.bindPlanned(
              Node.branch(Node.map(Node.succeed(fixes), Node.capture({}, request)), {
                if: Node.capture({}, (pr) => pr.files.length > 0),
                then: Node.capture({}, (pr) => OpenPullRequest.call(pr)),
                else: Node.capture({}, () => Node.succeed(null))
              }),
              Node.capture({}, (pullRequest) => Node.succeed({ audit, fixes, pullRequest }))
            ))
        ))
    ))
})

/** What a host supplies for the step that leaves the model. */
export interface Host {
  readonly openPullRequest: (request: PullRequestRequest) => Effect.Effect<typeof PullRequest.Type>
}

/** Every step the flow calls, the child flow it starts, and the host's pull-request step. */
export const layer = (host: Host) =>
  Layer.mergeAll(
    AuditDocs.layer,
    FixDoc.layer,
    OpenPullRequest.toLayer(host.openPullRequest),
    Interpreter.layer(FixAll)
  )
