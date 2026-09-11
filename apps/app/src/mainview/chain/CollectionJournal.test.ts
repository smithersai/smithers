import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import type { Outcome } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { layerCollection } from "./CollectionJournal"

/** Each test gets its own storage so cases never observe another case's writes. */
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const scripts = [
  flow(
    `const hits = await ctx.call("grep", { pattern: "TODO" })`,
    `const s = await ctx.call("author", { context: [hits.files.join("\\n")] })`,
    `return to(s)`
  ),
  flow(`await ctx.call("edit", { file: "a.ts" })`, `return done({ patched: true })`)
]

/** A catalog entry that counts executions — the "zero re-executed effects" probe. */
const countingEntry = (name: string, result: unknown) => {
  let calls = 0
  return {
    count: () => calls,
    entry: {
      name,
      description: `test entry ${name}`,
      handler: () =>
        Effect.sync(() => {
          calls += 1
          return result
        })
    }
  }
}

const runChain = (options: {
  readonly store: AppStore
  readonly lineageId: string
  readonly author: Layer.Layer<Author.Author>
  readonly entries: ReadonlyArray<Catalog.Entry>
}) =>
  Effect.runPromise(
    Chain.run({ goal: "patch TODOs" }).pipe(
      Effect.provide(
        (() => {
          const base = Layer.mergeAll(
            layerCollection({ store: options.store, lineageId: options.lineageId }),
            options.author,
            ScriptRunner.layerInProcess
          )
          return Layer.mergeAll(
            base,
            Catalog.layer(options.entries).pipe(Layer.provide(base))
          )
        })()
      )
    ) as Effect.Effect<Outcome.Terminal, never, never>
  )

describe("CollectionJournal", () => {
  test("a chain writes its journal into the chainEvents collection, in order", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const grep = countingEntry("grep", { files: ["a.ts"] })
    const edit = countingEntry("edit", { ok: true })
    const outcome = await runChain({
      store,
      lineageId: "lineage-1",
      author: Author.layerMock(scripts),
      entries: [grep.entry, edit.entry]
    })
    expect(outcome._tag).toBe("Done")
    expect(grep.count()).toBe(1)
    expect(edit.count()).toBe(1)

    const records = [...store.collections.chainEvents.values()].sort(
      (left, right) => left.seq - right.seq
    )
    expect(records.length).toBeGreaterThan(0)
    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index))
    const tags = records.map(
      (record) => (record.event as { readonly _tag: string })._tag
    )
    expect(tags[0]).toBe("ChainStarted")
    expect(tags).toContain("LinkAuthored")
    expect(tags).toContain("CallSettled")
    expect(tags.at(-1)).toBe("LinkEnded")
  })

  test("replay across store instances re-executes zero model calls and zero effects", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    const grep = countingEntry("grep", { files: ["a.ts"] })
    const edit = countingEntry("edit", { ok: true })
    const outcome = await runChain({
      store: first,
      lineageId: "lineage-replay",
      author: Author.layerMock(scripts),
      entries: [grep.entry, edit.entry]
    })
    expect(outcome._tag).toBe("Done")

    // A fresh store over the same storage is the reload: the journal is what
    // survived. An empty author mock fails the run if any model call goes
    // live; fresh counting entries prove no effect re-executes.
    const second = await createAppStore({ kind: "localStorage", storage })
    const grepAgain = countingEntry("grep", { files: ["a.ts"] })
    const editAgain = countingEntry("edit", { ok: true })
    const replayed = await runChain({
      store: second,
      lineageId: "lineage-replay",
      author: Author.layerMock([]),
      entries: [grepAgain.entry, editAgain.entry]
    })
    expect(replayed._tag).toBe("Done")
    expect(grepAgain.count()).toBe(0)
    expect(editAgain.count()).toBe(0)
  })

  test("two lineages in one store never read each other's events", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const grep = countingEntry("grep", { files: ["a.ts"] })
    const edit = countingEntry("edit", { ok: true })
    await runChain({
      store,
      lineageId: "lineage-a",
      author: Author.layerMock(scripts),
      entries: [grep.entry, edit.entry]
    })

    const other = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        return yield* journal.read
      }).pipe(
        Effect.provide(layerCollection({ store, lineageId: "lineage-b" }))
      ) as Effect.Effect<ReadonlyArray<unknown>, never, never>
    )
    expect(other).toEqual([])
  })

  test("a corrupted row fails the read as JournalError instead of feeding the chain garbage", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({
      type: "chain.event.appended",
      actor: "system",
      lineageId: "lineage-bad",
      seq: 0,
      event: { _tag: "NotAChainEvent" }
    })
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          return yield* journal.read
        })
      ).pipe(
        Effect.provide(layerCollection({ store, lineageId: "lineage-bad" }))
      ) as Effect.Effect<Journal.JournalError, never, never>
    )
    expect(error._tag).toBe("/chain/JournalError")
    expect(error.message).toContain("lineage-bad")
  })
})
