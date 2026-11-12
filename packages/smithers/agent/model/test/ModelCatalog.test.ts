import { describe, expect, it } from "vitest"
import * as ModelCatalog from "../src/ModelCatalog.ts"

describe("ModelCatalog.knownContextWindowTokens", () => {
  it("answers a matched row's window and undefined for an id no row matches", () => {
    expect(ModelCatalog.knownContextWindowTokens("gpt-4o")).toBe(128_000)
    expect(ModelCatalog.knownContextWindowTokens("claude-opus-5")).toBe(1_000_000)
    expect(ModelCatalog.knownContextWindowTokens("unknown")).toBeUndefined()
    expect(ModelCatalog.knownContextWindowTokens("")).toBeUndefined()
  })

  it("is what contextWindowTokensFor answers wherever it knows the model", () => {
    for (const model of ["claude-haiku-4-5", "gpt-5", "o3-mini", "claude-opus-4-6", "unknown"]) {
      expect(ModelCatalog.contextWindowTokensFor(model)).toBe(ModelCatalog.knownContextWindowTokens(model) ?? 128_000)
    }
  })
})

describe("ModelCatalog.contextWindowTokensFor", () => {
  it.each([
    ["claude-haiku-4-5", 200_000],
    ["CLAUDE-OPUS-5", 1_000_000],
    ["gpt-5", 400_000],
    ["gpt-4.1-mini", 1_000_000],
    ["gpt-4o", 128_000],
    ["o3-mini", 200_000],
    ["unknown", 128_000]
  ])("budgets %s at %i tokens", (model, tokens) => {
    expect(ModelCatalog.contextWindowTokensFor(model)).toBe(tokens)
  })

  // The native million-token rows and the invariant they were added under: a
  // row is anchored to the bare id, so a cloud-prefixed or non-date-suffixed id falls
  // through to the conservative Claude row. This catalogue is re-exported by
  // `@smthrs/agent` as `SeatResolver.contextWindowTokensFor`, and pinning it
  // only there let a dropped anchor pass this package's own suite.
  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["us.anthropic.claude-opus-4-6-v1", 200_000],
    ["publishers/anthropic/models/claude-opus-5@20260101", 200_000],
    ["claude-opus-5-1", 1_000_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5-1", 1_000_000],
    ["claude-opus-5-20260101", 1_000_000],
    ["claude-sonnet-4-5", 200_000]
  ])("budgets %s at %i tokens", (model, tokens) => {
    expect(ModelCatalog.contextWindowTokensFor(model)).toBe(tokens)
  })

  // Every seat the TUI offers must resolve a real window, never the unknown
  // floor, or long sessions on it compact early and discard context.
  it.each([
    ["gpt-6-sol", 400_000],
    ["gpt-6.1-sol", 1_050_000],
    ["gpt-6-luna", 400_000],
    ["gpt-5.6-sol", 400_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    // Cerebras's qwen seat: a real row, never the unknown floor.
    // https://inference-docs.cerebras.ai/models/qwen-3.8-27b
    ["qwen-3.8-27b", 128_000],
    ["QWEN-3.8-27B", 128_000]
  ])("budgets the TUI seat %s at %i tokens", (model, tokens) => {
    expect(ModelCatalog.contextWindowTokensFor(model)).toBe(tokens)
  })

  it("never resolves a window to zero, which a consumer reads as compaction disabled", () => {
    for (const model of ["", "somebody-elses-model", "claude", "o1"]) {
      expect(ModelCatalog.contextWindowTokensFor(model)).toBeGreaterThan(0)
    }
  })
})

describe("ModelCatalog dated snapshots", () => {
  it.each(
    [
      ["claude-opus-5", 1_000_000],
      ["claude-opus-5-5", 1_000_000],
      ["claude-sonnet-5-1", 1_000_000],
      ["claude-opus-4-6", 1_000_000],
      ["claude-opus-4-7", 1_000_000],
      ["claude-opus-4-8", 1_000_000],
      ["claude-sonnet-4-6", 1_000_000],
      ["claude-fable-5-1", 1_000_000],
      ["claude-mythos-5", 1_000_000],
      ["claude-haiku-4-5", 200_000],
      ["claude-sonnet-4-5", 200_000],
      ["anthropic/claude-opus-5", 200_000],
      ["unknown", undefined]
    ] as const
  )("keeps %s's context window for a dated snapshot", (model, tokens) => {
    const snapshot = model + "-20260115"
    expect(ModelCatalog.knownContextWindowTokens(model)).toBe(tokens)
    expect(ModelCatalog.knownContextWindowTokens(snapshot)).toBe(tokens)
    expect(ModelCatalog.contextWindowTokensFor(snapshot)).toBe(tokens ?? 128_000)
  })
})

describe("ModelCatalog.maxOutputTokensFor", () => {
  it.each([
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-sonnet-5-1",
    "CLAUDE-OPUS-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-fable-5-1",
    "claude-mythos-5"
  ])("keeps %s's output ceiling for a dated snapshot", (model) => {
    expect(ModelCatalog.maxOutputTokensFor(model)).toBe(128_000)
    expect(ModelCatalog.maxOutputTokensFor(model + "-20260101")).toBe(128_000)
  })

  it.each([
    "",
    "unknown",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "anthropic/claude-opus-5",
    "us.anthropic.claude-opus-4-6-v1",
    "claude-opus-5-preview",
    "claude-opus-5-2026011",
    "claude-opus-5-202601011"
  ])("leaves %s without an output ceiling", (model) => {
    expect(ModelCatalog.maxOutputTokensFor(model)).toBeUndefined()
    expect(ModelCatalog.maxOutputTokensFor(model + "-20260101")).toBeUndefined()
  })
})
