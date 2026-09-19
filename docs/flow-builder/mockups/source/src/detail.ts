/**
 * What the drill-in drawer renders for a node of `morning-triage`.
 *
 * Every field name here is one the engine really has:
 *  - predictions: `flows_attempts.started_at_ms / finished_at_ms`, grouped by action tag
 *  - attempts: `flows_attempts` rows keyed (run_id, step_key_digest, attempt)
 *  - events: `flows.engine.*` / `flows.harness.*` / `flows.agent.*` journal records
 *  - model call: `@smthrs/model` route id, protocol id, the 13 `ModelEvent` tags, `ModelError` codes
 *  - Jev: `Evaluator` request/response, `Classifier` questions, per-question probability
 *  - a seat is a declared string; only a host resolver turns it into a model
 */

export interface Prediction {
  readonly p50: number
  readonly p90: number
  readonly samples: number
}

/** Keyed by action tag, because a tag is stable across re-keys and a step key is not. */
export const PREDICTIONS: Readonly<Record<string, Prediction>> = {
  "github/list-issues": { p50: 1_300, p90: 2_100, samples: 212 },
  "triage/relevance": { p50: 880, p90: 1_340, samples: 212 },
  "coding/reproduce": { p50: 13 * 60_000, p90: 27 * 60_000, samples: 41 },
  "proc/spawn": { p50: 118_000, p90: 171_000, samples: 388 },
  "system/human-task": { p50: 4 * 60_000, p90: 38 * 60_000, samples: 37 },
  "jj/create-change": { p50: 780, p90: 1_400, samples: 96 },
  "coding/edit-atom": { p50: 38 * 60_000, p90: 61 * 60_000, samples: 58 },
  "repository/jev-semantic-check": { p50: 1_250, p90: 1_480, samples: 164 },
  "github/open-pr": { p50: 2_300, p90: 4_100, samples: 71 },
  "slack/post": { p50: 600, p90: 1_100, samples: 71 },
  "github/label": { p50: 650, p90: 1_000, samples: 140 },
  "coding/diagnose": { p50: 900, p90: 1_500, samples: 9 }
}

/** The critical path of the first run, by p50: every executed node is on it, this flow is a chain. */
export const RUN_ETA_MS = [
  "github/list-issues", "triage/relevance", "coding/reproduce", "proc/spawn", "system/human-task",
  "jj/create-change", "coding/edit-atom", "repository/jev-semantic-check", "github/open-pr", "slack/post"
].reduce((total, tag) => total + PREDICTIONS[tag].p50, 0)

export interface ResolvedSeat {
  readonly seat: string
  readonly modelId: string
  readonly routeId: string
  readonly protocolId: string
  readonly endpoint: string
  readonly credentialHeader: string
  readonly contextWindowTokens: number
}

export const SEATS: Readonly<Record<string, ResolvedSeat>> = {
  "coding/implement": {
    seat: "coding/implement",
    modelId: "claude-opus-5",
    routeId: "anthropic",
    protocolId: "anthropic-messages",
    endpoint: "POST https://api.anthropic.com/v1/messages",
    credentialHeader: "x-api-key",
    contextWindowTokens: 1_000_000
  }
}

export const JEV_ROUTE = {
  modelId: "typesafe-ai/jev",
  endpoint: "POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
  credentialHeader: "Authorization",
  headers: ["ai-gateway-protocol-version: 0.0.1", "ai-evaluation-model-spec-version: 4"],
  deadlineMs: 1_500
} as const

export interface ModelEventRow {
  readonly at: number
  readonly type:
    | "text-start" | "text-delta" | "text-end"
    | "thinking-start" | "thinking-delta" | "thinking-end"
    | "tool-call-start" | "tool-call-delta" | "tool-call-end" | "tool-result"
    | "usage" | "retry" | "settle"
  readonly note: string
}

export interface Frame {
  readonly frame: number
  readonly ms: number
  readonly cell: string
  readonly calls: readonly { readonly flow: string; readonly outcome: "ok" | "failed"; readonly ms: number; readonly note?: string }[]
  readonly printed?: string
  readonly transition: string
  readonly events: readonly ModelEventRow[]
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly thinking: number }
}

export interface AgentDetail {
  readonly seat: ResolvedSeat
  readonly system: readonly { readonly section: string; readonly digest: string; readonly text: string }[]
  readonly ceilings: readonly { readonly name: string; readonly value: string }[]
  readonly frames: readonly Frame[]
  readonly framesTotal: number
  readonly verdict: string
}

