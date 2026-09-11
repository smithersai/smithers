import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH
} from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createCloudSeam } from "./CloudSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The cloud session seam (lane piper step 1b): the renderer mirrors only
 * `{ state, username, expiresAt, scopes? }` — the wire answer carries no
 * token and the store row must not either. Sign-in POSTs start, opens the
 * URL through the injected openExternal door, and polls until the callback
 * lands (or the Bun side's five-minute wait expires back to signed-out).
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const TOKEN = "smithers_never_in_the_renderer"

const harness = async (route: (path: string, init?: RequestInit) => Response | Promise<Response>, timeoutMs = 2000) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: input })
      return route(input, init)
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  const opened: Array<string> = []
  const seam = createCloudSeam(ctx, {
    openExternal: async (url) => {
      opened.push(url)
      return true
    },
    pollMs: 5,
    timeoutMs
  })
  return { store, seam, requests, opened }
}

const sessionRow = (store: AppStore) => store.collections.cloudSessions.get("cloud")

describe("cloud session seam", () => {
  test("loadSession mirrors the definitive answer — and no token-shaped field", async () => {
    const { store, seam } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: "will", expiresAt: "2027-01-01T00:00:00Z", scopes: "degraded", token: TOKEN })
        : json(404, {}))
    await seam.loadSession()
    expect(sessionRow(store)).toMatchObject({
      id: "cloud",
      state: "signed-in",
      username: "will",
      expiresAt: "2027-01-01T00:00:00Z",
      scopes: "degraded"
    })
    expect(JSON.stringify(sessionRow(store))).not.toContain(TOKEN)
  })

  test("a failed read changes nothing (the seam gates on answers, not silence)", async () => {
    const { store, seam } = await harness(() => json(502, {}))
    await seam.loadSession()
    expect(sessionRow(store)?.state).toBe("unknown")
  })

  test("sign-in opens the start answer's URL and settles when the callback lands", async () => {
    let signedIn = false
    const { store, seam, requests, opened } = await harness((path, init) => {
      if (path === CLOUD_AUTH_START_PATH && init?.method === "POST") {
        queueMicrotask(() => {
          signedIn = true
        })
        return json(200, { url: "https://api.smithers-cloud.test/api/auth/github/cli?callback_port=4321" })
      }
      if (path === CLOUD_AUTH_SESSION_PATH) {
        return signedIn
          ? json(200, { state: "signed-in", username: "will", expiresAt: null })
          : json(200, { state: "signed-out", username: null, expiresAt: null })
      }
      return json(404, {})
    })
    const refusal = await seam.signIn()
    expect(refusal).toBeUndefined()
    expect(opened).toEqual(["https://api.smithers-cloud.test/api/auth/github/cli?callback_port=4321"])
    expect(sessionRow(store)?.state).toBe("signed-in")
    expect(requests[0]).toEqual({ method: "GET", url: CLOUD_AUTH_SESSION_PATH })
    expect(requests[1]).toEqual({ method: "POST", url: CLOUD_AUTH_START_PATH })
  })

  test("sign-in answers honestly when the browser step never completes", async () => {
    const { store, seam } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-out", username: null, expiresAt: null })
        : path === CLOUD_AUTH_START_PATH
        ? json(200, { url: "https://api.smithers-cloud.test/api/auth/github/cli?callback_port=1" })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("/cloud.sign-in")
    expect(sessionRow(store)?.state).toBe("signed-out")
  })

  test("sign-in is a no-op answer when the session is already signed in", async () => {
    const { seam, requests } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: "will", expiresAt: null })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(refusal).toBe("Already signed in to Smithers Cloud as will.")
    expect(requests.filter((request) => request.url === CLOUD_AUTH_START_PATH)).toEqual([])
  })

  test("sign-in mirrors and answers when already signed in with an unknown username", async () => {
    const { store, seam, requests } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: null, expiresAt: "2027-01-01T00:00:00Z" })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(refusal).toBe("Already signed in to Smithers Cloud.")
    expect(sessionRow(store)).toMatchObject({ state: "signed-in", username: null, expiresAt: "2027-01-01T00:00:00Z" })
    expect(requests.filter((request) => request.url === CLOUD_AUTH_START_PATH)).toEqual([])
  })

  for (const failure of ["network", "http", "malformed"] as const) {
    test(`sign-in stops at its deadline when session polls fail (${failure})`, async () => {
      let started = false
      const { store, seam } = await harness((path) => {
        if (path === CLOUD_AUTH_START_PATH) {
          started = true
          return json(200, { url: "https://cloud.test/login" })
        }
        if (!started) return json(200, { state: "signed-out", username: null, expiresAt: null })
        if (failure === "network") throw new Error("local service stopped")
        return failure === "http" ? json(503, {}) : json(200, { state: "invalid" })
      }, 20)
      expect(await seam.signIn()).toContain("timed out")
      expect(sessionRow(store)?.state).toBe("signed-out")
    })
  }

  test("sign-out posts the route and mirrors signed-out", async () => {
    const { store, seam, requests } = await harness((path, init) =>
      path === CLOUD_AUTH_SIGN_OUT_PATH && init?.method === "POST" ? json(200, { ok: true }) : json(404, {}))
    const refusal = await seam.signOut()
    expect(refusal).toBeUndefined()
    expect(sessionRow(store)?.state).toBe("signed-out")
    expect(requests).toEqual([{ method: "POST", url: CLOUD_AUTH_SIGN_OUT_PATH }])
  })
})
