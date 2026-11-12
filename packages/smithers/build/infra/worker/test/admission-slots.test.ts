import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  type ActionCache,
  type ActionCachePublication,
  type ContentStore,
  createHandler,
  type DeleteFence,
  maxConcurrentActionCachePublications,
  maxConcurrentArtifactReads,
  maxConcurrentCacheRequests
} from "../protocol.ts"

const token = "test-token-with-sufficient-entropy-for-unit-tests"
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex")
const readTokenHash = createHash("sha256").update("a-reader-that-never-publishes", "utf8").digest("hex")
const digest = "b".repeat(64)
const keyDigest = "c".repeat(64)

/**
 * A body whose reader cannot be taken.
 *
 * `heldWhileStreaming` moves a request's admission slots onto the response
 * body, and the only way it can fail is a body that refuses a reader. A
 * `ReadableStream` subclass survives `new Response(...)` unwrapped, so this is
 * the one shape that reaches the wrapper and throws inside it.
 */
class UnreadableStream extends ReadableStream<Uint8Array> {
  constructor() {
    super({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("artifact"))
        controller.close()
      }
    })
  }

  override getReader(): never {
    throw new TypeError("the response body refused a reader")
  }
}

class EmptyActionCache implements ActionCache {
  async get(): Promise<string | null> {
    return null
  }
  async put(): Promise<"conflict" | "identical" | "inserted"> {
    return "inserted"
  }
  async delete(_key: string, _fence: DeleteFence | null): Promise<boolean> {
    return false
  }
}

class SingleEntryActionCache implements ActionCache {
  private readonly body: BodyInit

  constructor(body: BodyInit) {
    this.body = body
  }
  async get(): Promise<string | null> {
    return this.body as string
  }
  async put(_key: string, _publication: ActionCachePublication): Promise<"conflict" | "identical" | "inserted"> {
    return "identical"
  }
  async delete(_key: string, _fence: DeleteFence | null): Promise<boolean> {
    return false
  }
}

const unreadableContentStore: ContentStore = {
  async get(): Promise<{ readonly body: BodyInit } | null> {
    return { body: new UnreadableStream() }
  },
  async has(): Promise<boolean> {
    return true
  },
  async put(): Promise<"inserted" | "present"> {
    return "present"
  },
  async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    return new Set(digests)
  }
}

const request = (path: string): Request =>
  new Request(`https://cache.test${path}`, { headers: { authorization: `Bearer ${token}` } })

describe("admission slots survive a failed hand-off to the response body", () => {
  /**
   * The slots are handed to the streamed body, and the request's own `finally`
   * stands down once they are. Standing down before the hand-off succeeded
   * left both counters raised with nothing left to lower them, so a handful of
   * failures wedged the isolate at `429` for its whole lifetime.
   */
  it("readmits artifact transfers after the hand-off fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handler = createHandler({
        actionCache: new EmptyActionCache(),
        contentStore: unreadableContentStore,
        readTokenHash,
        writeTokenHash: tokenHash
      })

      // More failures than either ceiling admits: a leak of one slot per
      // failure would answer 429 well before the last one.
      const attempts = maxConcurrentCacheRequests + maxConcurrentArtifactReads + 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await handler(request(`/cas/${digest}`))
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toEqual({ error: "the cache tier failed to answer" })
      }

      // The counters are back where they started, so an ordinary request is
      // still admitted rather than refused as excess work.
      const healthy = await handler(request("/cas/findMissing"))
      expect(healthy.status).toBe(405)
    } finally {
      errors.mockRestore()
    }
  })

  /**
   * The `/ac` hit takes the same hand-off, but its body is built inside the
   * handler from stored text that `validateStoredActionBody` already refused
   * unless it was a bounded string. No action cache can reach the wrapper with
   * a body that refuses a reader, so this asserts the reachable half: a store
   * that answers with a non-string is a storage refusal, and the request slot
   * it held is returned.
   */
  it("returns the request slot when a stored body is refused before the hand-off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handler = createHandler({
        actionCache: new SingleEntryActionCache(new UnreadableStream()),
        contentStore: unreadableContentStore,
        readTokenHash,
        writeTokenHash: tokenHash
      })

      const attempts = maxConcurrentCacheRequests + 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await handler(request(`/ac/${keyDigest}`))
        expect(response.status).toBe(503)
      }

      const healthy = await handler(request("/healthz"))
      expect(healthy.status).toBe(200)
    } finally {
      errors.mockRestore()
    }
  })

  it("holds the request slot across an action-cache hit and returns it with the body", async () => {
    const handler = createHandler({
      actionCache: new SingleEntryActionCache("{\"exitOk\":true}"),
      contentStore: unreadableContentStore,
      readTokenHash,
      writeTokenHash: tokenHash
    })

    const held: Array<Response> = []
    for (let attempt = 0; attempt < maxConcurrentCacheRequests; attempt += 1) {
      const response = await handler(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(200)
      held.push(response)
    }

    // Every slot is now owned by an undrained body.
    const refused = await handler(request("/cas/findMissing"))
    expect(refused.status).toBe(429)

    await held[0]?.text()
    const admitted = await handler(request("/cas/findMissing"))
    expect(admitted.status).toBe(405)

    await Promise.all(held.slice(1).map((response) => response.text()))
  })
})


