import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { Refusal } from "../src/Contribution.vibe"
import * as Load from "../src/Load.ts"
import * as Manifest from "../src/Manifest.ts"
import { host, queueManifest } from "./support/hostFacts.ts"

/** mulberry32: a small seeded generator, so every run tries the same inputs. */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

type Random = () => number

const pick = <A>(random: Random, values: ReadonlyArray<A>): A => values[Math.floor(random() * values.length)]!

const words = [
  "id",
  "queue",
  "$ref",
  "#/$defs/Note",
  "$item.runId",
  "$event.note",
  "view == queue/queue",
  "g q",
  "",
  "__proto__",
  "constructor",
  "run/answer",
  "core/waits",
  "component",
  "1.0.0",
  "^1.0.0",
  "é",
  "x".repeat(100)
]

const json = (random: Random, depth: number): unknown => {
  const roll = random()
  if (depth <= 0 || roll < 0.35) {
    return pick(random, [null, true, false, 0, -1, 1.5, 2 ** 53, pick(random, words), Math.floor(random() * 10)])
  }
  if (roll < 0.65) return Array.from({ length: Math.floor(random() * 4) }, () => json(random, depth - 1))
  return Object.fromEntries(
    Array.from({ length: Math.floor(random() * 4) }, () => [pick(random, words), json(random, depth - 1)])
  )
}

/** Replaces or deletes one value somewhere in a manifest. */
const mutate = (random: Random, value: any, depth = 0): unknown => {
  if (typeof value !== "object" || value === null || depth > 6) return json(random, 3)
  const keys = Object.keys(value)
  if (keys.length === 0 || random() < 0.15) return json(random, 3)
  const key = pick(random, keys)
  const copy = Array.isArray(value) ? [...value] : { ...value }
  if (random() < 0.2 && !Array.isArray(copy)) delete (copy as Record<string, unknown>)[key]
  else (copy as any)[key] = mutate(random, (value as any)[key], depth + 1)
  return copy
}

/** Decoding either succeeds or fails with a Refusal: it never throws or dies. */
const settles = (input: unknown) => {
  const exit = Effect.runSync(Effect.exit(Manifest.decode(input)))
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause), JSON.stringify(input)?.slice(0, 200)).toBe(false)
    expect(Cause.squash(exit.cause)).toBeInstanceOf(Refusal)
  }
  return Exit.isSuccess(exit)
}

describe("fuzzed decoding", () => {
  it("random JSON only decodes or refuses", () => {
    const random = generator(17)
    for (let run = 0; run < 2_000; run++) settles(json(random, 5))
  })

  it("mutated queue manifests only decode or refuse, and load without failing", async () => {
    const random = generator(2026)
    const candidates: Array<Load.Candidate> = []
    let decoded = 0
    for (let run = 0; run < 1_500; run++) {
      const manifest = mutate(random, queueManifest())
      if (settles(manifest)) decoded++
      if (run % 10 === 0) candidates.push({ tier: "built-in", manifest })
    }
    expect(decoded).toBeGreaterThan(0)
    const { contributions, refused } = await Effect.runPromise(Load.load(host(), candidates))
    expect(contributions.plugins.length + refused.length).toBe(candidates.length)
  })

  it("random text only parses or refuses", () => {
    const random = generator(99)
    for (let run = 0; run < 500; run++) {
      const text = JSON.stringify(json(random, 4)) ?? ""
      const cut = text.slice(0, Math.floor(random() * (text.length + 1)))
      const exit = Effect.runSync(Effect.exit(Manifest.parse(cut)))
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)
    }
  })
})
