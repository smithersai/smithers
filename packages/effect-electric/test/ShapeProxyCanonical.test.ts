import { Effect, Layer, Logger } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpEffect } from "effect/http"
import { describe, expect, test } from "vitest"
import { ShapeProxy } from "../src/index.ts"

// The URL the proxy sends Electric, as a cache between them would key on it: one URL per shape and point in its log,
// whatever order or duplicates the browser sent, and never one URL for two shapes. Random cases come from a seeded
// generator, so a failure names the seed and replays exactly. No Electric needed: the fetch records the URL it was
// given, byte for byte, and answers an empty log.

const ELECTRIC_URL = "http://electric.test"

/** The URL string each request's fetch received, and a handler for `shape`. */
const proxy = (shape: ShapeProxy.Shape) => {
  const sent: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input) => {
    sent.push(input instanceof Request ? input.url : String(input))
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  }
  const handler = HttpEffect.toWebHandler(
    ShapeProxy.make({ url: ELECTRIC_URL, shape }).pipe(
      Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Logger.layer([]))),
      Effect.provideService(FetchHttpClient.Fetch, fetch)
    )
  )
  return {
    sent,
    request: async (search: string) => {
      const response = await handler(new Request(`http://app.test/api/shape?${search}`))
      await response.arrayBuffer()
      return sent.at(-1)!
    }
  }
}

/** mulberry32: a small seeded generator, so every case replays from its seed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
type Random = ReturnType<typeof random>

const pick = <A>(next: Random, items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)]!
// Characters a URL encodes, decodes or confuses: separators, escapes, spaces and pluses, brackets, non-ASCII.
const ALPHABET = ["a", "b", "z", "0", "9", "_", " ", "+", "&", "=", "%", "#", "?", "[", "]", "\"", "$", "é", "😀", ","]
const text = (next: Random, min: number, alphabet = ALPHABET) =>
  Array.from({ length: min + Math.floor(next() * 4) }, () => pick(next, alphabet)).join("")
// Electric separates columns with commas, so a column name never holds one.
const COLUMN = ALPHABET.filter((char) => char !== ",")

const shape = (next: Random): ShapeProxy.Shape => ({
  table: text(next, 1),
  ...(next() < 0.7 ? { where: text(next, 0) } : {}),
  ...(next() < 0.6 ?
    {
      params: Object.fromEntries(
        Array.from({ length: Math.floor(next() * 3) }, (_, i) => [String(i + 1), text(next, 0)])
      )
    } :
    {}),
  ...(next() < 0.5 ? { columns: Array.from({ length: Math.floor(next() * 3) }, () => text(next, 1, COLUMN)) } : {})
})

const PROTOCOL = [
  "offset",
  "handle",
  "live",
  "live_sse",
  "experimental_live_sse",
  "cursor",
  "expired_handle",
  "log",
  "cache-buster"
]
const DROPPED = ["table", "where", "params[1]", "columns", "replica", "secret", "source_id", "subset__where", "other"]

/** A browser's protocol parameters: each name once, with a value. */
const protocol = (next: Random): Array<readonly [string, string]> =>
  PROTOCOL.filter(() => next() < 0.5).map((name) => [name, text(next, 0)] as const)

const shuffle = <A>(next: Random, items: ReadonlyArray<A>): Array<A> => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * The same parameters as a different browser could send them: shuffled, with dropped parameters anywhere and later
 * duplicates of a protocol parameter, which the proxy ignores (the first value of each wins).
 */
const resend = (next: Random, parameters: ReadonlyArray<readonly [string, string]>) => {
  const shuffled = shuffle(next, [
    ...parameters,
    ...DROPPED.filter(() => next() < 0.3).map((name) => [name, text(next, 0)] as const)
  ])
  const firsts = new Set<string>()
  const out: Array<readonly [string, string]> = []
  for (const pair of shuffled) {
    out.push(pair)
    if (PROTOCOL.includes(pair[0]) && !firsts.has(pair[0])) {
      firsts.add(pair[0])
      if (next() < 0.3) out.push([pair[0], text(next, 0)])
    }
  }
  // Duplicates go after their first value, so the first value is still the one the browser meant.
  return out
}

