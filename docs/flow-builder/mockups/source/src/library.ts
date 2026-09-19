/**
 * Four flows from `@smthrs/patterns`, drawn as the graphs their `make()` declares.
 *
 * Each pattern exposes two surfaces: `make(options)` returns a Flow whose body is
 * the fully unrolled, conservative topology, and `run` narrows it. So the canvas
 * can draw the worst case before anything runs. Shapes and node counts follow the
 * package's own tests; the flow labels are what `Compose.label` mints.
 */
import { MORNING_TRIAGE, type EdgeReason, type FlowEdgeSpec, type FlowNodeSpec, type FlowSpec, type NodeKind, type NodeState, type Tier } from "./flow.ts"

let keySeed = 0x3a71c9
const nextKey = (): string => {
  keySeed = (keySeed * 1103515245 + 12345) & 0x7fffffff
  return `key1_${keySeed.toString(16).padStart(8, "0").slice(0, 8)}`
}

interface NodeOptions {
  readonly title?: string
  readonly summary?: string
  readonly seat?: string
  readonly model?: string
  readonly ms?: number
  readonly tokens?: number
  readonly cost?: number
  readonly success?: string
  readonly notes?: readonly string[]
}

const node = (id: string, kind: NodeKind, tag: string, tier: Tier, options: NodeOptions = {}): FlowNodeSpec => ({
  id,
  kind,
  title: options.title ?? id,
  tag,
  tier,
  summary: options.summary ?? "",
  seat: options.seat,
  model: options.model,
  payload: [],
  success: options.success ?? "Json",
  key: nextKey(),
  ms: options.ms ?? 0,
  tokens: options.tokens,
  cost: options.cost,
  notes: options.notes
})

const edges = (pairs: readonly (readonly [string, string, EdgeReason, string?])[]): FlowEdgeSpec[] =>
  pairs.map(([from, to, reason, label], index) => ({ id: `x${index}`, from, to, reason, label }))

export interface LibraryFlow extends FlowSpec {
  /** How the last run settled, so a flow opened from the library shows a real run. */
  readonly settled: Readonly<Record<string, NodeState>>
  readonly verdict: string
}

/* ── CheckSuite · a wide fan-out in two batches ─────────────────────────── */

const PR_GATE: LibraryFlow = {
  id: "pr-gate",
  title: "checkSuite(checks=lint,typecheck,test,build,audit,licenses, strategy=all-pass, concurrency=3)",
  klass: "Composite",
  pattern: "CheckSuite",
  summary: "PR gate · smithersai/smithers#1347",
  nodes: [
    node("resolve-head", "action", "repo/ResolveHead", "sealed", { ms: 400 }),
    node("add-workspace", "action", "jj/WorkspaceAdd", "compensable", { ms: 1_900 }),
    node("check.lint", "action", "ci/RunLint", "sealed", { ms: 21_000 }),
    node("check.typecheck", "action", "ci/RunTypecheck", "sealed", { ms: 94_000 }),
    node("check.test", "action", "ci/RunVitest", "sealed", { ms: 212_000 }),
    node("batch-0", "merge", "Node.all", "sealed", { summary: "3 of 6, concurrency 3" }),
    node("check.build", "action", "ci/RunBuild", "sealed", { ms: 61_000 }),
    node("check.audit", "action", "ci/RunAudit", "sealed", { ms: 8_200, notes: ["Failed. Its Catch arm settles it Quarantined, and the join does not interrupt its siblings."] }),
    node("check.licenses", "action", "ci/RunLicenseScan", "sealed", { ms: 5_400 }),
    node("batch-1", "merge", "Node.all", "sealed", { summary: "sequenced after batch-0" }),
    node("rows", "merge", "Node.map", "sealed", { summary: "batch-0 ∪ batch-1" }),
    node("verdict", "merge", "Node.map", "sealed", { summary: "all-pass", success: "Verdict" }),
    node("explain", "agent", "agent/ExplainFailures", "sealed", { seat: "review/explain", ms: 48_000, tokens: 21_400, cost: 0.19, notes: ["Settles `skipped` on a green run: nothing to explain."] }),
    node("post-check-run", "action", "github/PostCheckRun", "irreversible", { ms: 700 }),
    node("forget-workspace", "action", "jj/WorkspaceForget", "compensable", { ms: 600 })
  ],
  edges: edges([
    ["resolve-head", "add-workspace", "value"],
    ["add-workspace", "check.lint", "value"],
    ["add-workspace", "check.typecheck", "value"],
    ["add-workspace", "check.test", "value"],
    ["check.lint", "batch-0", "value"],
    ["check.typecheck", "batch-0", "value"],
    ["check.test", "batch-0", "value"],
    ["batch-0", "check.build", "continuation"],
    ["batch-0", "check.audit", "continuation"],
    ["batch-0", "check.licenses", "continuation"],
    ["check.build", "batch-1", "value"],
    ["check.audit", "batch-1", "failure", "catch"],
    ["check.licenses", "batch-1", "value"],
    ["batch-0", "rows", "value"],
    ["batch-1", "rows", "value"],
    ["rows", "verdict", "value"],
    ["verdict", "explain", "value"],
    ["verdict", "post-check-run", "value"],
    ["explain", "post-check-run", "value"],
    ["post-check-run", "forget-workspace", "continuation"]
  ]),
  settled: {
    "resolve-head": "clean", "add-workspace": "built", "check.lint": "clean", "check.typecheck": "clean",
    "check.test": "built", "batch-0": "built", "check.build": "built", "check.audit": "failed",
    "check.licenses": "clean", "batch-1": "built", rows: "built", verdict: "built", explain: "built",
    "post-check-run": "built", "forget-workspace": "built"
  },
  verdict: "5 passed · audit failed"
}

