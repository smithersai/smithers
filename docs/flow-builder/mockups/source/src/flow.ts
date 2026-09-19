/**
 * The flow this mock draws: `morning-triage`, a plausible Smithers flow built
 * only from vocabulary the engine actually has.
 *
 *  - every node is an `Action.make` / `AgentAction.make` / `Flow.make` call site
 *  - `tier` is the real `Action.Tier` literal union: sealed | compensable | irreversible
 *  - edge `reason` is the real `Graph.EdgeReason`: value | continuation | failure
 *  - `branch` expands BOTH arms into the plan; the arm not taken settles `skipped`
 *  - there is no loop node, because `plan/src/Node.ts` has none and never will
 */

export type NodeKind = "trigger" | "action" | "agent" | "jev" | "human" | "branch" | "merge"

export type Tier = "sealed" | "compensable" | "irreversible"

/** `PlanScheduler.Settlement.outcome` plus the UI-only states around it. */
export type NodeState =
  | "hidden"
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "retrying"
  | "built"
  | "clean"
  | "failed"
  | "skipped"
  | "dirty"
  /** Trigger-only. A trigger is a Dispatcher registration, never a plan node. */
  | "armed"
  | "fired"

/** `Graph.EdgeReason`, plus the UI-only `fires` edge from a trigger into the plan. */
export type EdgeReason = "value" | "continuation" | "failure" | "fires"

export interface PortField {
  readonly name: string
  readonly type: string
  /** A `Planned` reference to an upstream node's result, as `Action.PlannedPayload` allows. */
  readonly from?: string
  readonly literal?: string
}

export interface FlowNodeSpec {
  readonly id: string
  readonly kind: NodeKind
  readonly title: string
  /** The `Action.make` tag or `AgentAction` tag. */
  readonly tag: string
  readonly tier: Tier
  readonly summary: string
  readonly seat?: string
  readonly model?: string
  /** Rendered in the inspector as the typed payload. */
  readonly payload: readonly PortField[]
  readonly success: string
  readonly error?: string
  readonly effects?: string
  /** `flows_plan_nodes.key_digest`, truncated the way the CLI prints it. */
  readonly key: string
  readonly rekey?: string
  /** Wall-clock for the first full run. */
  readonly ms: number
  /** Wall-clock when re-run after a re-key. */
  readonly rekeyMs?: number
  readonly tokens?: number
  readonly cost?: number
  readonly notes?: readonly string[]
}

export interface FlowEdgeSpec {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
  readonly label?: string
}

export const REPO = "tevm/tevm-monorepo"

/** How patterns.smithers.sh classifies a flow. */
export type FlowClass = "Primitive" | "Composite" | "Use case"

export interface FlowSpec {
  readonly id: string
  readonly title: string
  readonly klass: FlowClass
  readonly summary: string
  /** The `@smthrs/patterns` export this shape comes from, when it comes from one. */
  readonly pattern?: string
  readonly nodes: readonly FlowNodeSpec[]
  readonly edges: readonly FlowEdgeSpec[]
}

export const FLOW_ID = "morning-triage"

