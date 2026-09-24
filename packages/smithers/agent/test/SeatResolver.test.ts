/**
 * The seat vocabulary and the host seam that serves it.
 *
 * A live run in `AgentSession.test.ts` covers a resolver that answers; these
 * cases pin the parts a run never exercises: the model id read out of a
 * declared seat string, the context window catalogue, and the refusal a
 * composition with no configured resolver gives.
 *
 * There is nothing here about the shape of a seat string. The resolver owns
 * that vocabulary, so the agent validates nothing.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

describe("Seat.modelIdOf", () => {
  it("reads the half after the separator", () => {
    expect(Seat.modelIdOf("anthropic:claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    // Only the first separator splits; a model id may contain more.
    expect(Seat.modelIdOf("openai:org:gpt-5")).toBe("org:gpt-5")
  })

  it("reads a seat with no separator as its own model id", () => {
    expect(Seat.modelIdOf("test-model")).toBe("test-model")
  })

  it("keeps the degenerate separator positions total rather than special-casing them", () => {
    // A leading separator is an empty provider, so everything after it is the
    // model id; a trailing one is a model id of nothing. Neither is a legal
    // declaration, and neither may throw — the resolver owns the vocabulary,
    // so this conversion refuses nothing.
    expect(Seat.modelIdOf(":gpt-5")).toBe("gpt-5")
    expect(Seat.modelIdOf("anthropic:")).toBe("")
    expect(Seat.modelIdOf(":")).toBe("")
    expect(Seat.modelIdOf("")).toBe("")
    // Only the first separator splits, however many follow it.
    expect(Seat.modelIdOf("a:b:c:d")).toBe("b:c:d")
  })
})

describe("SeatResolver.contextWindowTokensFor", () => {
  it("resolves a context window for every catalogued model and a floor for the rest", () => {
    expect(SeatResolver.contextWindowTokensFor("claude-sonnet-4-5")).toBe(200_000)
    expect(SeatResolver.contextWindowTokensFor("claude-fable-5-1")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("claude-opus-5")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("claude-sonnet-5")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("claude-haiku-4-5")).toBe(200_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-5")).toBe(400_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-4.1-mini")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-4o")).toBe(128_000)
    expect(SeatResolver.contextWindowTokensFor("o3-mini")).toBe(200_000)
    // Never zero: zero is CellTurn's "compaction disabled".
    expect(SeatResolver.contextWindowTokensFor("somebody-elses-model")).toBe(128_000)
  })

  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-fable-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-mythos-5-1", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-opus-4-5", 200_000],
    ["claude-opus-4-1", 200_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-sonnet-4-5-20250929", 200_000],
    ["claude-3-opus-20240229", 200_000],
    ["claude-3-5-sonnet-20241022", 200_000],
    ["claude-haiku-4-5", 200_000],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", 200_000],
    ["publishers/anthropic/models/claude-opus-4-5@20251101", 200_000],
    ["us.anthropic.claude-opus-4-6-v1", 200_000],
    ["claude-opus-4-9", 200_000],
    ["claude-opus-5-1", 1_000_000],
    ["claude-fable-50", 200_000]
  ])("budgets %s at %i tokens", (id, tokens) => {
    expect(SeatResolver.contextWindowTokensFor(id)).toBe(tokens)
  })

  it("floors an empty model id rather than reporting zero", () => {
    // The empty string is what `modelIdOf` returns for a trailing-separator
    // seat, so it reaches this catalogue in practice and must still resolve
    // to a usable budget.
    expect(SeatResolver.contextWindowTokensFor("")).toBe(128_000)
  })

  it("matches the catalogue case-insensitively and first-pattern-wins", () => {
    expect(SeatResolver.contextWindowTokensFor("CLAUDE-OPUS-4-1")).toBe(200_000)
    expect(SeatResolver.contextWindowTokensFor("CLAUDE-OPUS-5")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("CLAUDE-HAIKU-4-5")).toBe(200_000)
    expect(SeatResolver.contextWindowTokensFor("GPT-5-Codex")).toBe(400_000)
    // Two patterns match; the catalogue order decides, and `claude` is first.
    expect(SeatResolver.contextWindowTokensFor("claude-gpt-5")).toBe(200_000)
  })

  it("anchors the o-series pattern, so a seat string is not a model id", () => {
    expect(SeatResolver.contextWindowTokensFor("o3")).toBe(200_000)
    // `^o[134]` is anchored on purpose: passing the whole seat string instead
    // of the model id silently downgrades the window to the floor, which is
    // why every caller resolves through `Seat.modelIdOf` first.
    expect(SeatResolver.contextWindowTokensFor("openai:o3")).toBe(128_000)
    expect(SeatResolver.contextWindowTokensFor(Seat.modelIdOf("openai:o3"))).toBe(200_000)
    // The character class is exactly 1, 3, and 4.
    expect(SeatResolver.contextWindowTokensFor("o2-preview")).toBe(128_000)
  })
})

describe("SeatResolver service", () => {
  it("resolves logical context budgets and preserves a typed host refusal", async () => {
    const unresolved = SeatResolver.contextWindowResolver(SeatResolver.makeNoop())
    expect(await Effect.runPromise(Effect.flip(unresolved("reviewer")))).toMatchObject({
      code: "assembly_failed",
      cause: { seat: "reviewer" }
    })
    const resolve = SeatResolver.contextWindowResolver(SeatResolver.make({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model: {} as never,
            route: {} as never,
            contextWindowTokens: 40_000
          })
        )
    }))
    expect(await Effect.runPromise(resolve("reviewer"))).toBe(40_000)
  })

  it("refuses every seat by default, because an unconfigured host holds no credential", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(SeatResolver.makeNoop().resolve("anthropic:claude-sonnet-4-5"))
    )
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.seat).toBe("anthropic:claude-sonnet-4-5")
    expect(failure.message).toBe("No seat resolver is configured")
  })

  it("takes an override for its one method, as a value and as a layer", async () => {
    const model = { stream: () => Effect.die("unused") } as never
    const route = { prepare: () => Effect.die("unused") } as never
    const resolved = Seat.make({ id: "test:model", modelId: "model", model, route, contextWindowTokens: 128_000 })

    const overridden = SeatResolver.makeNoop({ resolve: () => Effect.succeed(resolved) })
    expect(await Effect.runPromise(overridden.resolve("test:model"))).toBe(resolved)

    const layered = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        return yield* seats.resolve("test:model")
      }).pipe(Effect.provide(SeatResolver.layerNoop({ resolve: () => Effect.succeed(resolved) })))
    )
    expect(layered).toBe(resolved)

    const provided = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        return yield* seats.resolve("test:model")
      }).pipe(Effect.provide(SeatResolver.layer({ resolve: () => Effect.succeed(resolved) })))
    )
    expect(provided).toBe(resolved)
  })
})