describe("admitted request cancellation and deadlines", () => {
  const dependencies = {
    actionCache: new EmptyActionCache(),
    contentStore: unreadableContentStore,
    readTokenHash,
    writeTokenHash: tokenHash
  }

  it("cancels aborted admitted uploads and returns all publication permits", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const handler = createHandler(dependencies)
    const aborters: Array<AbortController> = []
    const streams: Array<ReadableStream<Uint8Array>> = []
    const cancellations = vi.fn()
    const uploads = Array.from({ length: maxConcurrentActionCachePublications }, () => {
      const aborter = new AbortController()
      aborters.push(aborter)
      const body = new ReadableStream<Uint8Array>({ cancel: cancellations })
      streams.push(body)
      return handler(new Request(`https://cache.test/ac/${keyDigest}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: aborter.signal,
        duplex: "half"
      } as RequestInit))
    })
    try {
      await vi.waitFor(() => expect(streams.every((body) => body.locked)).toBe(true))
      aborters.forEach((aborter) => aborter.abort())
      await vi.waitFor(() => expect(cancellations).toHaveBeenCalledTimes(maxConcurrentActionCachePublications))
      expect((await Promise.all(uploads)).map((response) => response.status)).toEqual([503, 503, 503, 503])
      const next = await handler(new Request(`https://cache.test/ac/${keyDigest}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}"
      }))
      expect(next.status).toBe(201)
    } finally {
      errors.mockRestore()
    }
  })

  it("keeps 64 public readiness callers outside authenticated cache admission", async () => {
    let release!: () => void
    const health = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const handler = createHandler({ ...dependencies, health })
    const calls = Array.from({ length: maxConcurrentCacheRequests }, () =>
      handler(new Request("https://cache.test/healthz")))
    try {
      await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(1))
      const response = await handler(new Request(`https://cache.test/ac/${keyDigest}`, {
        headers: { authorization: "Bearer a-reader-that-never-publishes" }
      }))
      expect(response.status).toBe(404)
    } finally {
      release()
      await Promise.all(calls)
    }
  })

  it("bounds readiness waits without multiplying an uncancellable backend probe", async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let release!: () => void
    const health = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const handler = createHandler({ ...dependencies, health })
    let settled = 0
    try {
      const first = handler(new Request("https://cache.test/healthz")).then((response) => {
        settled += 1
        return response
      })
      await vi.advanceTimersByTimeAsync(30_001)
      expect(settled).toBe(1)
      expect((await first).status).toBe(503)
      for (let index = 0; index < 3; index += 1) {
        const retry = handler(new Request("https://cache.test/healthz"))
        await vi.advanceTimersByTimeAsync(30_001)
        expect((await retry).status).toBe(503)
      }
      expect(health).toHaveBeenCalledTimes(1)
      release()
      await vi.advanceTimersByTimeAsync(0)
      const recovered = handler(new Request("https://cache.test/healthz"))
      await vi.advanceTimersByTimeAsync(0)
      expect(health).toHaveBeenCalledTimes(2)
      release()
      expect((await recovered).status).toBe(200)
    } finally {
      release?.()
      vi.useRealTimers()
      errors.mockRestore()
    }
  })
})

