import { mkdtemp, realpath, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  type PutCondition,
  memoryStateBucket,
  openRemoteState,
  r2CredentialsFromApiToken,
  r2StateBucket,
  remoteStateRequest,
  remoteStateTimeoutMs
} from "./remote-state.ts"

const credentials = { accountId: "acct", bucket: "state", accessKeyId: "key", secretAccessKey: "secret" }
const holder = { host: "test", pid: 1, startedAt: "now" }
const key = "alchemy/Stack.json"
const pending = <A>(): Promise<A> => new Promise(() => {})

describe("remote state cancellation and deadlines", () => {
  it.each([0, -1, Infinity, NaN])("refuses an invalid deadline %s before starting", async timeoutMs => {
    let started = false
    await expect(remoteStateRequest("snapshot GET", async () => { started = true }, { timeoutMs }))
      .rejects.toThrow("finite and positive")
    expect(started).toBe(false)
  })

  it("preserves synchronous failures and a caller's cancellation reason", async () => {
    const failure = new Error("transport refused")
    await expect(remoteStateRequest("GET", () => { throw failure })).rejects.toBe(failure)
    const controller = new AbortController()
    const reason = new Error("operator cancelled")
    controller.abort(reason)
    let started = false
    await expect(remoteStateRequest("GET", async () => { started = true }, { signal: controller.signal }))
      .rejects.toBe(reason)
    expect(started).toBe(false)
  })

  it("bounds an uncooperative request with the default deadline", async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const request = remoteStateRequest("snapshot GET", s => { signal = s; return pending() })
      const assertion = expect(request).rejects.toThrow("snapshot GET timed out after 30000ms")
      await vi.advanceTimersByTimeAsync(remoteStateTimeoutMs)
      await assertion
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(["GET", "PUT", "DELETE"] as const)("bounds an R2 %s before any response", async method => {
    let request: Request | undefined
    const bucket = r2StateBucket({
      ...credentials,
      timeoutMs: 20,
      fetch: async (input, init) => { request = new Request(input, init); return pending() }
    })
    const result = method === "GET" ? bucket.get(key)
      : method === "PUT" ? bucket.put(key, "{}", { ifAbsent: true }) : bucket.delete(key)
    await expect(result).rejects.toThrow("R2 state " + method + " " + key + " timed out")
    expect(request?.method).toBe(method)
    expect(request?.signal.aborted).toBe(true)
  })

  it.each([200, 403])("bounds a pending GET response body with status %s and cancels its reader", async status => {
    let cancelled = false
    let signal: AbortSignal | undefined
    const bucket = r2StateBucket({
      ...credentials,
      timeoutMs: 20,
      fetch: async (input, init) => {
        signal = new Request(input, init).signal
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("partial")) },
          cancel() { cancelled = true; return Promise.reject(new Error("cancel refused")) }
        }), { status, headers: { etag: '"v1"' } })
      }
    })
    await expect(bucket.get(key)).rejects.toThrow("R2 state GET " + key + " timed out")
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it("bounds a response whose cancellation never finishes", async () => {
    const bucket = r2StateBucket({
      ...credentials,
      timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ cancel: () => pending() }), { status: 412 })
    })
    await expect(bucket.put(key, "{}", { ifAbsent: true })).rejects.toThrow("R2 state PUT")
  })

  it("accepts an empty response and decodes split Unicode chunks", async () => {
    const bucket = r2StateBucket({
      ...credentials,
      fetch: async () => new Response(null, { headers: { etag: '"empty"' } })
    })
    expect(await bucket.get(key)).toEqual({ body: "", etag: '"empty"' })
    const bytes = new TextEncoder().encode("🌈")
    const unicode = r2StateBucket({
      ...credentials,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 2))
          controller.enqueue(bytes.slice(2))
          controller.close()
        }
      }), { headers: { etag: '"unicode"' } })
    })
    expect(await unicode.get(key)).toEqual({ body: "🌈", etag: '"unicode"' })
  })

  it("cancels a response that arrives after its caller aborted", async () => {
    const controller = new AbortController()
    let cancelled = false
    const bucket = r2StateBucket({
      ...credentials,
      fetch: async () => {
        controller.abort(new Error("operator cancelled"))
        return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { etag: '"v1"' } })
      }
    })
    await expect(bucket.get(key, controller.signal)).rejects.toThrow("operator cancelled")
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it.each(["request", "body"])("bounds token verification's pending %s without trying another endpoint", async stage => {
    let calls = 0
    let signal: AbortSignal | undefined
    let cancelled = false
    const request = r2CredentialsFromApiToken({
      apiToken: "private-token", accountId: "acct", timeoutMs: 20,
      fetch: async (input, init) => {
        calls += 1
        signal = new Request(input, init).signal
        return stage === "request" ? pending() : new Response(new ReadableStream({
          cancel() { cancelled = true }
        }))
      }
    })
    await expect(request).rejects.toThrow("Cloudflare token verification timed out")
    expect(calls).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(stage === "body")
  })

  it("releases an acquired lock after a stalled snapshot and preserves unpublished state after a stalled push", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "state-deadline-")))
    const memory = memoryStateBucket()
    try {
      const stalled = { ...memory, get: () => pending<undefined>() }
      await expect(openRemoteState({ bucket: stalled, key }, directory, holder, { timeoutMs: 20 }))
        .rejects.toThrow("remote state snapshot GET timed out")
      expect(memory.objects.has(key + ".lock")).toBe(false)
      const bucket = {
        ...memory,
        put: (k: string, body: string, condition: PutCondition, signal?: AbortSignal) =>
          k.endsWith(".lock") ? memory.put(k, body, condition, signal) : pending<boolean>()
      }
      const session = await openRemoteState({ bucket, key }, directory, holder, { timeoutMs: 20 })
      await writeFile(join(directory, "Resource.json"), "{}")
      await expect(session.push()).rejects.toThrow("remote state snapshot PUT timed out")
      await expect(access(join(directory, ".smithers-unpublished-state"))).resolves.toBeUndefined()
      await session.release()
      expect(memory.objects.has(key + ".lock")).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("reports successful PUT ownership even when disposal never finishes", async () => {
    let cancelled = false
    const bucket = r2StateBucket({
      ...credentials, timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; return pending() }
      }))
    })
    expect(await bucket.put(key, "{}", { ifAbsent: true })).toBe(true)
    expect(cancelled).toBe(true)
  })

  it("handles a refused disposal after a successful PUT", async () => {
    const bucket = r2StateBucket({
      ...credentials,
      fetch: async () => new Response(new ReadableStream({
        cancel: () => Promise.reject(new Error("disposal refused"))
      }))
    })
    expect(await bucket.put(key, "{}", { ifAbsent: true })).toBe(true)
  })

  it("reconciles a timed-out lock acquisition that committed before its response stalled", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "state-acquire-deadline-")))
    const memory = memoryStateBucket()
    let acquisitionSignal: AbortSignal | undefined
    let cleanupSignal: AbortSignal | undefined
    try {
      const bucket = {
        ...memory,
        put: async (k: string, body: string, condition: PutCondition, signal?: AbortSignal) => {
          await memory.put(k, body, condition)
          acquisitionSignal = signal
          return pending<boolean>()
        },
        delete: async (k: string, signal?: AbortSignal) => {
          cleanupSignal = signal
          expect(signal?.aborted).toBe(false)
          await memory.delete(k)
        }
      }
      await expect(openRemoteState({ bucket, key }, directory, holder, { timeoutMs: 20 }))
        .rejects.toThrow("remote state lock PUT timed out")
      expect(acquisitionSignal?.aborted).toBe(true)
      expect(cleanupSignal).toBeDefined()
      expect(memory.objects.size).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(["absent", "foreign", "unreadable", "cancelled"] as const)(
    "reconciles an uncertain acquisition with %s ownership without deleting a foreign lock", async state => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "state-acquire-refusal-")))
      const memory = memoryStateBucket()
      const failure = new Error("lock write response failed")
      const controller = new AbortController()
      if (state === "foreign") await memory.put(key + ".lock", JSON.stringify({ ...holder, pid: 2 }), { ifAbsent: true })
      if (state === "cancelled") controller.abort(failure)
      let deletes = 0
      try {
        const result = openRemoteState({
          key, bucket: {
            ...memory,
            put: async () => { throw failure },
            get: async k => {
              if (state === "unreadable") throw new Error("ownership read failed")
              return memory.get(k)
            },
            delete: async () => { deletes += 1 }
          }
        }, directory, holder, { signal: controller.signal })
        if (state === "unreadable") {
          await expect(result).rejects.toThrow("lock write response failed; Remote Alchemy state lock was not released: ownership read failed")
        } else await expect(result).rejects.toBe(failure)
        expect(deletes).toBe(0)
        expect(memory.objects.size).toBe(state === "foreign" ? 1 : 0)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it("distinguishes two acquisition attempts with identical holder diagnostics", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "state-same-holder-")))
    const memory = memoryStateBucket()
    const first = await openRemoteState({ bucket: memory, key }, directory, holder)
    const original = memory.objects.get(key + ".lock")
    const failure = new Error("second acquisition response lost")
    try {
      await expect(openRemoteState({
        key, bucket: { ...memory, put: async () => { throw failure } }
      }, directory, holder)).rejects.toBe(failure)
      expect(memory.objects.get(key + ".lock")).toBe(original)
    } finally {
      await first.release()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not delete another deployment's lock when reading its holder stalls", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "state-holder-deadline-")))
    const memory = memoryStateBucket()
    await memory.put(key + ".lock", JSON.stringify(holder), { ifAbsent: true })
    try {
      await expect(openRemoteState({
        key, bucket: { ...memory, get: () => pending<undefined>() }
      }, directory, holder, { timeoutMs: 20 })).rejects.toThrow("remote state lock GET timed out")
      expect(memory.objects.has(key + ".lock")).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
