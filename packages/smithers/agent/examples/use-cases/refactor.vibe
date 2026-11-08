/**
 * Find a pattern, refactor each file that has it, and verify the result.
 *
 * Port of the 0.x `refactor.jsx`. An analyzer agent lists every file and
 * occurrence of the pattern. A refactorer agent rewrites each listed file,
 * five at a time, and a failing one drops only its own result. When any change
 * came back, a verifier agent runs typecheck, tests and lint. A summary counts
 * the changes by status.
 *
 * 0.x re-rendered its tree once the analysis landed; here the refactors run in a `.child()` flow whose body plans over the real targets.
 * `ScanFixVerify` does not fit: 0.x scans once, never loops, and verifies only when a change came back. 0.x asks no one for approval, so `Intervene` would add a gate it lacks.
 * 0.x's analyze prompt printed `example` only when it was a string, while its refactor prompt read the example's `before` and `after`; here `example` is that pair and both prompts show it.
 * 0.x gave the agents `read`, `grep`, `edit` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One file the analyzer found the pattern in. */
export const Target = Schema.Struct({
  file: Schema.String,
  pattern: Schema.String,
  occurrences: Schema.Number,
  complexity: Schema.Literals(["simple", "moderate", "complex"])
})

/** The analyzer's answer. */
export const Analysis = Schema.Struct({
  targets: Schema.Array(Target),
  totalOccurrences: Schema.Number,
  estimatedImpact: Schema.String
})

/** What the refactorer did to one file. */
export const Change = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["refactored", "skipped", "failed"]),
  changes: Schema.String,
  linesChanged: Schema.Number
})

/** The verifier's answer. */
export const Verification = Schema.Struct({
  typecheck: Schema.Boolean,
  tests: Schema.Boolean,
  lint: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  passed: Schema.Boolean
})

/** The summary the flow settles with. */
export const Summary = Schema.Struct({
  totalTargets: Schema.Number,
  refactored: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
  verified: Schema.Boolean,
  summary: Schema.String
})

/** A before-and-after pair showing the refactoring. */
export const Example = Schema.Struct({ before: Schema.String, after: Schema.String })

type Target = typeof Target.Type
type Change = typeof Change.Type

/** Lists every file and occurrence of the pattern. */
export const Analyze = AgentAction.make("examples/Refactor/Analyze", {
  payload: {
    directory: Schema.String,
    pattern: Schema.String,
    refactoring: Schema.String,
    example: Schema.NullOr(Example)
  },
  output: Analysis,
  seat,
  system: [
    `You are a static analysis agent. Find all occurrences of the pattern
that needs refactoring. Be thorough — don't miss any.`
  ],
  prompt: ({ directory, example, pattern, refactoring }) =>
    `Find all occurrences of this pattern in "${directory}":\n\nPattern: ${pattern}\nRefactoring: ${refactoring}\n\nExample: ${
      example === null ? "N/A" : `\nBefore: ${example.before}\nAfter: ${example.after}`
    }\n\nList every file and occurrence that needs changing.`
})

/** Applies the refactoring to one file. */
export const RefactorFile = AgentAction.make("examples/Refactor/RefactorFile", {
  payload: {
    file: Schema.String,
    pattern: Schema.String,
    occurrences: Schema.Number,
    refactoring: Schema.String,
    example: Schema.NullOr(Example)
  },
  output: Change,
  seat,
  system: [
    `You are a refactoring agent. Apply the specified refactoring to the given file.
Make precise, minimal changes. Preserve behavior exactly. Don't change formatting
of lines you're not refactoring.`
  ],
  prompt: ({ example, file, occurrences, pattern, refactoring }) =>
    `Refactor "${file}":\nPattern: ${pattern} (${occurrences} occurrences)\nRefactoring: ${refactoring}${
      example === null ? "" : `\nExample:\nBefore: ${example.before}\nAfter: ${example.after}`
    }`
})