const REPRO_FRAMES: readonly Frame[] = [
  {
    frame: 1,
    ms: 21_400,
    cell: `const hits = await ctx.call("search", { pattern: "storageOverrides", path: "packages/state/src" })
const file = await ctx.call("read", { path: "packages/state/src/StateManager.ts", start: 180, end: 260 })
console.log(hits.matches.length, file.text.split("\\n").length)`,
    calls: [
      { flow: "search", outcome: "ok", ms: 310 },
      { flow: "read", outcome: "ok", ms: 42 }
    ],
    printed: "7 81",
    transition: "continue",
    events: [
      { at: 0, type: "thinking-start", note: "signature present" },
      { at: 2_900, type: "thinking-end", note: "" },
      { at: 3_000, type: "text-start", note: "cell · javascript" },
      { at: 6_800, type: "text-end", note: "412 chars" },
      { at: 6_820, type: "usage", note: "in 18 204 · out 388 · cache read 16 900" },
      { at: 6_830, type: "settle", note: "stopReason end_turn" }
    ],
    usage: { input: 18_204, output: 388, cacheRead: 16_900, thinking: 1_140 }
  },
  {
    frame: 2,
    ms: 64_000,
    cell: `await ctx.call("write", {
  path: "packages/state/src/StateManager.repro.spec.ts",
  text: reproSpec
})
const before = await ctx.call("bash", { command: "bun test packages/state/src/StateManager.repro.spec.ts" })
console.log(before.exitCode, before.stdout.slice(-400))`,
    calls: [
      { flow: "write", outcome: "ok", ms: 28 },
      { flow: "bash", outcome: "failed", ms: 48_200, note: "exit 1 · the reproduction fails as the issue says" }
    ],
    printed: "1  expect(clone.getStorage(addr, slot)).toEqual(override) // received 0x00",
    transition: "continue",
    events: [
      { at: 0, type: "text-start", note: "cell · javascript" },
      { at: 9_100, type: "text-end", note: "1 204 chars" },
      { at: 9_140, type: "usage", note: "in 21 870 · out 1 012 · cache read 18 204" },
      { at: 9_150, type: "settle", note: "stopReason end_turn" }
    ],
    usage: { input: 21_870, output: 1_012, cacheRead: 18_204, thinking: 0 }
  },
  {
    frame: 14,
    ms: 38_000,
    cell: `ctx.done({
  summary: "clone() builds its storage trie from the committed root and drops uncommitted overrides",
  workspace: ctx.base,
  message: "test: storage overrides survive StateManager.clone()",
  reads: ["packages/state/src/StateManager.ts"],
  writes: ["packages/state/src/StateManager.repro.spec.ts"]
})`,
    calls: [],
    transition: "done · answer judged by completion-claim (Jev) · 0.91 proven",
    events: [
      { at: 0, type: "text-start", note: "cell · javascript" },
      { at: 5_200, type: "text-end", note: "486 chars" },
      { at: 5_230, type: "usage", note: "in 96 410 · out 402 · cache read 91 300" },
      { at: 5_240, type: "settle", note: "stopReason end_turn" }
    ],
    usage: { input: 96_410, output: 402, cacheRead: 91_300, thinking: 0 }
  }
]

export const AGENTS: Readonly<Record<string, AgentDetail>> = {
  repro: {
    seat: SEATS["coding/implement"],
    system: [
      { section: "contract", digest: "sha256:4be1…09af", text: "You write JavaScript cells. Your only authority is ctx.call(flow, input). Finish with ctx.done(output)." },
      { section: "flows", digest: "sha256:91c4…d2e0", text: "search · read · write · bash · jj.read — each with its input schema." },
      { section: "task", digest: "sha256:0fa2…77b1", text: "Reproduce the reported defect in the owning workspace. The flow owns JJ operations: never commit, never switch workspaces. Report the files you read and wrote." }
    ],
    ceilings: [
      { name: "maxFrames", value: "100" },
      { name: "readOnlyCap", value: "12" },
      { name: "modelCallMs", value: "300 000" },
      { name: "repeatCap", value: "4" },
      { name: "calls", value: "64 per cell" }
    ],
    frames: REPRO_FRAMES,
    framesTotal: 14,
    verdict: "Reproduction"
  }
}

export interface JevDetail {
  readonly classifier: string
  readonly digest: string
  readonly latencyMs: number
  readonly state: string
  readonly questions: readonly {
    readonly id: string
    readonly type: "boolean" | "choice" | "score"
    readonly instructions: string
    readonly answer: string
    readonly probabilities: readonly { readonly option: string; readonly p: number }[]
  }[]
  readonly thresholds?: { readonly flag: number; readonly clean: number }
}

export const JEVS: Readonly<Record<string, JevDetail>> = {
  triage: {
    classifier: "triage/relevance",
    digest: "sha256:7d20…a41c",
    latencyMs: 412,
    state: '{ issue: #4412 "State clone drops storage overrides", rules: 6 }',
    questions: [
      { id: "needsChange", type: "boolean", instructions: "Does this need a code change?", answer: "true", probabilities: [{ option: "true", p: 0.97 }, { option: "false", p: 0.03 }] },
      { id: "role", type: "choice", instructions: "What kind of file?", answer: "implementation", probabilities: [{ option: "implementation", p: 0.89 }, { option: "fixture", p: 0.08 }, { option: "unrelated", p: 0.03 }] },
      { id: "risk", type: "score", instructions: "Edit risk", answer: "medium", probabilities: [{ option: "none", p: 0.02 }, { option: "low", p: 0.19 }, { option: "medium", p: 0.71 }, { option: "high", p: 0.08 }] }
    ]
  },
  checks: {
    classifier: "check/rule",
    digest: "sha256:c1f8…3e57",
    latencyMs: 388,
    state: "{ rule, hunk } × 24 — one request per pair, concurrency 1",
    thresholds: { flag: 0.8, clean: 0.2 },
    questions: [
      { id: "no-silent-fallbacks", type: "boolean", instructions: "Does this hunk add a silent fallback?", answer: "clean", probabilities: [{ option: "violates", p: 0.04 }, { option: "clean", p: 0.96 }] },
      { id: "typed-failures", type: "boolean", instructions: "Does this hunk throw an untyped failure?", answer: "clean", probabilities: [{ option: "violates", p: 0.11 }, { option: "clean", p: 0.89 }] },
      { id: "tests-assert-behaviour", type: "boolean", instructions: "Is this test tautological?", answer: "uncertain", probabilities: [{ option: "violates", p: 0.44 }, { option: "clean", p: 0.56 }] }
    ]
  }
}

