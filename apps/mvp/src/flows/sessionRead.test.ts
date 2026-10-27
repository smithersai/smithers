// The engine worker's first session read takes the request it started as it loaded (src/flows/sessionRead.ts); every
// later read, and every other request, goes to the network.
import { describe, expect, test } from "vitest"
import { firstReadFrom } from "./sessionRead"

const SESSION = "https://smithers.test/api/auth/session"

/** A `fetch` that records what it was asked and answers each with a fresh response naming the request. */
const network = () => {
  const asked: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const href = input instanceof Request ? input.url : String(input)
    asked.push(`${init?.method ?? "GET"} ${href}`)
    return new Response(`network ${asked.length}`)
  }
  return { asked, fetch }
}

describe("the worker's first session read", () => {
  test("takes the response started as the worker loaded, once; every later read asks the network", async () => {
    const { asked, fetch } = network()
    const read = firstReadFrom(fetch, SESSION, Promise.resolve(new Response("started")))
    // The worker's HttpClient asks with a URL and its own options.
    const first = await read(new URL(SESSION), { method: "GET", signal: AbortSignal.timeout(1_000) })
    expect(await first.text()).toBe("started")
    expect(asked).toEqual([])
    expect(await (await read(new URL(SESSION))).text()).toBe("network 1")
    expect(asked).toEqual([`GET ${SESSION}`])
  })

  test("leaves the started read for the session read, whatever else is asked first", async () => {
    const { asked, fetch } = network()
    const read = firstReadFrom(fetch, SESSION, Promise.resolve(new Response("started")))
    await read("https://smithers.test/api/repos/smithersai/vibelang/refs")
    await read(SESSION, { method: "POST" })
    expect(await (await read(new Request(SESSION))).text()).toBe("started")
    expect(asked).toEqual([
      "GET https://smithers.test/api/repos/smithersai/vibelang/refs",
      `POST ${SESSION}`,
    ])
  })

  test("hands its first read the started request's failure, as a failed read of its own", async () => {
    const { fetch } = network()
    const refused = Promise.reject(new TypeError("Failed to fetch"))
    refused.catch(() => undefined)
    const read = firstReadFrom(fetch, SESSION, refused)
    await expect(read(SESSION)).rejects.toThrow("Failed to fetch")
    expect(await (await read(SESSION)).text()).toBe("network 1")
  })

  test("is the network itself when nothing was started", async () => {
    const { asked, fetch } = network()
    const read = firstReadFrom(fetch, SESSION, undefined)
    expect(await (await read(SESSION)).text()).toBe("network 1")
    expect(asked).toEqual([`GET ${SESSION}`])
  })
})