/* ── ReviewLoop · a bounded loop, unrolled ──────────────────────────────── */

const REVIEW_LOOP: LibraryFlow = {
  id: "review-loop",
  title: "reviewLoop(maxRounds=3)",
  klass: "Composite",
  pattern: "ReviewLoop",
  summary: "Implement #1347 until review approves",
  nodes: [
    node("read-issue", "action", "github/ReadIssue", "sealed", { ms: 900 }),
    node("plan", "agent", "agent/PlanChange", "sealed", { seat: "coding/plan", ms: 96_000, tokens: 44_000, cost: 0.61 }),
    node("implement@1", "agent", "agent/ImplementChange", "compensable", { seat: "coding/implement", ms: 1_140_000, tokens: 402_000, cost: 5.2 }),
    node("review@1", "agent", "agent/ReviewDiff", "sealed", { seat: "review/diff", ms: 171_000, tokens: 88_000, cost: 0.92 }),
    node("approved@1", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Approved\" }" }),
    node("revise@1", "agent", "agent/ImplementChange", "compensable", { seat: "coding/implement", ms: 610_000, tokens: 238_000, cost: 3.1, notes: ["Consumes BOTH the draft and the review, so it has two value edges in."] }),
    node("review@2", "agent", "agent/ReviewDiff", "sealed", { seat: "review/diff", ms: 149_000, tokens: 80_000, cost: 0.84 }),
    node("approved@2", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Approved\" }" }),
    node("revise@2", "agent", "agent/ImplementChange", "compensable", { seat: "coding/implement" }),
    node("review@3", "agent", "agent/ReviewDiff", "sealed", { seat: "review/diff" }),
    node("approved@3", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Approved\" }" }),
    node("exhausted", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Exhausted\" }", notes: ["There is no loop node. Three rounds are three sets of real nodes, and this is the exit when all are spent."] }),
    node("run-tests", "action", "ci/RunVitest", "sealed", { ms: 204_000 }),
    node("commit", "action", "jj/Commit", "compensable", { ms: 500 }),
    node("push-main", "action", "jj/GitPush", "irreversible", { ms: 2_300 })
  ],
  edges: edges([
    ["read-issue", "plan", "value"],
    ["plan", "implement@1", "value"],
    ["implement@1", "review@1", "value"],
    ["review@1", "approved@1", "value", "then"],
    ["review@1", "revise@1", "value", "else"],
    ["implement@1", "revise@1", "value"],
    ["revise@1", "review@2", "value"],
    ["review@2", "approved@2", "value", "then"],
    ["review@2", "revise@2", "value", "else"],
    ["revise@1", "revise@2", "value"],
    ["revise@2", "review@3", "value"],
    ["review@3", "approved@3", "value", "then"],
    ["review@3", "exhausted", "value", "else"],
    ["approved@1", "run-tests", "continuation"],
    ["approved@2", "run-tests", "continuation"],
    ["approved@3", "run-tests", "continuation"],
    ["run-tests", "commit", "value"],
    ["commit", "push-main", "continuation"]
  ]),
  settled: {
    "read-issue": "clean", plan: "clean", "implement@1": "built", "review@1": "built", "approved@1": "skipped",
    "revise@1": "built", "review@2": "built", "approved@2": "built", "revise@2": "skipped", "review@3": "skipped",
    "approved@3": "skipped", exhausted: "skipped", "run-tests": "built", commit: "built", "push-main": "built"
  },
  verdict: "approved in round 2"
}

