import { ModelRequest } from "@smthrs/model"
import { Effect } from "effect"
import * as Result from "effect/Result"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Compaction from "../src/Compaction.ts"
import { ContextWindow, prefixDigest } from "../src/ContextWindow.ts"

const message = (text: string) => ModelRequest.Message.assistant(text, { stopReason: "stop" })

// What a summarizer's assistant reply becomes once it is seated in the window.
// The Messages API requires a leading user message, so a summary that replaced
// the prefix — the only turn ahead of it — is re-roled rather than left as the
// assistant turn the summarizer produced.
const summarized = (text: string) => ModelRequest.Message.user(text)

const segment = (text: string, tokens: number) => ({
  kind: "transcript" as const,
  zone: "tail" as const,
  content: [message(text)],
  tokens: { value: tokens, estimated: false }
})

const window = () =>
  ContextWindow.make({
    modelId: "model",
    segments: [segment("first", 12_000), segment("middle", 12_000), segment("suffix", 20_000)]
  })

const summarizer: Compaction.Summarizer = {
  identity: "summary-v1",
  modelId: "summary-model",
  params: ModelRequest.GenerationParams.make({ temperature: 0 })
}

const capacity = (total: number, contextWindow: number) => ({ total: { value: total }, contextWindow })

/**
 * A window that reports its real segments for `healthyReads` reads of
 * `segments` and an empty list from then on.
 *
 * Nothing a caller can construct behaves this way: a `ContextWindow` is
 * immutable, so the internal prefix guard and the public context-window
 * combinators always agree. The failures mapped below exist for the case where
 * they do not, and this is the only way to observe that mapping.
 */
const losesItsPrefixAfter = (healthyReads: number, self: ContextWindow): ContextWindow => {
  let reads = 0
  const drifting: ContextWindow = Object.create(self, {
    segments: { get: () => (reads++ < healthyReads ? self.segments : []) }
  })
  return drifting
}

