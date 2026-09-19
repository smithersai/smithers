/**
 * The flow's actual source, as the code tab shows it.
 *
 * This is real `@smthrs/flow` — `Action.make` / `AgentAction.make` / `Node.*` /
 * `Flow.make` — not pseudocode, so the drill-in can highlight the exact call site
 * a plan node was built from and the reader can check it against the repo.
 */

export interface SourceFile {
  readonly path: string
  readonly text: string
  /** Node id → the 1-indexed inclusive line range of its declaration. */
  readonly ranges: Readonly<Record<string, readonly [number, number]>>
}

/**
 * Plan node ids are structural AST paths built during the `Graph.build` walk.
 * They are the one source-shaped provenance the engine keeps today.
 */
export const AST_PATH: Readonly<Record<string, readonly string[]>> = {
  issues: ["root", "subject"],
  triage: ["root", "subject", "bindPlanned"],
  branch: ["root", "branch"],
  defer: ["root", "else"],
  repro: ["root", "then"],
  test: ["root", "then", "bindPlanned", "protected"],
  bundle: ["root", "then", "bindPlanned", "failure"],
  approve: ["root", "then", "bindPlanned", "andThen"],
  change: ["root", "then", "bindPlanned", "andThen", "andThen"],
  writetest: ["root", "then", "bindPlanned", "andThen", "andThen", "bindPlanned"],
  checks: ["root", "then", "bindPlanned", "andThen", "andThen", "bindPlanned", "bindPlanned"],
  pr: ["root", "then", "…", "bindPlanned", "bindPlanned", "bindPlanned"],
  notify: ["root", "then", "…", "bindPlanned", "bindPlanned", "bindPlanned", "bindPlanned"]
}