/* ── Saga · compensations declared, in reverse, before anything runs ────── */

const RELEASE_SAGA: LibraryFlow = {
  id: "release-saga",
  title: "saga(steps=reserve-version,publish-npm,push-tag,deploy-docs, onFailure=compensate)",
  klass: "Composite",
  pattern: "Saga",
  summary: "Release @smthrs/patterns 1.0.0-rc.116",
  nodes: [
    node("preflight", "action", "release/Preflight", "sealed", { ms: 38_000 }),
    node("reserve-version", "action", "release/ReserveVersion", "compensable", { ms: 900 }),
    node("publish-npm", "action", "npm/Publish", "irreversible", { ms: 14_000, notes: ["Irreversible, and so is its compensation. The one step a rollback cannot take back."] }),
    node("push-tag", "action", "git/PushTag", "compensable", { ms: 1_800 }),
    node("deploy-docs", "action", "cloudflare/DeployWorker", "compensable", { ms: 42_000, notes: ["Failed: asset upload returned `fetch failed`. The unwind starts here."] }),
    node("completed", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Completed\" }" }),
    node("undo.deploy-docs", "action", "cloudflare/RollbackWorker", "compensable", { ms: 9_000 }),
    node("undo.push-tag", "action", "git/DeleteTag", "compensable", { ms: 1_200 }),
    node("undo.publish-npm", "action", "npm/Deprecate", "irreversible", { ms: 2_600 }),
    node("undo.reserve-version", "action", "release/ReleaseSlot", "compensable", { ms: 700 }),
    node("residue", "merge", "Node.map", "sealed", { summary: "PatternError compensation_failed" }),
    node("compensated", "merge", "Node.succeed", "sealed", { summary: "{ _tag: \"Compensated\" }" }),
    node("write-note", "agent", "agent/WriteReleaseNote", "sealed", { seat: "docs/write" }),
    node("announce", "action", "slack/PostMessage", "irreversible")
  ],
  edges: edges([
    ["preflight", "reserve-version", "value"],
    ["reserve-version", "publish-npm", "value"],
    ["publish-npm", "push-tag", "value"],
    ["push-tag", "deploy-docs", "value"],
    ["deploy-docs", "completed", "value"],
    ["deploy-docs", "undo.deploy-docs", "failure", "catch"],
    ["undo.deploy-docs", "undo.push-tag", "continuation"],
    ["undo.push-tag", "undo.publish-npm", "continuation"],
    ["undo.publish-npm", "undo.reserve-version", "continuation"],
    ["undo.reserve-version", "compensated", "continuation"],
    ["undo.reserve-version", "residue", "failure", "catch"],
    ["completed", "write-note", "value"],
    ["write-note", "announce", "value"]
  ]),
  settled: {
    preflight: "built", "reserve-version": "built", "publish-npm": "built", "push-tag": "built",
    "deploy-docs": "failed", completed: "skipped", "undo.deploy-docs": "built", "undo.push-tag": "built",
    "undo.publish-npm": "built", "undo.reserve-version": "built", residue: "skipped", compensated: "built",
    "write-note": "skipped", announce: "skipped"
  },
  verdict: "compensated · 4 undone"
}

