import { Author, Catalog, Chain, ScriptRunner } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createAppStore } from "../state/AppStore"
import { layerCollection } from "./CollectionJournal"
import { foldLineages } from "./DebugFolds"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

describe("foldLineages — the chain x-ray", () => {
  test("folds a real run into links, calls, author contexts, and outcomes", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const grep: Catalog.Entry = {
      name: "grep",
      description: "test grep",
      handler: () => Effect.succeed({ files: ["a.ts"] })
    }
    await Effect.runPromise(
      Chain.run({ goal: "find the TODOs" }).pipe(
        Effect.provide(
          (() => {
            const base = Layer.mergeAll(
              layerCollection({ store, lineageId: "debug-lineage" }),
              Author.layerMock([
                flow(
                  `const hits = await ctx.call("grep", { pattern: "TODO" })`,
                  `const s = await ctx.call("author", { context: [hits.files.join(",")] })`,
                  `return to(s)`
                ),
                flow(`return done({ patched: true })`)
              ]),
              ScriptRunner.layerInProcess
            )
            return Layer.mergeAll(base, Catalog.layer([grep]).pipe(Layer.provide(base)))
          })()
        )
      ) as Effect.Effect<unknown, never, never>
    )

    const lineages = foldLineages([...store.collections.chainEvents.values()])
    expect(lineages).toHaveLength(1)
    const lineage = lineages[0]!
    expect(lineage.lineageId).toBe("debug-lineage")
    expect(lineage.goal).toBe("find the TODOs")
    expect(lineage.links.map((link) => link.outcome)).toEqual(["To", "To", "Done"])
    const authored = lineage.links[1]!
    expect(authored.script).toContain("ctx.call(\"grep\"")
    expect(authored.scriptDigest).toBeDefined()
    expect(authored.calls.map((call) => call.name)).toEqual(["grep", "author"])
    // The two-histories view: what the next link's author was handed.
    expect(authored.authorContexts).toEqual([["a.ts"]])
  })

  test("a seq cap is the scrubber: the fold at an offset shows only the recorded prefix", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await Effect.runPromise(
      Chain.run({ goal: "small" }).pipe(
        Effect.provide(
          (() => {
            const base = Layer.mergeAll(
              layerCollection({ store, lineageId: "scrub" }),
              Author.layerMock([flow(`return done({})`)]),
              ScriptRunner.layerInProcess
            )
            return Layer.mergeAll(base, Catalog.layer([]).pipe(Layer.provide(base)))
          })()
        )
      ) as Effect.Effect<unknown, never, never>
    )
    const live = foldLineages([...store.collections.chainEvents.values()])[0]!
    const early = foldLineages([...store.collections.chainEvents.values()], 1)[0]!
    expect(early.seqCount).toBeLessThan(live.seqCount)
    expect(early.links.length).toBeLessThanOrEqual(live.links.length)
  })

  test("child-scoped events count under their derived chain id, never as root links", () => {
    const record = (seq: number, event: unknown) => ({
      id: `chain-x-${seq}`,
      lineageId: "x",
      seq,
      event,
      createdAt: seq
    })
    const lineage = foldLineages([
      record(0, { _tag: "ChainStarted", goal: "g", envelope: null }),
      record(1, {
        _tag: "CallSettled",
        chain: "1.0",
        link: 0,
        key: { ordinal: 0 },
        name: "grep",
        payload: null,
        result: null
      }),
      record(2, { _tag: "LinkEnded", chain: "1.0", link: 0, outcome: { _tag: "Done", value: null } })
    ])[0]!
    expect(lineage.links).toHaveLength(0)
    expect(lineage.children).toEqual({ "1.0": 2 })
  })
})