const MORNING_TRIAGE_NODES: readonly FlowNodeSpec[] = [
  {
    id: "trigger",
    kind: "trigger",
    title: "cron 0 8 * * 1-5",
    tag: "dispatcher/cron",
    tier: "sealed",
    summary: "Mon–Fri · America/New_York",
    payload: [
      { name: "schedule", type: "Cron", literal: '"0 8 * * 1-5"' },
      { name: "timezone", type: "TimeZone", literal: '"America/New_York"' }
    ],
    success: "TriggerFired",
    key: "key1_04b2f8ac",
    ms: 200,
    notes: ["Registered in the Dispatcher, not in this flow's body."]
  },
  {
    id: "issues",
    kind: "action",
    title: "github/list-issues",
    tag: "github/list-issues",
    tier: "sealed",
    summary: "opened since the last run",
    payload: [
      { name: "repo", type: "NonEmptyString", from: "payload.repo" },
      { name: "since", type: "DateTimeUtc", from: "payload.since" }
    ],
    success: "ReadonlyArray<Issue>",
    error: "GithubError",
    effects: "reads net:api.github.com · sealed, cacheable",
    key: "key1_7c19de40",
    ms: 1_400,
    notes: ["Sealed with an idempotency key, so a second run in the same window is a cache hit."]
  },
  {
    id: "triage",
    kind: "jev",
    title: "triage/relevance",
    tag: "triage/relevance",
    tier: "sealed",
    model: "typesafe-ai/jev",
    summary: "3 typed questions · batch of 9",
    payload: [
      { name: "issues", type: "ReadonlyArray<Issue>", from: "issues" },
      { name: "rules", type: "ReadonlyArray<Rule>", from: "payload.rules" }
    ],
    success: "Triaged",
    error: "ClassifierError",
    effects: "one POST to the evaluation model · 1.5s deadline · no retries",
    key: "key1_a5f0c731",
    ms: 900,
    notes: [
      "Jev answers a fixed question set, so it can never name an option the question did not offer.",
      "Below the confidence floor the answer stays `unknown` — uncertainty is Jev's own verdict, not a fallback."
    ]
  },
  {
    id: "branch",
    kind: "branch",
    title: "Node.branch",
    tag: "Node.branch",
    tier: "sealed",
    summary: "both arms are in the plan",
    payload: [{ name: "subject", type: "Triaged", from: "triage" }],
    success: "Posted | Labelled",
    key: "key1_b8347e12",
    ms: 0,
    notes: ["`Graph.build` expands both arms. The arm not taken settles `skipped`, it is never absent."]
  },
  {
    id: "defer",
    kind: "action",
    title: "github/label",
    tag: "github/label",
    tier: "compensable",
    summary: "the arm not taken",
    payload: [
      { name: "issue", type: "Issue", from: "triage.issue" },
      { name: "label", type: "NonEmptyString", literal: '"needs-repro"' }
    ],
    success: "Labelled",
    error: "GithubError",
    key: "key1_c04a9b6d",
    ms: 700
  },
  {
    id: "repro",
    kind: "agent",
    title: "coding/reproduce",
    tag: "coding/reproduce",
    tier: "compensable",
    seat: "coding/implement",
    model: "claude-opus-5",
    summary: "in the branch workspace VM",
    payload: [
      { name: "issue", type: "Issue", from: "triage.issue" },
      { name: "parent", type: "Revision", from: "payload.head" }
    ],
    success: "Reproduction",
    error: "AgentFailure | CodingError",
    effects: "reads ** · writes ** · fs boundary captured per atom",
    key: "key1_2d6e8f05",
    ms: 14 * 60_000 + 20_000,
    tokens: 184_300,
    cost: 2.41,
    notes: ["Its output feeds the test command below, so that command cannot start before this settles."]
  },
  {
    id: "test",
    kind: "action",
    title: "proc/spawn",
    tag: "proc/spawn",
    tier: "compensable",
    summary: "--filter @tevm/state",
    payload: [
      { name: "command", type: "NonEmptyString", literal: '"bun test --filter @tevm/state"' },
      { name: "cwd", type: "Path", from: "repro.workspace" }
    ],
    success: "CommandResult",
    error: "SpawnError",
    effects: "proc:spawn:* · retry 200ms × 1.5, max 30s",
    key: "key1_ff21a80c",
    ms: 2 * 60_000 + 5_000,
    notes: ["Attempt 1 hit a cold Bun cache. The retry policy is per step key and survives process death."]
  },
  {
    id: "bundle",
    kind: "action",
    title: "coding/diagnose",
    tag: "coding/diagnose",
    tier: "sealed",
    summary: "reached only by a failure edge",
    payload: [{ name: "cause", type: "SpawnError", from: "test.failure" }],
    success: "DiagnosisBundle",
    key: "key1_3ab77c91",
    ms: 900,
    notes: ["A `Node.catch` handler. Drawn because it is in the plan, never run because the retry recovered."]
  },
  {
    id: "approve",
    kind: "human",
    title: "system/human-task",
    tag: "system/human-task",
    tier: "sealed",
    summary: "kind: confirm · attempt 1 of 10",
    payload: [
      { name: "kind", type: '"confirm"', literal: '"confirm"' },
      { name: "prompt", type: "String", literal: '"Land a failing test on a new change?"' },
      { name: "maxAttempts", type: "Int", literal: "10" }
    ],
    success: "Json",
    error: "HumanTaskFailed",
    effects: "parks the run · each attempt is its own durable wait point",
    key: "key1_61c9d2e8",
    ms: 3 * 60_000 + 40_000,
    notes: [
      "The question is published to `flows_runs.waiting_request`; this card is rendered from that JSON.",
      "The timeout clock is per task, not per attempt."
    ]
  },
  {
    id: "change",
    kind: "action",
    title: "jj/create-change",
    tag: "jj/create-change",
    tier: "irreversible",
    summary: "one atom on a fresh change",
    payload: [
      { name: "parent", type: "Revision", from: "payload.head" },
      { name: "message", type: "NonEmptyString", literal: '"test: reproduce the top triaged issue"' }
    ],
    success: "Revision",
    error: "NativeCodingError",
    effects: "writes the working copy · irreversible, approval-gated",
    key: "key1_9e40b5a7",
    ms: 800
  },
  {
    id: "writetest",
    kind: "agent",
    title: "coding/edit-atom",
    tag: "coding/edit-atom",
    tier: "compensable",
    seat: "coding/implement",
    model: "claude-opus-5",
    summary: "one atomic change",
    payload: [
      { name: "reproduction", type: "Reproduction", from: "repro" },
      { name: "parent", type: "Revision", from: "change" }
    ],
    success: "EditReport",
    error: "AgentFailure",
    effects: "reads ** · writes packages/state/**",
    key: "key1_5c8b1f22",
    ms: 41 * 60_000 + 12_000,
    tokens: 612_400,
    cost: 8.06,
    notes: ["The expensive one. After the edit to AI checks it is a cache hit, because nothing it consumes changed."]
  },
  {
    id: "checks",
    kind: "jev",
    title: "repository/jev-semantic-check",
    tag: "repository/jev-semantic-check",
    tier: "sealed",
    model: "typesafe-ai/jev",
    summary: "one boolean per rule × hunk",
    payload: [
      { name: "rules", type: "ReadonlyArray<Rule>", from: "payload.rules" },
      { name: "comparison", type: "Comparison", from: "writetest.diff" }
    ],
    success: "CheckedChange",
    error: "CodingError",
    effects: "flag ≥ 0.8 · clean ≤ 0.2 · between is `uncertain`, kept as Jev's verdict",
    key: "key1_8f77ac30",
    rekey: "key1_d12e64b9",
    ms: 1_200,
    rekeyMs: 1_600,
    notes: ["One boolean per (rule, hunk). Adding a rule changes what this node consumes, so it re-keys."]
  },
  {
    id: "pr",
    kind: "action",
    title: "github/open-pr",
    tag: "github/open-pr",
    tier: "irreversible",
    summary: "draft, reviewers from CODEOWNERS",
    payload: [
      { name: "checked", type: "CheckedChange", from: "checks" }
    ],
    success: "PullRequest",
    error: "GithubError",
    effects: "writes net:api.github.com · irreversible",
    key: "key1_1b53e097",
    rekey: "key1_47ca0e6f",
    ms: 2_400,
    rekeyMs: 2_600
  },
  {
    id: "notify",
    kind: "action",
    title: "slack/post",
    tag: "slack/post",
    tier: "irreversible",
    summary: "one message, threaded",
    payload: [{ name: "pr", type: "PullRequest", from: "pr" }],
    success: "Posted",
    error: "SlackError",
    effects: "writes net:slack.com · irreversible",
    key: "key1_ae90d364",
    rekey: "key1_72f1b8dd",
    ms: 600,
    rekeyMs: 700
  }
]