const search = (parameters: ReadonlyArray<readonly [string, string]>) =>
  new URLSearchParams(parameters.map(([name, value]) => [name, value])).toString()

const SEEDS = Array.from({ length: 40 }, (_, i) => 0x5eed + i)

describe("the URL the proxy sends Electric", () => {
  test("sorts the parameters by name and encodes each once, the first value of each protocol parameter", async () => {
    const p = proxy({
      table: "items",
      where: "\"position\" > $1",
      params: { "1": "0 & 1" },
      columns: ["id", "position"]
    })
    const sent = await p.request(
      "live=true&table=users&offset=0_0&cursor=7&handle=h-1&offset=-1&replica=full&cache-buster=b%20c"
    )
    const query = sent.slice(sent.indexOf("?") + 1)
    expect(sent.startsWith(`${ELECTRIC_URL}/v1/shape?`)).toBe(true)
    expect([...new URLSearchParams(query)]).toEqual([
      ["cache-buster", "b c"],
      ["columns", "id,position"],
      ["cursor", "7"],
      ["handle", "h-1"],
      ["live", "true"],
      ["offset", "0_0"],
      ["params[1]", "0 & 1"],
      ["table", "items"],
      ["where", "\"position\" > $1"]
    ])
    // Re-encoding what was sent changes nothing: one encoding per value.
    expect(new URLSearchParams(query).toString()).toBe(query)
  })

  test.each(SEEDS)("seed %i: the same shape and protocol parameters in any order give one URL", async (seed) => {
    const next = random(seed)
    for (let round = 0; round < 5; round++) {
      const p = proxy(shape(next))
      const parameters = protocol(next)
      const first = await p.request(search(parameters))
      for (let again = 0; again < 4; again++) expect(await p.request(search(resend(next, parameters)))).toBe(first)
    }
  })

  test.each(SEEDS)("seed %i: two different shapes never send the same URL", async (seed) => {
    const next = random(seed)
    const parameters = protocol(next)
    const urls = new Map<string, string>()
    for (let round = 0; round < 25; round++) {
      const definition = shape(next)
      const key = JSON.stringify([
        definition.table,
        definition.where ?? null,
        Object.entries(definition.params ?? {}),
        definition.columns ?? null
      ])
      const url = await proxy(definition).request(search(resend(next, parameters)))
      const seen = [...urls].find(([, sent]) => sent === url)
      if (seen !== undefined) expect(seen[0]).toBe(key)
      urls.set(key, url)
    }
  })

  test("different protocol parameters give different URLs for the same shape", async () => {
    const p = proxy({ table: "items" })
    const urls = new Set<string>()
    for (const search of ["offset=-1", "offset=0_0", "offset=0_0&handle=h", "offset=0_0&handle=h&live=true&cursor=1"]) {
      urls.add(await p.request(search))
    }
    expect(urls.size).toBe(4)
  })
})

describe("Upstream", () => {
  test("a host's Upstream client calls Electric in place of the request's HttpClient", async () => {
    const viaUpstream: Array<string> = []
    const viaAmbient: Array<string> = []
    const upstream = HttpClient.make((request) =>
      Effect.sync(() => {
        viaUpstream.push(request.url)
        return HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 }))
      })
    )
    const ambient: typeof globalThis.fetch = async (input) => {
      viaAmbient.push(String(input))
      return new Response("[]")
    }
    const handler = HttpEffect.toWebHandler(
      ShapeProxy.make({ url: ELECTRIC_URL, shape: { table: "items" } }).pipe(
        Effect.provideService(ShapeProxy.Upstream, upstream),
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Logger.layer([]))),
        Effect.provideService(FetchHttpClient.Fetch, ambient)
      )
    )
    const response = await handler(new Request("http://app.test/api/shape?offset=-1"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("[]")
    expect(viaUpstream).toEqual([`${ELECTRIC_URL}/v1/shape`])
    expect(viaAmbient).toEqual([])
  })
})
