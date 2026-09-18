import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createAppStore } from "../state/AppStore"
import { RECALL_SHORTLIST_MAX, worldviewEntries } from "./Worldview"

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

/** A relay double: every call is recorded, and an unbound relay throws rather than reaching a network. */
const relayOf = (answer?: (body: RelayBody) => Response) => {
  const bodies: Array<RelayBody> = []
  const urls: Array<string> = []
  return {
    bodies,
    urls,
    seam: {
      baseUrl: "https://mvp.test",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input))
        const body = JSON.parse(String(init?.body)) as RelayBody
        bodies.push(body)
        if (answer === undefined) throw new Error("the relay must not be asked")
        return answer(body)
      }
    }
  }
}

interface RelayBody {
  readonly state: { readonly query: string; readonly documents: ReadonlyArray<Record<string, unknown>> }
  readonly questions: Record<string, { readonly type: string; readonly instructions: string; readonly criteria?: unknown }>
}

/** The relay's 200: an `order` choice and a `covered` boolean, as the route answers them. */
const decided = (probabilities: Record<string, number>, coveredProbability: number): Response =>
  new Response(
    JSON.stringify({
      answers: {
        order: {
          type: "choice",
          choice: Object.entries(probabilities).sort(([, left], [, right]) => right - left)[0]?.[0] ?? "",
          probabilities
        },
        covered: { type: "boolean", probability: coveredProbability }
      },
      model: "typesafe-ai/jev"
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )

const NO_RELAY = { baseUrl: "https://mvp.test", fetchImpl: async () => {
  throw new Error("the relay must not be asked")
} }

interface Recalled {
  readonly covered: boolean
  readonly results: ReadonlyArray<{ readonly path: string; readonly title: string; readonly snippet: string }>
}

describe("worldview entries over worldDocuments", () => {
  test("remember creates a note with chain provenance, wikilinks, and actor smithers", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const remember = worldviewEntries(store, NO_RELAY).find((entry) => entry.name === "remember")!
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
    const remember = worldviewEntries(store, NO_RELAY).find((entry) => entry.name === "remember")!
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
    const remember = worldviewEntries(store, NO_RELAY).find((entry) => entry.name === "remember")!
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

  test("recall rejects an empty query typed, before any relay", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const recall = worldviewEntries(store, NO_RELAY).find((entry) => entry.name === "recall")!
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

/*
 * recall's second stage. The keyword scorer only shortlists; Jev decides the
 * order and whether the wiki covers the query at all, and a relay that does
 * not answer fails the door rather than handing back the keyword order.
 */
describe("recall reranks its keyword shortlist through the Jev relay", () => {
  /** A store holding `titles`, each with a body that mentions the query word. */
  const wikiOf = async (titles: ReadonlyArray<string>) => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const remember = worldviewEntries(store, NO_RELAY).find((entry) => entry.name === "remember")!
    for (const title of titles) {
      await run(remember.handler({ title, text: `Notes about deploy in ${title}.` }))
    }
    return store
  }

  test("the order follows Jev's probabilities, not the keyword score, and zero-probability documents are dropped", async () => {
    const store = await wikiOf(["Deploy cadence", "Meeting notes", "Old plan"])
    const relay = relayOf(() => decided({ "Meeting notes.md": 0.7, "Deploy cadence.md": 0.2, "Old plan.md": 0 }, 0.9))
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    const answer = (await run(recall.handler({ query: "deploy" }))) as Recalled
    // The keyword scorer puts "Deploy cadence" first (a title hit); Jev's order wins.
    expect(answer.results.map((hit) => hit.path)).toEqual(["Meeting notes.md", "Deploy cadence.md"])
    expect(answer.covered).toBe(true)
    expect(relay.urls).toEqual(["https://mvp.test/api/jev"])
  })

  test("a covered probability below the threshold says the wiki does not cover the query, ranked list still attached", async () => {
    const store = await wikiOf(["Deploy cadence", "Meeting notes"])
    const relay = relayOf(() => decided({ "Deploy cadence.md": 0.6, "Meeting notes.md": 0.4 }, 0.49))
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    const answer = (await run(recall.handler({ query: "deploy" }))) as Recalled
    expect(answer.covered).toBe(false)
    expect(answer.results.map((hit) => hit.path)).toEqual(["Deploy cadence.md", "Meeting notes.md"])
  })

  test("a relay 503 fails the door with the refusal's code, never the keyword order", async () => {
    const store = await wikiOf(["Deploy cadence"])
    const relay = relayOf(() =>
      new Response(
        JSON.stringify({ status: "error", code: "service_temporarily_unavailable", message: "Jev answered HTTP 502." }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    )
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    const error = await Effect.runPromise(
      Effect.flip(recall.handler({ query: "deploy" })) as unknown as Effect.Effect<
        { readonly _tag: string; readonly message: string; readonly cause?: string },
        never,
        never
      >
    )
    expect(error._tag).toBe("/chain/CallError")
    expect(error.cause).toBe("service_temporarily_unavailable")
    expect(error.message).toContain("Jev answered HTTP 502.")
  })

  test("a relay that cannot be reached fails the door typed", async () => {
    const store = await wikiOf(["Deploy cadence"])
    const recall = worldviewEntries(store, {
      baseUrl: "https://mvp.test",
      fetchImpl: async () => {
        throw new Error("connection reset")
      }
    }).find((entry) => entry.name === "recall")!
    const error = await Effect.runPromise(
      Effect.flip(recall.handler({ query: "deploy" })) as unknown as Effect.Effect<
        { readonly cause?: string; readonly message: string },
        never,
        never
      >
    )
    expect(error.cause).toBe("jev_unreachable")
    expect(error.message).toContain("connection reset")
  })

  test("an answer missing either question fails the door rather than ranking half a decision", async () => {
    const store = await wikiOf(["Deploy cadence"])
    const relay = relayOf(() =>
      new Response(JSON.stringify({ answers: { order: { type: "choice", choice: "Deploy cadence.md" } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    )
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    const error = await Effect.runPromise(
      Effect.flip(recall.handler({ query: "deploy" })) as unknown as Effect.Effect<
        { readonly cause?: string },
        never,
        never
      >
    )
    expect(error.cause).toBe("jev_undecided")
  })

  test("an empty wiki answers the empty result and never asks the relay", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const relay = relayOf()
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    const answer = (await run(recall.handler({ query: "deploy" }))) as Recalled
    expect(answer).toEqual({ covered: false, results: [] })
    expect(relay.bodies).toEqual([])

    // A wiki that holds notes but none the keyword pass matches is the same:
    // nothing to order is not a decision.
    const stocked = await wikiOf(["Deploy cadence"])
    const second = relayOf()
    const missing = worldviewEntries(stocked, second.seam).find((entry) => entry.name === "recall")!
    expect(await run(missing.handler({ query: "xylophone" }))).toEqual({ covered: false, results: [] })
    expect(second.bodies).toEqual([])
  })

  test("the outbound body carries at most the shortlist cap, with ids, titles and snippets only", async () => {
    const store = await wikiOf(Array.from({ length: RECALL_SHORTLIST_MAX + 5 }, (_, index) => `Note ${index}`))
    const relay = relayOf((body) => decided({ [Object.keys(body.questions["order"]!.criteria as object)[0]!]: 1 }, 0.9))
    const recall = worldviewEntries(store, relay.seam).find((entry) => entry.name === "recall")!
    await run(recall.handler({ query: "deploy" }))
    const sent = relay.bodies[0]!
    expect(sent.state.query).toBe("deploy")
    const options = sent.questions["order"]!.criteria as Record<string, string>
    expect(Object.keys(options).length).toBe(RECALL_SHORTLIST_MAX)
    expect(sent.state.documents.length).toBe(RECALL_SHORTLIST_MAX)
    // Ids, titles and the 200-character keyword snippet; no document body.
    for (const document of sent.state.documents) {
      expect(Object.keys(document).sort()).toEqual(["id", "snippet", "title"])
      expect(String(document["snippet"]).length).toBeLessThanOrEqual(200)
    }
    expect(sent.questions["order"]!.type).toBe("choice")
    expect(sent.questions["order"]!.instructions).toBe("Which document best answers the query?")
    expect(sent.questions["covered"]!.type).toBe("boolean")
    expect(sent.questions["covered"]!.instructions).toBe("Does any of these documents answer the query?")
  })
})