const MORNING_TRIAGE_EDGES: readonly FlowEdgeSpec[] = [
  { id: "e1", from: "trigger", to: "issues", reason: "fires" },
  { id: "e2", from: "issues", to: "triage", reason: "value" },
  { id: "e3", from: "triage", to: "branch", reason: "value" },
  { id: "e4", from: "branch", to: "repro", reason: "value", label: "then" },
  { id: "e5", from: "branch", to: "defer", reason: "value", label: "else" },
  { id: "e6", from: "repro", to: "test", reason: "value" },
  { id: "e7", from: "test", to: "bundle", reason: "failure", label: "catch" },
  { id: "e8", from: "test", to: "approve", reason: "continuation" },
  { id: "e9", from: "approve", to: "change", reason: "continuation" },
  { id: "e10", from: "change", to: "writetest", reason: "value" },
  { id: "e11", from: "writetest", to: "checks", reason: "value" },
  { id: "e12", from: "checks", to: "pr", reason: "value" },
  { id: "e13", from: "pr", to: "notify", reason: "value" },
  { id: "e14", from: "repro", to: "writetest", reason: "value", label: "reproduction" }
]

export const MORNING_TRIAGE: FlowSpec = {
  id: FLOW_ID,
  title: "morning-triage",
  klass: "Use case",
  summary: "Triage, reproduce, test, review",
  nodes: MORNING_TRIAGE_NODES,
  edges: MORNING_TRIAGE_EDGES
}

/** The flow the scripted demo animates. */
export const NODES = MORNING_TRIAGE_NODES
export const EDGES = MORNING_TRIAGE_EDGES

export const indexNodes = (spec: FlowSpec): Readonly<Record<string, FlowNodeSpec>> =>
  Object.fromEntries(spec.nodes.map((node) => [node.id, node]))

export const NODE_BY_ID: Readonly<Record<string, FlowNodeSpec>> = indexNodes(MORNING_TRIAGE)

/** The set an edit to `checks` re-keys: itself and everything downstream of it. */
export const REKEYED: readonly string[] = ["checks", "pr", "notify"]

/** Everything the same edit leaves alone. */
export const CACHED: readonly string[] = NODES.filter(
  (node) =>
    node.kind !== "trigger" && !REKEYED.includes(node.id) && node.id !== "bundle" && node.id !== "defer"
).map((node) => node.id)

/** Plan nodes only: the trigger is a Dispatcher registration. */
export const PLAN_NODE_COUNT = NODES.filter((node) => node.kind !== "trigger").length

export const formatDuration = (ms: number): string => {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const FIRST_RUN_MS = NODES.filter(
  (node) => node.kind !== "trigger" && node.id !== "bundle" && node.id !== "defer"
).reduce((total, node) => total + node.ms, 0)

export const REKEY_RUN_MS = REKEYED.reduce(
  (total, id) => total + (NODE_BY_ID[id].rekeyMs ?? NODE_BY_ID[id].ms),
  0
)
