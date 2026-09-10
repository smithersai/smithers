import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createHandler } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

const token = "test-token-with-sufficient-entropy-for-unit-tests"
/** These cases exercise routes, not the credential split, so `token` publishes. */
const writeTokenHash = createHash("sha256").update(token, "utf8").digest("hex")
const readTokenHash = createHash("sha256").update("a-reader-that-never-publishes", "utf8").digest("hex")

const makeHandler = (contentStore = new MemoryContentStore()) =>
  createHandler({
    actionCache: new MemoryActionCache(),
    contentStore,
    readTokenHash,
    writeTokenHash
  })

const authorizedRequest = (path: string, init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  return new Request(`https://cache.test${path}`, { ...init, headers })
}

const digestOf = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

describe("remote-cache protocol", () => {
  it("authenticates every route before revealing cache state", async () => {
    const handler = makeHandler()

    const missing = await handler(new Request("https://cache.test/ac/not-present"))
    const wrong = await handler(
      new Request("https://cache.test/ac/not-present", {
        headers: { authorization: "Bearer wrong-token" }
      })
    )
    const healthWithoutToken = await handler(new Request("https://cache.test/healthz"))
    const health = await handler(authorizedRequest("/healthz"))

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toBe("")
    expect(healthWithoutToken.status).toBe(200)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true })
  })

  it("implements first-writer-wins action-cache conflict semantics", async () => {
    const handler = makeHandler()
    const keyDigest = "install-rule.cache-key"
    const original = JSON.stringify({
      key: keyDigest,
      rule: "install",
      label: "Install dependencies",
      exitOk: true,
      output: { packages: 12 },
      storedAt: "2026-08-14T00:00:00.000Z"
    })
    const reordered = JSON.stringify({
      storedAt: "2026-08-14T00:00:00.000Z",
      output: { packages: 12 },
      exitOk: true,
      label: "Install dependencies",
      rule: "install",
      key: keyDigest
    })
    const different = JSON.stringify({
      key: keyDigest,
      rule: "install",
      label: "Install dependencies",
      exitOk: true,
      output: { packages: 13 },
      storedAt: "2026-08-14T00:00:00.000Z"
    })

    const inserted = await handler(
      authorizedRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: original
      })
    )
    const identical = await handler(
      authorizedRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: reordered
      })
    )
    const conflict = await handler(
      authorizedRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: different
      })
    )
    const fetched = await handler(authorizedRequest(`/ac/${keyDigest}`))

    expect(inserted.status).toBe(201)
    await expect(inserted.json()).resolves.toEqual({ keyDigest })
    expect(identical.status).toBe(200)
    expect(conflict.status).toBe(409)
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe(original)
  })

  it("compares the result member for richer action-cache entries", async () => {
    const handler = makeHandler()
    const keyDigest = "rich-entry"
    const first = JSON.stringify({ keyDigest, result: { exitOk: true }, meta: { writer: "first" } })
    const second = JSON.stringify({ keyDigest, result: { exitOk: true }, meta: { writer: "second" } })
    const conflict = JSON.stringify({ keyDigest, result: { exitOk: false }, meta: { writer: "third" } })

    expect(
      (
        await handler(
          authorizedRequest(`/ac/${keyDigest}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: first
          })
        )
      ).status
    ).toBe(201)
    expect(
      (
        await handler(
          authorizedRequest(`/ac/${keyDigest}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: second
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handler(
          authorizedRequest(`/ac/${keyDigest}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: conflict
          })
        )
      ).status
    ).toBe(409)
  })

  it("verifies every artifact digest before publishing to CAS", async () => {
    const contentStore = new MemoryContentStore()
    const handler = makeHandler(contentStore)
    const bytes = new TextEncoder().encode("verified artifact")
    const digest = await digestOf("verified artifact")
    const wrongDigest = "0".repeat(64)

    const mismatch = await handler(
      authorizedRequest(`/cas/${wrongDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const inserted = await handler(
      authorizedRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const present = await handler(
      authorizedRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    const head = await handler(authorizedRequest(`/cas/${digest}`, { method: "HEAD" }))
    const fetched = await handler(authorizedRequest(`/cas/${digest}`))

    expect(mismatch.status).toBe(400)
    expect(await contentStore.has(wrongDigest)).toBe(false)
    expect(inserted.status).toBe(201)
    expect(present.status).toBe(200)
    expect(head.status).toBe(200)
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe("verified artifact")
  })

  it("refuses a ranged artifact upload so the client sends the blob whole", async () => {
    // `RemoteArtifacts.Options.chunkBytes` probes with an empty body under
    // `Content-Range: bytes */{total}` and reads a `400` as this service's
    // statement that it does not support partial PUT (RFC 9110 section 14.5),
    // falling back to one whole-blob `PUT`. The refusal is on the header, not
    // the digest: even a full matching body under `Content-Range` is refused.
    const contentStore = new MemoryContentStore()
    const handler = makeHandler(contentStore)
    const bytes = new TextEncoder().encode("chunked artifact")
    const digest = await digestOf("chunked artifact")

    const probe = await handler(
      authorizedRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes */${bytes.byteLength}`
        }
      })
    )
    const rangedWhole = await handler(
      authorizedRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
        },
        body: bytes
      })
    )
    expect(probe.status).toBe(400)
    expect(await probe.json()).toEqual({
      error: "content-range is not supported; send the whole blob in one request"
    })
    expect(rangedWhole.status).toBe(400)
    expect(await contentStore.has(digest)).toBe(false)

    const fallback = await handler(
      authorizedRequest(`/cas/${digest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    expect(fallback.status).toBe(201)
    expect(await contentStore.has(digest)).toBe(true)
  })

  it("returns unique missing digests in request order", async () => {
    const contentStore = new MemoryContentStore()
    const handler = makeHandler(contentStore)
    const presentDigest = await digestOf("present")
    const missingDigest = await digestOf("missing")
    await contentStore.put(presentDigest, new Uint8Array(new TextEncoder().encode("present")))

    const response = await handler(
      authorizedRequest("/cas/findMissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digests: [presentDigest, missingDigest, presentDigest] })
      })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ missing: [missingDigest] })
  })
})
