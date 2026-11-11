import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Sampling from "../src/Sampling.vibe"

const decide = (sampling: Sampling.Sampling, target: string, scorer: string) =>
  Effect.runPromise(Sampling.decide(sampling, target, scorer))

/**
 * Brackets the sampling hash for one tuple. `decide` is `hash < ratio`, so a
 * ratio just above the recorded value samples and a ratio just below does not:
 * together they pin the hash to within 1e-9 through the public API.
 */
const brackets = async (parts: readonly [string, string, string], hash: number) => {
  const [target, scorer, seed] = parts
  return {
    above: await decide({ ratio: hash + 1e-9, seed }, target, scorer),
    below: await decide({ ratio: hash - 1e-9, seed }, target, scorer)
  }
}

// Frozen because a change to either the byte encoding or the length-prefixed
// tuple moves every sampling decision already taken downstream. Recompute and
// note the shift in the CHANGELOG rather than editing a number to go green.
const golden: ReadonlyArray<readonly [string, readonly [string, string, string], number]> = [
  ["ascii", ["target", "scorer", "v1"], 0.2564394793007523],
  ["empty target and scorer", ["", "", "s"], 0.9462956271599978],
  ["bmp non-ascii", ["étape", "scorer", "v1"], 0.3897779656108469],
  ["astral", ["\u{1D306}", "s", "seed"], 0.06866220640949905],
  ["delimiter bearing", ["a:b", "c", "d"], 0.10413320036605]
]

describe("Sampling", () => {
  it("is deterministic for a key", async () => {
    const first = await decide({ ratio: 0.4, seed: "v1" }, "target", "scorer")
    const second = await decide({ ratio: 0.4, seed: "v1" }, "target", "scorer")
    expect(first).toBe(second)
  })

  it("samples everything with \"all\" and nothing with \"none\"", async () => {
    expect(await decide("all", "target", "scorer")).toBe(true)
    expect(await decide("none", "target", "scorer")).toBe(false)
  })

  it.each(golden)("freezes the hash for %s", async (_name, parts, hash) => {
    expect(await brackets(parts, hash)).toEqual({ above: true, below: false })
  })

  it("distinguishes astral code points in the same block", async () => {
    // `charCodeAt(0)` read only the high surrogate, so every astral character
    // in one 1024-code-point block hashed identically.
    const seed = "seed"
    const ratio = 0.1
    const first = await decide({ ratio, seed }, "\u{1D306}", "s")
    const second = await decide({ ratio, seed }, "\u{1D307}", "s")
    expect([first, second]).toEqual([true, false])
  })

  it("distinguishes tuples whose components contain the delimiter", async () => {
    // ("a:b", "c", "d") and ("a", "b:c", "d") produced the same `:`-joined
    // material and therefore the same decision at every ratio.
    const ratio = 0.5
    const first = await decide({ ratio, seed: "d" }, "a:b", "c")
    const second = await decide({ ratio, seed: "d" }, "a", "b:c")
    expect([first, second]).toEqual([true, false])
  })

  it("spreads decisions across the requested ratio", async () => {
    const total = 400
    let sampled = 0
    for (let index = 0; index < total; index += 1) {
      if (await decide({ ratio: 0.25, seed: "spread" }, `step-${index}`, "scorer")) sampled += 1
    }
    expect(sampled).toBeGreaterThan(total * 0.15)
    expect(sampled).toBeLessThan(total * 0.35)
  })

  it.each([
    ["one", { ratio: 1, seed: "v1" }],
    ["zero", { ratio: 0, seed: "v1" }],
    ["negative", { ratio: -3, seed: "v1" }],
    ["not a number", { ratio: Number.NaN, seed: "v1" }]
  ])("rejects the %s ratio and names it", async (_name, sampling) => {
    const failure = await Effect.runPromise(
      Effect.flip(Sampling.decide(sampling as Sampling.Sampling, "target", "scorer"))
    )
    expect(failure.code).toBe("invalid_sampling")
    expect(failure.message).toContain(`received ratio ${String(sampling.ratio)}`)
  })

  it("rejects an empty seed", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Sampling.decide({ ratio: 0.5, seed: "" }, "target", "scorer"))
    )
    expect(failure.code).toBe("invalid_sampling")
  })

  it("rejects a policy that is not a member of the vocabulary", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Sampling.decide("sometimes" as unknown as Sampling.Sampling, "target", "scorer"))
    )
    expect(failure.code).toBe("invalid_sampling")
    expect(failure.message).not.toContain("received ratio")
  })

  it("returns a typed failure when a rejected ratio cannot be read", async () => {
    const hostile = new Proxy({ seed: "v1" }, {
      has: (_target, key) => key === "ratio",
      get: (_target, key) => {
        if (key === "ratio") throw new TypeError("no")
        return "v1"
      }
    }) as Sampling.Sampling
    const failure = await Effect.runPromise(
      Effect.flip(Sampling.decide(hostile, "target", "scorer"))
    )
    expect(failure.code).toBe("invalid_sampling")
    expect(failure.message).not.toContain("received ratio")
  })
})