const FLOW_TS = `import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, HumanTask, RetryPolicy } from "@smthrs/flow"
import { Classifier } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"

import { AICheck } from "../repository/checks.ts"
import * as T from "./schema.ts"

/** Every issue opened since the last run. Sealed, so a second run in the window is free. */
const ListIssues = Action.make("github/list-issues", {
  payload: { repo: Schema.NonEmptyString, since: Schema.DateTimeUtc },
  success: Schema.Array(T.Issue),
  error: T.GithubError,
  tier: "sealed",
  idempotencyKey: ({ repo, since }) => \`\${repo}@\${since}\`
})

/** Jev, not a chat model: three typed questions, three typed answers, no prose. */
const relevance = Classifier.make("triage/relevance", {
  description: "Which new issues are worth an agent's time.",
  state: Schema.Struct({ issue: T.Issue, rules: Schema.Array(T.Rule) }),
  questions: {
    needsChange: { type: "boolean", instructions: "Does this need a code change?" },
    role: { type: "choice", instructions: "What kind of file?", criteria: {
      implementation: "product code", fixture: "test data", unrelated: "neither"
    } },
    risk: { type: "score", instructions: "Edit risk", criteria: ["none", "low", "medium", "high"] }
  }
})

/** The plan node that asks it. The classifier runs inside this action's layer. */
const Triage = Action.make("triage/relevance", {
  payload: { issues: Schema.Array(T.Issue), rules: Schema.Array(T.Rule) },
  success: T.Triaged,
  error: Classifier.ClassifierError,
  nondeterministic: true
})

export const TriageLive = Triage.toLayer(({ issues, rules }) =>
  relevance.evaluateAll(issues.map((issue) => ({ issue, rules }))).pipe(Effect.map(T.pickTop(issues)))
)

/** The agent that reproduces the bug. Its seat supplies the model, budget and tools. */
const Reproduce = AgentAction.make("coding/reproduce", {
  payload: { issue: T.Issue, parent: T.Revision },
  output: T.Reproduction,
  seat: "coding/implement",
  system: [
    "Reproduce the reported defect in the owning workspace.",
    "The flow owns JJ operations: never commit, never switch workspaces.",
    "Report the files you read and wrote."
  ],
  prompt: (input) => JSON.stringify(input)
})

const RunTests = Action.make("proc/spawn", {
  payload: { command: Schema.NonEmptyString, cwd: T.Path },
  success: T.CommandResult,
  error: T.SpawnError,
  tier: "compensable",
  retryPolicy: RetryPolicy.make({ initialMs: 200, factor: 1.5, maxMs: 30_000 })
})

const Diagnose = Action.make("coding/diagnose", {
  payload: { cause: T.SpawnError },
  success: T.DiagnosisBundle,
  tier: "sealed"
})

/** One durable wait point per attempt. Sits in front of every irreversible step. */
const Approve = HumanTask.action.call({
  name: "approve-change",
  kind: "confirm",
  prompt: "Land a failing test on a new change?",
  maxAttempts: 10
})

const CreateChange = Action.make("jj/create-change", {
  payload: { parent: T.Revision, message: Schema.NonEmptyString },
  success: T.Revision,
  error: T.NativeCodingError,
  tier: "irreversible"
})

const WriteTest = AgentAction.make("coding/edit-atom", {
  payload: { reproduction: T.Reproduction, parent: T.Revision },
  output: T.EditReport,
  seat: "coding/implement",
  system: ["Write one failing test for the reproduction. One atom, nothing else."],
  prompt: (input) => JSON.stringify(input)
})

const OpenPr = Action.make("github/open-pr", {
  payload: { checked: T.CheckedChange },
  success: T.PullRequest,
  error: T.GithubError,
  tier: "irreversible"
})

const Post = Action.make("slack/post", {
  payload: { pr: T.PullRequest },
  success: T.Posted,
  error: T.SlackError,
  tier: "irreversible"
})

const Label = Action.make("github/label", {
  payload: { issue: T.Issue, label: Schema.NonEmptyString },
  success: T.Labelled,
  error: T.GithubError,
  tier: "compensable"
})

/**
 * The plan. Both branch arms are built, the catch handler is built, and the
 * human gate sits in front of every irreversible step.
 */
export default Flow.make("morning-triage", {
  payload: {
    repo: Schema.NonEmptyString,
    since: Schema.DateTimeUtc,
    head: T.Revision,
    rules: Schema.Array(T.Rule)
  },
  success: Schema.Union([T.Posted, T.Labelled]),
  error: T.CodingError,
  body: ({ repo, since, head, rules }) =>
    Node.branch(
      ListIssues.call({ repo, since }).pipe(
        Node.bindPlanned((issues) => Triage.call({ issues, rules }))
      ),
      {
        if: (top) => top.needsChange && top.risk !== "high",
        else: (top) => Label.call({ issue: top.issue, label: "needs-repro" }),
        then: (top) =>
          Reproduce.call({ issue: top.issue, parent: head }).pipe(
            Node.bindPlanned((repro) =>
              Node.catch(
                RunTests.call({ command: "bun test --filter @tevm/state", cwd: repro.workspace }),
                { onFailure: (cause) => Diagnose.call({ cause }) }
              ).pipe(
                Node.andThen(Approve),
                Node.andThen(
                  CreateChange.call({ parent: head, message: "test: reproduce the top triaged issue" }).pipe(
                    Node.bindPlanned((change) => WriteTest.call({ reproduction: repro, parent: change })),
                    Node.bindPlanned((edit) => AICheck.call({ rules, comparison: edit.diff })),
                    Node.bindPlanned((checked) => OpenPr.call({ checked })),
                    Node.bindPlanned((pr) => Post.call({ pr }))
                  )
                )
              )
            )
          )
      }
    )
})
`

export const FLOW_SOURCE: SourceFile = {
  path: "flows/morning-triage/flow.ts",
  text: FLOW_TS,
  ranges: {
    issues: [10, 17],
    triage: [19, 42],
    repro: [44, 55],
    test: [57, 63],
    bundle: [65, 69],
    approve: [71, 77],
    change: [79, 84],
    writetest: [86, 92],
    pr: [94, 99],
    notify: [101, 106],
    defer: [108, 113],
    branch: [129, 136],
    checks: [147, 147]
  }
}

/** The trigger is registered in the Dispatcher, not in the flow body. */
export const TRIGGER_SOURCE: SourceFile = {
  path: ".smithers/FACTORY.ts",
  text: `import { S } from "@smthrs/targets"

export const triggers = S.Triggers({
  "morning-triage": S.Cron({
    schedule: "0 8 * * 1-5",
    timezone: "America/New_York",
    input: { repo: "tevm/tevm-monorepo", since: S.LastRunAt }
  })
})
`,
  ranges: { trigger: [3, 9] }
}
