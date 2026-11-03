import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Source from "../src/Source.ts"

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

// A small deterministic PRNG keeps every failure reproducible from its seed.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Characters that exercise every escape class, multi-byte UTF-8, astral code
// points, and lone surrogates (which TextEncoder writes as three bytes).
const alphabet = [
  "a",
  "Z",
  " ",
  "]",
  ":",
  "/",
  "\\",
  "<",
  "[",
  "\r",
  "\n",
  "\u0085",
  " ",
  " ",
  "é",
  "中",
  "😀",
  "\ud800",
  "\udfff",
  "<flows_memory_context>",
  "</flows_memory_context>"
]

const text = (random: () => number, max: number): string => {
  let out = ""
  const length = Math.floor(random() * max)
  for (let index = 0; index < length; index++) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}

const fenceLines = (rendered: string): Array<string> => rendered.split("\n").slice(1, -1)

describe("Source byte budget (seeded fuzz)", () => {
  it("never renders past maxBytes, keeps one row per line, and keeps rows as ordered prefixes", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = prng(seed)
      const primerTexts = Array.from({ length: Math.floor(random() * 4) }, () => text(random, 40))
      const recalled: Recall.Output = Array.from({ length: Math.floor(random() * 4) }, (_, index) => ({
        bank: `bank${text(random, 3)}x`,
        key: `key-${index}${text(random, 3)}`,
        text: text(random, 40),
        score: 1
      }))
      const maxBytes = Math.floor(random() * 400)
      const store = MemoryStore.MemoryStore.of({
        searchRows: () =>
          Effect.succeed(primerTexts.map((primer, index) => ({ kind: "note", id: `p${index}`, text: primer })))
      } as unknown as MemoryStore.Service)
      const recall = Recall.layer({ recall: () => Effect.succeed(recalled) })
      const { rows } = await Effect.runPromise(
        Source.readRows({ lineageId: "l", iteration: seed, banks: ["primer[bank]"], query: "q", maxBytes }).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provide(recall)
        )
      )
      const rendered = Source.render(rows)
      const context = `seed ${seed}, maxBytes ${maxBytes}`
      expect(byteLength(rendered), context).toBeLessThanOrEqual(maxBytes)
      if (rows.length > 0) expect(fenceLines(rendered), context).toHaveLength(rows.length)
      expect(rendered.match(/<flows_memory_context>/g)?.length ?? 0, context).toBeLessThanOrEqual(1)
      const candidates = [
        ...primerTexts.map((primer) => primer),
        ...recalled.map((row) => row.text)
      ]
      rows.forEach((row, index) => {
        expect(candidates[index]!.startsWith(row.text), context).toBe(true)
        if (index < rows.length - 1) expect(row.text, context).toBe(candidates[index])
      })
    }
  })
})

describe("Recall.capRecallResults byte budget (seeded fuzz)", () => {
  it("never serializes past maxTokens bytes and keeps results as ordered prefixes", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = prng(seed)
      const results: Recall.Output = Array.from({ length: Math.floor(random() * 5) }, (_, index) => ({
        bank: "bank",
        key: `key-${index}${text(random, 3)}`,
        text: text(random, 40),
        score: random()
      }))
      const maxTokens = Math.floor(random() * 500)
      const capped = Recall.capRecallResults(results, maxTokens)
      const context = `seed ${seed}, maxTokens ${maxTokens}`
      expect(byteLength(JSON.stringify(capped)), context).toBeLessThanOrEqual(Math.max(2, maxTokens))
      const nonEmpty = results.filter((result) => result.text.length > 0)
      capped.forEach((result, index) => {
        expect(result.text.length, context).toBeGreaterThan(0)
        expect(nonEmpty[index]!.text.startsWith(result.text), context).toBe(true)
        if (index < capped.length - 1) expect(result).toEqual(nonEmpty[index])
      })
    }
  })
})