/** Runs typecheck, tests and lint over the directory. */
export const Verify = AgentAction.make("examples/Refactor/Verify", {
  payload: { directory: Schema.String, typecheckCmd: Schema.String, testCmd: Schema.String, lintCmd: Schema.String },
  output: Verification,
  seat,
  system: [
    `You are a verification agent. Run typecheck, tests, and lint to ensure
the refactoring didn't break anything.`
  ],
  prompt: ({ directory, lintCmd, testCmd, typecheckCmd }) =>
    `Verify the refactoring didn't break anything:\nDirectory: ${directory}\n1. ${typecheckCmd}\n2. ${testCmd}\n3. ${lintCmd}`
})

/**
 * Refactors the analyzed files. It runs as a child execution, so its payload
 * is real when its body plans, and it fans out over the targets the analyzer
 * actually listed.
 */
export const RefactorTargets = Flow.make("examples/Refactor/RefactorTargets", {
  payload: { targets: Schema.Array(Target), refactoring: Schema.String, example: Schema.NullOr(Example) },
  success: Schema.Array(Change),
  body: ({ example, refactoring, targets }) => {
    if (targets.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed refactor settles as null instead of failing its siblings.
    const members = Object.fromEntries(targets.map((target, index) => [
      `${index}`,
      Node.catch(
        RefactorFile.call({
          file: target.file,
          pattern: target.pattern,
          occurrences: target.occurrences,
          refactoring,
          example
        }),
        { onFailure: () => Node.succeed(null) }
      )
    ]))
    const joined = Bounded.all(members, { concurrency: 5 })
    return Node.map(joined, (changed) => Object.values(changed).filter(Schema.is(Change)))
  }
})

/** Counts the changes. Pure, so it is a `Node.map`, not a step. */
const summarize = ({ changes, targets, verification }: {
  readonly targets: ReadonlyArray<Target>
  readonly changes: ReadonlyArray<Change>
  readonly verification: typeof Verification.Type | null
}): typeof Summary.Type => {
  const count = (status: Change["status"]) => changes.filter((change) => change.status === status).length
  const verified = verification?.passed ?? false
  return {
    totalTargets: targets.length,
    refactored: count("refactored"),
    skipped: count("skipped"),
    failed: count("failed"),
    verified,
    summary: `Refactored ${count("refactored")}/${targets.length} files. Verification: ${
      verified ? "passed" : "pending/failed"
    }`
  }
}

/** The flow: analyze, refactor every target, verify when anything changed, summarize. */
export const Refactor = Flow.make("examples/Refactor", {
  payload: {
    directory: Schema.String,
    pattern: Schema.String,
    refactoring: Schema.String,
    example: Schema.optional(Example),
    typecheckCmd: Schema.optional(Schema.String),
    testCmd: Schema.optional(Schema.String),
    lintCmd: Schema.optional(Schema.String)
  },
  success: Summary,
  error: AgentAction.AgentFailure,
  body: ({
    directory,
    example,
    lintCmd = "npx eslint .",
    pattern,
    refactoring,
    testCmd = "npm test",
    typecheckCmd = "npx tsc --noEmit"
  }) =>
    Node.bindPlanned(
      Analyze.call({ directory, pattern, refactoring, example: example ?? null }),
      (analysis: Planned.Planned<typeof Analysis.Type>) =>
        Node.branch(RefactorTargets.child({ targets: analysis.targets, refactoring, example: example ?? null }), {
          if: (changes) => changes.length > 0,
          then: (changes) =>
            Node.bindPlanned(
              Verify.call({ directory, typecheckCmd, testCmd, lintCmd }),
              (verification) => Node.map(Node.succeed({ targets: analysis.targets, changes, verification }), summarize)
            ),
          else: (changes) =>
            Node.map(Node.succeed({ targets: analysis.targets, changes, verification: null }), summarize)
        })
    )
})

/** Every step the flow calls, and the child flow it starts. */
export const layer = Layer.mergeAll(Analyze.layer, RefactorFile.layer, Verify.layer, Interpreter.layer(RefactorTargets))
