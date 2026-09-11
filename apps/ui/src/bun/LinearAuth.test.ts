import { describe, expect, test } from "bun:test"
import { createLinearAuth } from "./LinearAuth"

/*
 * The Linear OAuth handoff (lane sync, ADR 0005): start answers the OAuth
 * URL through the local cloud proxy with callback_port attached; the first
 * well-formed callback claims the attempt and the session answers the setup
 * key; a replay answers 409; a new start supersedes a stale key. The
 * listener answers only a GET on its exact loopback Host, from no foreign
 * Origin, carrying the attempt's own handoff random.
 */

const auth = (options: { readonly waitTimeoutMs?: number } = {}) =>
  createLinearAuth({ origin: () => "http://127.0.0.1:9999", log: () => {}, ...options })

const callbackPort = (url: string): string => new URL(url).searchParams.get("callback_port") ?? ""
const handoffOf = (url: string): string => new URL(url).searchParams.get("handoff") ?? ""
const callbackUrl = (started: string, setup: string, handoff = handoffOf(started)): string =>
  `http://127.0.0.1:${callbackPort(started)}/callback?${new URLSearchParams({ setup, handoff })}`

describe("the Linear OAuth handoff on the local origin", () => {
  test("start answers the proxied OAuth URL with callback_port, idle until then", async () => {
    const handoff = auth()
    expect(handoff.session()).toEqual({ state: "idle" })
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const parsed = new URL(started.url)
    expect(`${parsed.origin}${parsed.pathname}`).toBe("http://127.0.0.1:9999/api/cloud/api/auth/linear")
    expect(callbackPort(started.url)).not.toBe("")
    expect(handoff.session()).toEqual({ state: "waiting" })
    await handoff.stop()
  })

  test("the callback records the setup key and the session answers it, once", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const page = await fetch(callbackUrl(started.url, "setup-key-1"))
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("return to Smithers")
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    // A replay can no longer substitute the key.
    const replay = await fetch(callbackUrl(started.url, "setup-key-2"))
    expect(replay.status).toBe(409)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    await handoff.stop()
  })

  test("a callback without a setup key is refused, and other paths 404", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const port = callbackPort(started.url)
    expect((await fetch(`http://127.0.0.1:${port}/callback?handoff=${handoffOf(started.url)}`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere?setup=x`)).status).toBe(404)
    expect(handoff.session()).toEqual({ state: "waiting" })
    await handoff.stop()
  })

  test("a new start supersedes a stale key and the old listener dies", async () => {
    const handoff = auth()
    const first = await handoff.start()
    if ("error" in first) throw new Error(first.error)
    await fetch(callbackUrl(first.url, "stale"))
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "stale" })
    const second = await handoff.start()
    if ("error" in second) throw new Error(second.error)
    expect(handoff.session()).toEqual({ state: "waiting" })
    // The first listener is closed; its port answers nothing now.
    await expect(fetch(callbackUrl(first.url, "stale-2"))).rejects.toThrow()
    await fetch(callbackUrl(second.url, "fresh"))
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "fresh" })
    await handoff.stop()
  })

  test("a foreign page cannot plant its own key", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const url = callbackUrl(started.url, "attacker-key")
    const refusals: ReadonlyArray<readonly [string, Promise<Response>]> = [
      ["foreign origin", fetch(url, { headers: { origin: "https://evil.example" } })],
      ["null origin", fetch(url, { headers: { origin: "null" } })],
      ["wrong handoff", fetch(callbackUrl(started.url, "attacker-key", "x".repeat(handoffOf(started.url).length)))],
      ["short handoff", fetch(callbackUrl(started.url, "attacker-key", "short"))],
      ["missing handoff", fetch(`http://127.0.0.1:${callbackPort(started.url)}/callback?setup=attacker-key`)],
      ["rebound host", fetch(url, { headers: { host: `evil.example:${callbackPort(started.url)}` } })],
      ["localhost host", fetch(url, { headers: { host: `localhost:${callbackPort(started.url)}` } })],
      ["post", fetch(url, { method: "POST" })]
    ]
    for (const [name, response] of refusals) {
      const status = (await response).status
      expect({ name, refused: status >= 400 }).toEqual({ name, refused: true })
      expect(handoff.session()).toEqual({ state: "waiting" })
    }
    await handoff.stop()
  })

  test("the attempt's own origin and handoff succeed, and a replay is refused", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const local = `http://127.0.0.1:${callbackPort(started.url)}`
    const page = await fetch(callbackUrl(started.url, "setup-key-1"), { headers: { origin: local } })
    expect(page.status).toBe(200)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    const replay = await fetch(callbackUrl(started.url, "setup-key-1"))
    expect(replay.status).toBe(409)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    await handoff.stop()
  })

  test("an expired attempt returns to idle", async () => {
    const handoff = auth({ waitTimeoutMs: 20 })
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    expect(handoff.session()).toEqual({ state: "waiting" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(handoff.session()).toEqual({ state: "idle" })
    await handoff.stop()
  })
})
