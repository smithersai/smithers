import { describe, expect, it } from "vitest"
import * as ModelCatalog from "../src/ModelCatalog.ts"

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
  // row is anchored to the bare id, so a cloud-prefixed or suffixed id falls
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
    ["claude-opus-5-1", 200_000],
    ["claude-sonnet-4-5", 200_000]
  ])("budgets %s at %i tokens", (model, tokens) => {
    expect(ModelCatalog.contextWindowTokensFor(model)).toBe(tokens)
  })

  it("never resolves a window to zero, which a consumer reads as compaction disabled", () => {
    for (const model of ["", "somebody-elses-model", "claude", "o1"]) {
      expect(ModelCatalog.contextWindowTokensFor(model)).toBeGreaterThan(0)
    }
  })
})