export interface AttemptRow {
  readonly attempt: number
  readonly state: string
  readonly ms: number
  readonly error?: string
}

export const ATTEMPTS: Readonly<Record<string, readonly AttemptRow[]>> = {
  test: [
    { attempt: 1, state: "failed", ms: 61_000, error: 'SpawnError { code: "exit", exitCode: 1, stderr: "error: could not resolve \\"@tevm/state\\" — cold cache" }' },
    { attempt: 2, state: "succeeded", ms: 64_000 }
  ]
}

export interface JournalRow {
  readonly seq: number
  readonly type: string
  readonly payload: string
}

export const journalFor = (id: string, key: string): readonly JournalRow[] => [
  { seq: 1, type: "flows.engine.node-scheduled", payload: `{ nodeId: "${id}", planKey: "${key}", priority: 0 }` },
  { seq: 2, type: "flows.engine.attempt-started", payload: `{ stepKeyDigest: "${key}", attempt: 1 }` },
  { seq: 3, type: "flows.engine.v2.attempt-lifecycle", payload: '{ lifecycle: { _tag: "succeeded" } }' },
  { seq: 4, type: "flows.engine.attempt-finished", payload: `{ stepKeyDigest: "${key}", attempt: 1, state: "succeeded" }` },
  { seq: 5, type: "flows.engine.node-settled", payload: `{ nodeId: "${id}", outcome: "built", attempts: 1, rebases: 0 }` }
]

export const OUTPUTS: Readonly<Record<string, string>> = {
  issues: `[
  { "number": 4412, "title": "State clone drops storage overrides", "labels": ["bug"] },
  { "number": 4409, "title": "docs: typo in createMemoryClient", "labels": ["docs"] },
  … 7 more
]`,
  triage: `{
  "issue": { "number": 4412, "title": "State clone drops storage overrides" },
  "needsChange": true,
  "role": "implementation",
  "risk": "medium"
}`,
  repro: `{
  "summary": "clone() builds its storage trie from the committed root and drops uncommitted overrides",
  "workspace": "/workspaces/tevm-monorepo@repro-4412",
  "message": "test: storage overrides survive StateManager.clone()",
  "reads": ["packages/state/src/StateManager.ts"],
  "writes": ["packages/state/src/StateManager.repro.spec.ts"]
}`,
  test: `{ "exitCode": 0, "durationMs": 64000, "passed": 412, "failed": 0 }`,
  approve: `true`,
  change: `{ "changeId": "kzvxqmpo", "commitId": "9e40b5a7c1d2", "parentCommitIds": ["44545559b4aa"] }`,
  writetest: `{
  "summary": "one failing test: clone() must carry storage overrides",
  "reads": ["packages/state/src/StateManager.ts", "packages/state/src/StateManager.repro.spec.ts"],
  "writes": ["packages/state/src/StateManager.spec.ts"]
}`,
  checks: `{ "verdict": "pass", "flagged": 0, "uncertain": 1, "clean": 23, "decidedBy": "jev" }`,
  pr: `{ "number": 4431, "url": "https://github.com/tevm/tevm-monorepo/pull/4431", "draft": true }`,
  notify: `{ "channel": "#eng-triage", "ts": "1789721184.220149" }`
}

export const TRIGGER = {
  kind: "cron",
  schedule: "0 8 * * 1-5",
  narrated: "At 08:00, Monday through Friday",
  timezone: "America/New_York",
  dst: "Adjusts for daylight saving time.",
  overlap: "skip",
  catchUp: "latest",
  next: [
    { local: "Mon 21 Sep 08:00", utc: "12:00 UTC" },
    { local: "Tue 22 Sep 08:00", utc: "12:00 UTC" },
    { local: "Wed 23 Sep 08:00", utc: "12:00 UTC" },
    { local: "Thu 24 Sep 08:00", utc: "12:00 UTC" },
    { local: "Fri 25 Sep 08:00", utc: "12:00 UTC" }
  ],
  history: ["completed", "completed", "failed", "completed", "completed", "completed", "cancelled", "completed", "completed", "completed", "completed", "completed", "failed", "completed"] as const
}