describe("bounded dependency work", () => {
  it("aborts coalesced readiness only after its last caller leaves", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let cancellation: AbortSignal | undefined
    const health = vi.fn((signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      cancellation = signal
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const handler = createHandler({
      actionCache: new EmptyActionCache(), contentStore: unreadableContentStore,
      readTokenHash, writeTokenHash: tokenHash, health
    })
    const firstAbort = new AbortController()
    const lastAbort = new AbortController()
    try {
      const first = handler(new Request("https://cache.test/healthz", { signal: firstAbort.signal }))
      const last = handler(new Request("https://cache.test/healthz", { signal: lastAbort.signal }))
      await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(1))
      firstAbort.abort()
      expect((await first).status).toBe(503)
      expect(cancellation?.aborted).toBe(false)
      lastAbort.abort()
      expect((await last).status).toBe(503)
      expect(cancellation?.aborted).toBe(true)
      const retryAbort = new AbortController()
      const retry = handler(new Request("https://cache.test/healthz", { signal: retryAbort.signal }))
      await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(2))
      retryAbort.abort()
      expect((await retry).status).toBe(503)
      const preAborted = await handler(new Request("https://cache.test/healthz", { signal: retryAbort.signal }))
      expect(preAborted.status).toBe(503)
      expect(health).toHaveBeenCalledTimes(2)
    } finally {
      firstAbort.abort()
      lastAbort.abort()
      errors.mockRestore()
    }
  })

  it("releases timed-out request slots while bounding uncancellable storage and cleaning late bodies", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const releases: Array<(value: { body: BodyInit } | null) => void> = []
    const signals: Array<AbortSignal | undefined> = []
    const get = vi.fn((_digest: string, signal?: AbortSignal) => {
      signals.push(signal)
      return new Promise<{ body: BodyInit } | null>((resolve) => releases.push(resolve))
    })
    const handler = createHandler({
      actionCache: new EmptyActionCache(), contentStore: { ...unreadableContentStore, get },
      readTokenHash, writeTokenHash: tokenHash
    })
    try {
      const aborter = new AbortController()
      const aborted = handler(new Request(`https://cache.test/cas/${digest}`, {
        headers: { authorization: `Bearer ${token}` }, signal: aborter.signal
      }))
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      aborter.abort()
      expect((await aborted).status).toBe(503)
      expect(signals[0]?.aborted).toBe(true)

      vi.useFakeTimers()
      // The aborted read still holds one download permit; time out enough
      // reads to hold every other one.
      const timedOut = Array.from({ length: maxConcurrentArtifactReads - 1 }, () => handler(request(`/cas/${digest}`)))
      // Authentication uses native crypto, so wait for every dependency to
      // start before advancing its clock.
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(maxConcurrentArtifactReads))
      await vi.advanceTimersByTimeAsync(30_001)
      expect((await Promise.all(timedOut)).map((response) => response.status)).toEqual(
        Array.from({ length: maxConcurrentArtifactReads - 1 }, () => 503)
      )
      expect(signals.every((signal) => signal?.aborted === true)).toBe(true)
      expect((await handler(request(`/cas/${digest}`))).status).toBe(503)
      expect(get).toHaveBeenCalledTimes(maxConcurrentArtifactReads)
      expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(404)

      const cancelled = vi.fn()
      releases[0]?.({ body: new ReadableStream({ cancel: cancelled }) })
      for (const release of releases.slice(1)) release(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelled).toHaveBeenCalledTimes(1)
      const retry = handler(request(`/cas/${digest}`))
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(maxConcurrentArtifactReads + 1))
      releases[maxConcurrentArtifactReads]?.({ body: "artifact" })
      const response = await retry
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("artifact")
    } finally {
      vi.useRealTimers()
      errors.mockRestore()
    }
  })
})