/* ── Escalation · the decider is a node, not a diamond ──────────────────── */

const ESCALATION: LibraryFlow = {
  id: "escalation",
  title: "escalation(rungs=3, fallback=true)",
  klass: "Composite",
  pattern: "Escalation",
  summary: "Repair the red test, cheapest seat first",
  nodes: [
    node("reproduce", "action", "ci/RunVitest", "sealed", { ms: 31_000 }),
    node("minimise", "agent", "agent/MinimiseRepro", "sealed", { seat: "coding/minimise", ms: 84_000, tokens: 36_000, cost: 0.31 }),
    node("repair@0", "agent", "agent/RepairTest", "compensable", { seat: "coding/repair-fast", ms: 72_000, tokens: 58_000, cost: 0.12, notes: ["Rungs are alternative strategies, not model-seat fallback. Seat fallback belongs to model routing."] }),
    node("accept@0", "action", "ci/RunVitest", "sealed", { ms: 29_000, notes: ["`accept` is a flow that is CALLED per rung, which is why it is a node."] }),
    node("reached@0", "merge", "Node.succeed", "sealed", { summary: "{ level: 0 }" }),
    node("repair@1", "agent", "agent/RepairTest", "compensable", { seat: "coding/repair", ms: 268_000, tokens: 141_000, cost: 1.74 }),
    node("accept@1", "action", "ci/RunVitest", "sealed", { ms: 30_000 }),
    node("reached@1", "merge", "Node.succeed", "sealed", { summary: "{ level: 1 }" }),
    node("repair@2", "agent", "agent/RepairTest", "compensable", { seat: "coding/repair-deep" }),
    node("accept@2", "action", "ci/RunVitest", "sealed"),
    node("reached@2", "merge", "Node.succeed", "sealed", { summary: "{ level: 2 }" }),
    node("ask-owner", "human", "system/human-task", "sealed", { summary: "kind: confirm · 3 attempts" }),
    node("reached@fallback", "merge", "Node.succeed", "sealed", { summary: "{ level: 3 }" }),
    node("commit", "action", "jj/Commit", "compensable", { ms: 500 }),
    node("push-main", "action", "jj/GitPush", "irreversible", { ms: 2_100 })
  ],
  edges: edges([
    ["reproduce", "minimise", "value"],
    ["minimise", "repair@0", "value"],
    ["repair@0", "accept@0", "value"],
    ["accept@0", "reached@0", "value", "then"],
    ["accept@0", "repair@1", "value", "else"],
    ["minimise", "repair@1", "value"],
    ["repair@1", "accept@1", "value"],
    ["accept@1", "reached@1", "value", "then"],
    ["accept@1", "repair@2", "value", "else"],
    ["minimise", "repair@2", "value"],
    ["repair@2", "accept@2", "value"],
    ["accept@2", "reached@2", "value", "then"],
    ["accept@2", "ask-owner", "value", "else"],
    ["ask-owner", "reached@fallback", "value"],
    ["reached@0", "commit", "continuation"],
    ["reached@1", "commit", "continuation"],
    ["reached@2", "commit", "continuation"],
    ["reached@fallback", "commit", "continuation"],
    ["commit", "push-main", "continuation"]
  ]),
  settled: {
    reproduce: "clean", minimise: "clean", "repair@0": "built", "accept@0": "built", "reached@0": "skipped",
    "repair@1": "built", "accept@1": "built", "reached@1": "built", "repair@2": "skipped", "accept@2": "skipped",
    "reached@2": "skipped", "ask-owner": "skipped", "reached@fallback": "skipped", commit: "built", "push-main": "built"
  },
  verdict: "repaired at rung 1"
}

export const LIBRARY: readonly LibraryFlow[] = [PR_GATE, REVIEW_LOOP, RELEASE_SAGA, ESCALATION]

export const ALL_FLOWS: readonly FlowSpec[] = [MORNING_TRIAGE, ...LIBRARY]