describe("Compaction", () => {
  it("triggers only after capacity minus the reserve", () => {
    const contextWindow = 100_000
    expect(Compaction.shouldCompact({ total: { value: 84_000 }, contextWindow })).toBe(false)
    expect(Compaction.shouldCompact({ total: { value: 83_999 }, contextWindow })).toBe(false)
    expect(Compaction.shouldCompact({ total: { value: 84_001 }, contextWindow })).toBe(true)
    expect(Compaction.shouldCompact({ total: { value: 1 }, contextWindow: 0 })).toBe(false)
  })

  it("keeps at least the configured recent token suffix", () => {
    const input = window()
    const prefixLength = Compaction.selectPrefix(input, { keepRecent: 20_000 })
    const compactable = input.segments.filter((item) => item.kind === "transcript")
    expect(prefixLength).toBe(2)
    expect(compactable.slice(prefixLength).reduce((sum, item) => sum + item.tokens.value, 0)).toBeGreaterThanOrEqual(
      20_000
    )
  })

  it("does not split a tool-call and tool-result pair at the cut", () => {
    const call = ModelRequest.Message.assistant(
      ModelRequest.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{}" }),
      { stopReason: "tool-calls" }
    )
    const result = ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call-1", content: "ok" }))
    const input = ContextWindow.make({
      modelId: "model",
      segments: [
        segment("old", 10),
        { kind: "transcript", zone: "tail", content: [call], tokens: { value: 10, estimated: false } },
        { kind: "transcript", zone: "tail", content: [result], tokens: { value: 10, estimated: false } },
        segment("recent", 10)
      ]
    })
    expect(Compaction.selectPrefix(input, { keepRecent: 20 })).toBe(1)
  })

  it("extends a prior summary and preserves the uncompacted suffix", () => {
    const input = window()
    const first = Effect.runSync(Compaction.declare(input, 1, summarizer))
    const once = Effect.runSync(Compaction.apply(input, first, message("summary one")))
    const second = Effect.runSync(Compaction.declare(once, 2, summarizer))
    const request = Effect.runSync(Compaction.summaryRequest(once, second))
    const twice = Effect.runSync(Compaction.apply(once, second, message("summary two")))

    expect(
      request.messages.flatMap((item) => [...item.content]).some((item) =>
        item.type === "text" && item.text === "summary one"
      )
    ).toBe(true)
    expect(request.system.map((part) => part.text)).toContain(Compaction.summaryInstruction)
    expect(twice.segments.at(-1)?.digest).toBe(once.segments.at(-1)?.digest)
    expect(twice.segments.filter((item) => item.kind === "summary")).toHaveLength(1)
  })

  it("reports invalid declarations through the typed error channel", () => {
    const error = Effect.runSync(Compaction.declare(window(), 0, summarizer).pipe(Effect.flip))
    expect(error).toBeInstanceOf(Compaction.InvalidStep)
  })

  describe("shouldCompact", () => {
    it("sits exactly on the reserve boundary", () => {
      // The threshold is capacity minus reserve, and the trigger is strictly above it.
      expect(Compaction.shouldCompact(capacity(50_000, 60_000), { reserve: 10_000 })).toBe(false)
      expect(Compaction.shouldCompact(capacity(49_999, 60_000), { reserve: 10_000 })).toBe(false)
      expect(Compaction.shouldCompact(capacity(50_001, 60_000), { reserve: 10_000 })).toBe(true)
    })

    it("treats a zero reserve as the capacity itself", () => {
      expect(Compaction.shouldCompact(capacity(100_000, 100_000), { reserve: 0 })).toBe(false)
      expect(Compaction.shouldCompact(capacity(100_001, 100_000), { reserve: 0 })).toBe(true)
    })

    it("triggers on the first token when the reserve is the whole window", () => {
      expect(Compaction.shouldCompact(capacity(0, 100_000), { reserve: 100_000 })).toBe(false)
      expect(Compaction.shouldCompact(capacity(1, 100_000), { reserve: 100_000 })).toBe(true)
    })

    it("triggers on an empty context when the reserve exceeds the whole window", () => {
      expect(Compaction.shouldCompact(capacity(0, 100_000), { reserve: 200_000 })).toBe(true)
    })

    it("disables itself for an unknown or nonsensical capacity", () => {
      expect(Compaction.shouldCompact(capacity(1_000_000, 0))).toBe(false)
      expect(Compaction.shouldCompact(capacity(1_000_000, -1))).toBe(false)
      expect(Compaction.shouldCompact(capacity(0, 0))).toBe(false)
    })

    it("disables itself for a non-finite accounting", () => {
      expect(Compaction.shouldCompact(capacity(10, Number.NaN))).toBe(false)
      expect(Compaction.shouldCompact(capacity(10, Number.POSITIVE_INFINITY))).toBe(false)
      expect(Compaction.shouldCompact(capacity(Number.NaN, 100_000))).toBe(false)
      expect(Compaction.shouldCompact(capacity(Number.POSITIVE_INFINITY, 100_000))).toBe(false)
    })

    it("disables itself for a non-finite policy", () => {
      const full = capacity(99_999, 100_000)
      expect(Compaction.shouldCompact(full, { reserve: Number.NaN })).toBe(false)
      expect(Compaction.shouldCompact(full, { reserve: Number.POSITIVE_INFINITY })).toBe(false)
      expect(Compaction.shouldCompact(full, { keepRecent: Number.NaN })).toBe(false)
      expect(Compaction.shouldCompact(full, { keepRecent: Number.POSITIVE_INFINITY })).toBe(false)
      expect(Compaction.shouldCompact(full, { reserve: 1, keepRecent: Number.NaN })).toBe(false)
    })

    it("ignores keepRecent when deciding the trigger", () => {
      const full = capacity(84_001, 100_000)
      const empty = capacity(84_000, 100_000)
      for (const keepRecent of [0, 1, 20_000, 1_000_000]) {
        expect(Compaction.shouldCompact(full, { keepRecent })).toBe(true)
        expect(Compaction.shouldCompact(empty, { keepRecent })).toBe(false)
      }
    })

    it("reads both policy options together", () => {
      expect(Compaction.shouldCompact(capacity(90_000, 100_000), { reserve: 5_000, keepRecent: 1 })).toBe(false)
      expect(Compaction.shouldCompact(capacity(95_001, 100_000), { reserve: 5_000, keepRecent: 1 })).toBe(true)
    })

    it("defaults the reserve to sixteen thousand tokens", () => {
      expect(Compaction.shouldCompact(capacity(84_001, 100_000))).toBe(true)
      expect(Compaction.shouldCompact(capacity(84_001, 100_000), {})).toBe(true)
      expect(Compaction.shouldCompact(capacity(84_000, 100_000), {})).toBe(false)
      expect(Compaction.shouldCompact(capacity(84_001, 100_000), { keepRecent: 20_000 })).toBe(true)
    })
  })

  describe("selectPrefix", () => {
    it("selects nothing from an empty window", () => {
      expect(Compaction.selectPrefix(ContextWindow.empty("model"))).toBe(0)
      expect(Compaction.selectPrefix(ContextWindow.empty("model"), { keepRecent: 0 })).toBe(0)
    })

    it("selects nothing when there is nothing compaction may replace", () => {
      const sealed = ContextWindow.make({
        modelId: "model",
        segments: [{ kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] }]
      })
      expect(Compaction.selectPrefix(sealed, { keepRecent: 0 })).toBe(0)
    })

    it("selects the whole compactable set when no suffix is retained", () => {
      expect(Compaction.selectPrefix(window(), { keepRecent: 0 })).toBe(3)
    })

    it("selects nothing when the retained suffix covers the whole transcript", () => {
      // 12_000 + 12_000 + 20_000 tokens: at exactly the total, and past it.
      expect(Compaction.selectPrefix(window(), { keepRecent: 44_000 })).toBe(0)
      expect(Compaction.selectPrefix(window(), { keepRecent: 44_001 })).toBe(0)
      expect(Compaction.selectPrefix(window(), { keepRecent: Number.MAX_SAFE_INTEGER })).toBe(0)
    })

    it("stops at the segment that first satisfies the retained suffix", () => {
      // The last segment alone is exactly 20_000 tokens.
      expect(Compaction.selectPrefix(window(), { keepRecent: 19_999 })).toBe(2)
      expect(Compaction.selectPrefix(window(), { keepRecent: 20_000 })).toBe(2)
      expect(Compaction.selectPrefix(window(), { keepRecent: 20_001 })).toBe(1)
      expect(Compaction.selectPrefix(window(), { keepRecent: 32_000 })).toBe(1)
      expect(Compaction.selectPrefix(window(), { keepRecent: 32_001 })).toBe(0)
    })

    it("selects nothing for a negative or non-finite retention", () => {
      expect(Compaction.selectPrefix(window(), { keepRecent: -1 })).toBe(0)
      expect(Compaction.selectPrefix(window(), { keepRecent: Number.NaN })).toBe(0)
      expect(Compaction.selectPrefix(window(), { keepRecent: Number.POSITIVE_INFINITY })).toBe(0)
    })

    it("defaults the retention to twenty thousand tokens", () => {
      expect(Compaction.selectPrefix(window())).toBe(2)
      expect(Compaction.selectPrefix(window(), {})).toBe(2)
    })

    it("selects nothing from a single-segment transcript that is itself the suffix", () => {
      const one = ContextWindow.make({ modelId: "model", segments: [segment("only", 10)] })
      expect(Compaction.selectPrefix(one, { keepRecent: 1 })).toBe(0)
      expect(Compaction.selectPrefix(one, { keepRecent: 0 })).toBe(1)
    })

    it("counts summary and steering segments toward the retained suffix", () => {
      const mixed = ContextWindow.make({
        modelId: "model",
        segments: [
          { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] },
          {
            kind: "summary",
            zone: "tail",
            content: [message("prior")],
            tokens: { value: 10, estimated: false }
          },
          {
            kind: "steering",
            zone: "tail",
            content: [ModelRequest.Message.user("steer")],
            tokens: { value: 10, estimated: false }
          },
          segment("latest", 10)
        ]
      })
      expect(Compaction.selectPrefix(mixed, { keepRecent: 10 })).toBe(2)
      expect(Compaction.selectPrefix(mixed, { keepRecent: 0 })).toBe(3)
    })

    it("ignores a tool call whose result never arrived", () => {
      const call = ModelRequest.Message.assistant(
        ModelRequest.ToolCallPart.make({ id: "dangling", name: "read", arguments: "{}" }),
        { stopReason: "tool-calls" }
      )
      const input = ContextWindow.make({
        modelId: "model",
        segments: [
          { kind: "transcript", zone: "tail", content: [call], tokens: { value: 10, estimated: false } },
          {
            kind: "transcript",
            zone: "tail",
            content: [ModelRequest.Message.user("unrelated")],
            tokens: { value: 10, estimated: false }
          }
        ]
      })
      // With no matching result there is no pair to protect, so the cut is free.
      expect(Compaction.selectPrefix(input, { keepRecent: 10 })).toBe(1)
    })

    it("protects a pair whose result was recorded before its call", () => {
      const call = ModelRequest.Message.assistant(
        ModelRequest.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{}" }),
        { stopReason: "tool-calls" }
      )
      const result = ModelRequest.Message.tool(
        ModelRequest.ToolResultPart.make({ toolCallId: "call-1", content: "ok" })
      )
      const input = ContextWindow.make({
        modelId: "model",
        segments: [
          { kind: "transcript", zone: "tail", content: [result], tokens: { value: 10, estimated: false } },
          { kind: "transcript", zone: "tail", content: [call], tokens: { value: 10, estimated: false } }
        ]
      })
      expect(Compaction.selectPrefix(input, { keepRecent: 10 })).toBe(0)
    })

    it("walks back past several unsafe boundaries at once", () => {
      const call = ModelRequest.Message.assistant(
        ModelRequest.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{}" }),
        { stopReason: "tool-calls" }
      )
      const middle = ModelRequest.Message.user("interleaved")
      const result = ModelRequest.Message.tool(
        ModelRequest.ToolResultPart.make({ toolCallId: "call-1", content: "ok" })
      )
      const input = ContextWindow.make({
        modelId: "model",
        segments: [
          segment("old", 10),
          { kind: "transcript", zone: "tail", content: [call], tokens: { value: 10, estimated: false } },
          { kind: "transcript", zone: "tail", content: [middle], tokens: { value: 10, estimated: false } },
          { kind: "transcript", zone: "tail", content: [result], tokens: { value: 10, estimated: false } }
        ]
      })
      // Boundaries 2 and 3 both sit inside the pair, so the cut falls back to 1.
      expect(Compaction.selectPrefix(input, { keepRecent: 10 })).toBe(1)
    })
  })

  describe("declare", () => {
    it("records the prefix length, the summarizer, and the digest of the exact prefix", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 2, summarizer))
      expect(step.kind).toBe("compaction")
      expect(step.prefixLength).toBe(2)
      expect(step.summarizer).toBe(summarizer)
      expect(step.replacedPrefixDigest).toBe(Result.getOrThrow(prefixDigest(input, 2)))
    })

    it("declares the same step twice for the same window and prefix", () => {
      expect(Effect.runSync(Compaction.declare(window(), 1, summarizer))).toEqual(
        Effect.runSync(Compaction.declare(window(), 1, summarizer))
      )
    })

    it("separates declarations that differ only by prefix length", () => {
      const one = Effect.runSync(Compaction.declare(window(), 1, summarizer))
      const two = Effect.runSync(Compaction.declare(window(), 2, summarizer))
      expect(two.replacedPrefixDigest).not.toBe(one.replacedPrefixDigest)
    })

    it("declares the whole compactable set at its exact length", () => {
      expect(Effect.runSync(Compaction.declare(window(), 3, summarizer)).prefixLength).toBe(3)
    })

    it("refuses an empty prefix", () => {
      for (const prefixLength of [0, -1, -0.5]) {
        const error = Effect.runSync(Compaction.declare(window(), prefixLength, summarizer).pipe(Effect.flip))
        expect(error.message).toBe("A compaction must replace a non-empty context prefix")
      }
    })

    it("refuses a prefix length that is not a safe integer", () => {
      for (const prefixLength of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        const error = Effect.runSync(Compaction.declare(window(), prefixLength, summarizer).pipe(Effect.flip))
        expect(error).toBeInstanceOf(Compaction.InvalidStep)
        expect(error.message).toBe("A compaction must replace a non-empty context prefix")
      }
    })

    it("refuses a prefix one segment past the compactable set", () => {
      const error = Effect.runSync(Compaction.declare(window(), 4, summarizer).pipe(Effect.flip))
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
    })

    it("refuses any prefix of a window with nothing to compact", () => {
      const sealed = ContextWindow.make({
        modelId: "model",
        segments: [{ kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] }]
      })
      const error = Effect.runSync(Compaction.declare(sealed, 1, summarizer).pipe(Effect.flip))
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
      expect(Effect.runSync(Compaction.declare(ContextWindow.empty("model"), 1, summarizer).pipe(Effect.flip)))
        .toBeInstanceOf(Compaction.InvalidStep)
    })

    it("maps a context-window failure onto InvalidStep when the prefix vanishes mid-declaration", () => {
      const error = Effect.runSync(
        Compaction.declare(losesItsPrefixAfter(1, window()), 1, summarizer).pipe(Effect.flip)
      )
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
      expect(error.cause).toMatchObject({ code: "invalid_compaction_prefix" })
    })
  })

  describe("summaryRequest", () => {
    it("types the summarizer parameters as generation parameters", () => {
      expectTypeOf<Compaction.Summarizer["params"]>().toEqualTypeOf<ModelRequest.GenerationParams | undefined>()
    })

    it("asks for a summary of exactly the declared prefix and nothing after it", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 2, summarizer))
      const request = Effect.runSync(Compaction.summaryRequest(input, step))
      expect(
        request.messages.flatMap((item) => [...item.content]).map((part) => "text" in part ? part.text : undefined)
      ).toEqual(["first", "middle"])
      expect(request.system.map((part) => part.text)).toEqual([Compaction.summaryInstruction])
      expect(request.tools).toEqual([])
    })

    it("uses the summarizer's own model and parameters when it declares them", () => {
      const step = Effect.runSync(Compaction.declare(window(), 1, summarizer))
      const request = Effect.runSync(Compaction.summaryRequest(window(), step))
      expect(request.modelId).toBe("summary-model")
      expect(request.params).toEqual(ModelRequest.GenerationParams.make({ temperature: 0 }))
    })

    it("falls back to the window's model when the summarizer names none", () => {
      const bare: Compaction.Summarizer = { identity: "summary-v1" }
      const step = Effect.runSync(Compaction.declare(window(), 1, bare))
      const request = Effect.runSync(Compaction.summaryRequest(window(), step))
      expect(request.modelId).toBe("model")
      expect(request.params).toEqual(ModelRequest.GenerationParams.make())
    })

    it("preserves parameters after a JSON round trip", () => {
      const declaration: Compaction.Summarizer = JSON.parse(JSON.stringify({
        ...summarizer,
        params: ModelRequest.GenerationParams.make({ temperature: 0.5, maxTokens: 512, stopSequences: ["end"] })
      }))
      const step = Effect.runSync(Compaction.declare(window(), 1, declaration))
      expect(Effect.runSync(Compaction.summaryRequest(window(), step)).params).toEqual(
        ModelRequest.GenerationParams.make({ temperature: 0.5, maxTokens: 512, stopSequences: ["end"] })
      )
    })

    it("rejects invalid supplied parameters instead of silently defaulting", () => {
      for (const params of ["high", null, { temperature: "hot" }, { temperature: Infinity }, { unknown: 1 }]) {
        const declaration = { identity: "summary-v1", params } as unknown as Compaction.Summarizer
        const step = Effect.runSync(Compaction.declare(window(), 1, declaration))
        const error = Effect.runSync(Compaction.summaryRequest(window(), step).pipe(Effect.flip))
        expect(error).toBeInstanceOf(Compaction.InvalidStep)
        expect(error.message).toBe("Invalid summarizer generation parameters")
      }
    })

    it("carries only messages into the request, skipping system text in a compactable segment", () => {
      const input = ContextWindow.make({
        modelId: "model",
        segments: [
          {
            kind: "steering",
            zone: "tail",
            content: [ModelRequest.SystemPart.make({ text: "steering directive" })],
            tokens: { value: 10, estimated: false }
          },
          segment("recent", 10)
        ]
      })
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const request = Effect.runSync(Compaction.summaryRequest(input, step))
      expect(request.messages).toEqual([])
      expect(request.system.map((part) => part.text)).toEqual([Compaction.summaryInstruction])
    })

    it("refuses a step whose recorded prefix no longer matches the window", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const forged: Compaction.CompactionStep = { ...step, replacedPrefixDigest: "not-this-prefix" }
      const error = Effect.runSync(Compaction.summaryRequest(input, forged).pipe(Effect.flip))
      expect(error.message).toBe("The recorded compaction summary does not match the current context prefix")
      expect(error.cause).toBeUndefined()
    })

    it("refuses a step declared against a different window", () => {
      const other = ContextWindow.make({ modelId: "model", segments: [segment("other", 10), segment("tail", 10)] })
      const step = Effect.runSync(Compaction.declare(other, 1, summarizer))
      const error = Effect.runSync(Compaction.summaryRequest(window(), step).pipe(Effect.flip))
      expect(error.message).toBe("The recorded compaction summary does not match the current context prefix")
    })

    it("refuses a step whose prefix is no longer present at all", () => {
      const step = Effect.runSync(Compaction.declare(window(), 3, summarizer))
      const shorter = ContextWindow.make({ modelId: "model", segments: [segment("first", 12_000)] })
      const error = Effect.runSync(Compaction.summaryRequest(shorter, step).pipe(Effect.flip))
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
    })

    it("maps a context-window failure onto InvalidStep when the prefix vanishes mid-request", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const error = Effect.runSync(
        Compaction.summaryRequest(losesItsPrefixAfter(1, input), step).pipe(Effect.flip)
      )
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
      expect(error.cause).toMatchObject({ code: "invalid_compaction_prefix" })
    })
  })

  describe("apply", () => {
    it("replaces the declared prefix and leaves the source window untouched", () => {
      const input = window()
      const before = input.digest
      const step = Effect.runSync(Compaction.declare(input, 2, summarizer))
      const applied = Effect.runSync(Compaction.apply(input, step, message("summary")))
      expect(input.digest).toBe(before)
      expect(input.segments).toHaveLength(3)
      expect(applied.segments.map((item) => item.kind)).toEqual(["summary", "transcript"])
      expect(applied.replaced).toBe(step.replacedPrefixDigest)
    })

    it("accepts a list of recorded summary messages", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 2, summarizer))
      const applied = Effect.runSync(
        Compaction.apply(input, step, [message("part one"), message("part two")])
      )
      expect(applied.segments[0]?.content).toHaveLength(2)
    })

    it("is deterministic for the same window, step, and summary", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      expect(Effect.runSync(Compaction.apply(input, step, message("s"))).digest).toBe(
        Effect.runSync(Compaction.apply(input, step, message("s"))).digest
      )
    })

    it("grows the accounting when the summary is larger than the prefix it replaced", () => {
      const input = ContextWindow.make({ modelId: "model", segments: [segment("tiny", 1), segment("suffix", 1)] })
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const applied = Effect.runSync(Compaction.apply(input, step, message("verbose ".repeat(200))))
      expect(applied.tokens.total.value).toBeGreaterThan(input.tokens.total.value)
    })

    it("compacts an already-compacted transcript again without stacking summaries", () => {
      const input = window()
      let current = input
      for (const [round, text] of [[1, "summary one"], [2, "summary two"], [1, "summary three"]] as const) {
        const step = Effect.runSync(Compaction.declare(current, round, summarizer))
        current = Effect.runSync(Compaction.apply(current, step, message(text)))
        expect(current.segments.filter((item) => item.kind === "summary")).toHaveLength(1)
      }
      expect(current.segments.at(0)?.content).toEqual([summarized("summary three")])
      expect(current.segments.at(-1)?.digest).toBe(input.segments.at(-1)?.digest)
    })

    it("refuses a step whose recorded prefix no longer matches the window", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const forged: Compaction.CompactionStep = { ...step, replacedPrefixDigest: "not-this-prefix" }
      const error = Effect.runSync(Compaction.apply(input, forged, message("s")).pipe(Effect.flip))
      expect(error.message).toBe("The recorded compaction summary does not match the current context prefix")
    })

    it("refuses a step whose prefix is no longer present at all", () => {
      const step = Effect.runSync(Compaction.declare(window(), 3, summarizer))
      const shorter = ContextWindow.make({ modelId: "model", segments: [segment("first", 12_000)] })
      const error = Effect.runSync(Compaction.apply(shorter, step, message("s")).pipe(Effect.flip))
      expect(error.message).toBe("The declared compaction prefix is not present in the context window")
    })

    it("maps a digest failure onto InvalidStep when the prefix vanishes before the check", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const error = Effect.runSync(
        Compaction.apply(losesItsPrefixAfter(1, input), step, message("s")).pipe(Effect.flip)
      )
      expect(error.message).toBe("The recorded compaction prefix is not present in the context window")
      expect(error.cause).toMatchObject({ code: "invalid_compaction_prefix" })
    })

    it("maps a replacement failure onto InvalidStep when the prefix vanishes after the check", () => {
      const input = window()
      const step = Effect.runSync(Compaction.declare(input, 1, summarizer))
      const error = Effect.runSync(
        Compaction.apply(losesItsPrefixAfter(2, input), step, message("s")).pipe(Effect.flip)
      )
      expect(error.message).toBe("Unable to apply the recorded compaction summary")
      expect(error.cause).toMatchObject({ code: "invalid_compaction_prefix" })
    })
  })

  describe("the trigger, cut, and apply policy end to end", () => {
    it("declares and applies the prefix the policy selected", () => {
      const input = window()
      expect(Compaction.shouldCompact({ total: input.tokens.total, contextWindow: 50_000 })).toBe(true)
      const prefixLength = Compaction.selectPrefix(input, { keepRecent: 20_000 })
      const step = Effect.runSync(Compaction.declare(input, prefixLength, summarizer))
      const applied = Effect.runSync(Compaction.apply(input, step, message("summary")))
      expect(applied.tokens.total.value).toBeLessThan(input.tokens.total.value)
      expect(Compaction.shouldCompact({ total: applied.tokens.total, contextWindow: 50_000 })).toBe(false)
    })
  })
})
