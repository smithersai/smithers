import { expect, test } from "vitest"
import { composeAgentInstructions } from "../src/AgentContext.ts"
import type { AgentRuntimeContext } from "../src/AgentContext.ts"
import {
  ContextCandidateSchema,
  ContextPreflightFrameSchema,
  ContextPreflightInputSchema,
  SelectedContextItemSchema
} from "../src/ContextPreflight.ts"
const context: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 7,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  github: { connected: false, login: null, repositories: null },
  worldState: {
    documentCount: 1,
    documents: [{ path: "private.md", title: "canary-private", confidence: 1, body: "canary-private" }]
  },
  capabilities: [],
  limitations: []
}
test("explicit empty selection excludes every browser-provided document", () => {
  expect(composeAgentInstructions("Answer", context, [])).toBe("Answer\n\nSelected context:\n[]")
})
test("a selected item without a reason is refused", () => {
  expect(SelectedContextItemSchema.safeParse({ kind: "file", label: "old", ref: "old.ts" }).success).toBe(false)
})
test("file and wiki candidates require revisions and preflight excludes issue candidates", () => {
  for (const kind of ["file", "page", "issue"] as const) {
    expect(ContextCandidateSchema.safeParse({ item: { kind, label: "Source", ref: "source" }, text: "data" }).success)
      .toBe(false)
  }
  for (const kind of ["file", "page"] as const) {
    const candidate = { item: { kind, label: "Source", ref: "source", revision: "abc" }, text: "data" }
    expect(ContextCandidateSchema.parse(candidate)).toEqual(candidate)
  }
  const todo = { item: { kind: "todo", label: "Source", ref: "source" }, text: "data" }
  expect(ContextCandidateSchema.parse(todo)).toEqual(todo)
  expect(
    ContextCandidateSchema.safeParse({
      item: { kind: "issue", label: "Source", ref: "source", revision: "abc" },
      text: "data"
    }).success
  ).toBe(false)
})
test("owner budget defaults to 24000 and can exceed it without changing recall's byte contract", () => {
  const base = { prompt: "Retry?", author: "ben", branch: "main", state: "synced", recent: [], candidates: [] }
  expect(ContextPreflightInputSchema.parse(base).tokenBudget).toBe(24000)
  expect(ContextPreflightInputSchema.parse({ ...base, tokenBudget: 32000 }).tokenBudget).toBe(32000)
})

test("preflight host timings survive decoding while historical frames remain readable", () => {
  const frame = {
    runId: "run",
    type: "context.preflight",
    phase: "started",
    result: { model: "fast", durationMs: 0, candidates: [], context: [] }
  }
  expect(ContextPreflightFrameSchema.parse(frame)).toEqual(frame)
  const timed = { ...frame, at: 12.5, clock: "host monotonic:producer-a" }
  expect(ContextPreflightFrameSchema.parse(timed)).toEqual(timed)
  for (
    const timing of [
      { at: 1 },
      { clock: "host monotonic:producer-a" },
      { at: -1, clock: timed.clock },
      { at: Infinity, clock: timed.clock },
      { at: 1, clock: "browser" },
      { at: 1, clock: "host monotonic:" }
    ]
  ) {
    expect(ContextPreflightFrameSchema.safeParse({ ...frame, ...timing }).success).toBe(false)
  }
})

test("paged preflight frames require a phase and valid page coordinates", () => {
  const frame = {
    runId: "r",
    type: "context.preflight",
    phase: "completed",
    page: { index: 0, total: 2 },
    result: { model: "fast", durationMs: 12, candidates: [], context: [] }
  }
  expect(ContextPreflightFrameSchema.parse(frame)).toEqual(frame)
  for (const page of [{ index: -1, total: 2 }, { index: 2, total: 2 }, { index: 0, total: 0 }]) {
    expect(ContextPreflightFrameSchema.safeParse({ ...frame, page }).success).toBe(false)
  }
  expect(ContextPreflightFrameSchema.safeParse({ ...frame, phase: undefined }).success).toBe(false)
})
