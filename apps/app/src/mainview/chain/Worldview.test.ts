import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createAppStore } from "../state/AppStore"
import { worldviewEntries } from "./Worldview"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>)

describe("worldview entries over worldDocuments", () => {
  test("remember creates a note with chain provenance, wikilinks, and actor smithers", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const remember = worldviewEntries(store).find((entry) => entry.name === "remember")!
    const result = (await run(
      remember.handler({
        title: "Deploy cadence",
        text: "We ship on Tuesdays. See [[Release Notes]] for history.",
        tags: ["process"],
        confidence: 0.8
      })
    )) as { readonly id: string; readonly path: string }
    expect(result.path).toBe("Deploy cadence.md")
    const document = store.collections.worldDocuments.get(result.id)
    expect(document?.body).toContain("ship on Tuesdays")
    expect(document?.links).toEqual(["Release Notes"])
    expect(document?.sources).toEqual(["chain-remember"])
    expect(document?.confidence).toBe(0.8)
    expect(document?.updatedBy).toBe("smithers")
  })

  test("remember upserts by path — same id, new body, provenance appended once", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const remember = worldviewEntries(store).find((entry) => entry.name === "remember")!
    const first = (await run(
      remember.handler({ title: "Deploy cadence", text: "Tuesdays." })
    )) as { readonly id: string }
    const second = (await run(
      remember.handler({ title: "Deploy cadence", text: "Wednesdays now." })
    )) as { readonly id: string }
    expect(second.id).toBe(first.id)
    const document = store.collections.worldDocuments.get(first.id)
    expect(document?.body).toBe("Wednesdays now.")
    expect(document?.sources.filter((source) => source === "chain-remember")).toHaveLength(1)
  })

  test("remember fails the call when the state transaction cannot persist", async () => {
    const data = new Map<string, string>()
    let rejectWrites = false
    const storage: StorageApi = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        if (rejectWrites) throw new Error("quota exhausted")
        data.set(key, value)
      },
      removeItem: (key) => void data.delete(key)
    }
    const store = await createAppStore({ kind: "localStorage", storage })
    const remember = worldviewEntries(store).find((entry) => entry.name === "remember")!
    rejectWrites = true
    const error = await Effect.runPromise(
      Effect.flip(
        remember.handler({ title: "Must persist", text: "Never acknowledge early." })
      ) as unknown as Effect.Effect<
        { readonly message: string },
        never,
        never
      >
    )
    expect(error.message).toContain("quota exhausted")
  })

  test("recall ranks title hits above body hits and answers with confidence and freshness", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const [recall, remember] = [
      worldviewEntries(store).find((entry) => entry.name === "recall")!,
      worldviewEntries(store).find((entry) => entry.name === "remember")!
    ]
    await run(remember.handler({ title: "Deploy cadence", text: "We ship weekly.", confidence: 0.9 }))
    await run(remember.handler({ title: "Meeting notes", text: "Talked about deploy risks at length." }))
    const answer = (await run(recall.handler({ query: "deploy" }))) as {
      readonly results: ReadonlyArray<{
        readonly title: string
        readonly confidence: number
        readonly updatedAt: number
        readonly snippet: string
      }>
    }
    expect(answer.results.length).toBeGreaterThanOrEqual(2)
    expect(answer.results[0]?.title).toBe("Deploy cadence")
    expect(answer.results[0]?.confidence).toBe(0.9)
    expect(answer.results[0]?.updatedAt).toBeGreaterThan(0)
    expect(answer.results[1]?.snippet).toContain("deploy risks")
  })

  test("recall answers no hits honestly and rejects an empty query typed", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const recall = worldviewEntries(store).find((entry) => entry.name === "recall")!
    const answer = (await run(recall.handler({ query: "xylophone" }))) as {
      readonly results: ReadonlyArray<unknown>
    }
    expect(answer.results).toEqual([])
    const error = await Effect.runPromise(
      Effect.flip(recall.handler({ query: "" })) as unknown as Effect.Effect<
        { readonly _tag: string },
        never,
        never
      >
    )
    expect(error._tag).toBe("/chain/CallError")
  })
})
