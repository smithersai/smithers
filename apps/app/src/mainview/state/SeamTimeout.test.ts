import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { createControllerContext } from "./controller/context"
import { json, memoryStorage, unavailableAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * §22.6 / A.18: `POST /api/workflow/provision` never answered, so "Preparing
 * your … workspace…" stood past 120s with no run card, no timeout and no
 * error. A request that never answers has to become an answer.
 */

describe("a seam that never answers becomes an honest answer", () => {
  test("provisioning refuses on its own deadline instead of standing forever", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
      seamTimeoutMs: 40,
      toastDebounceMs: 10_000,
      fetchImpl: (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.includes("/api/workflow/provision")) {
          // The measured shape: the request is accepted and never answered.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
        }
        return Promise.resolve(json(404, { message: "no stub" }))
      }
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: ["will/flows"].map((fullName) => ({
        id: fullName,
        org: fullName.split("/")[0] ?? "",
        ownerKind: "user",
        name: fullName.split("/")[1] ?? "",
        head: null
      }))
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const started = Date.now()
    const outcome = await controller.commands.run("flow.create", "nightly digest will/flows")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("didn't answer in time")
  })

  test("the deadline rejects with a named seam timeout, not a message-less TimeoutError", async () => {
    /*
     * boundedFetch's deadline is the seam's own failure and has to say so:
     * `Effect.timeout` alone rejects with a TimeoutError whose `message` is
     * undefined, which reaches any caller that reports `error.message` as
     * the literal string "undefined".
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
      seamTimeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
    })
    const failure = await ctx.boundedFetch("https://app.test/api/anything", { method: "GET" }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("seam timeout")
  })
})

// Flush a partial body so fetch resolves its headers, then never send EOF.
for (const status of [200, 503]) {
  test(`the seam deadline covers a stalled HTTP ${status} body`, async () => {
    let headersReceived = false
    let signal: AbortSignal | null | undefined
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"message":')) }
      }), { status, headers: { "content-type": "application/json" } })
    })
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
      seamTimeoutMs: 500,
      fetchImpl: async (input, init) => {
        signal = init?.signal
        const response = await Bun.fetch(input, init)
        headersReceived = true
        return response
      }
    })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const started = Date.now()
      const result = await Promise.race([
        ctx.boundedFetch(`${server.url}api/test`).then(async (response) => {
          return status === 200 ? response.json() : ctx.errorMessageOf(response, "failed")
        }).catch((error: unknown) => error),
        new Promise((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 2_000) })
      ])
      expect(headersReceived).toBe(true)
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe("seam timeout")
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(signal?.aborted).toBe(true)
    } finally {
      clearTimeout(watchdog)
      await server.stop(true)
      await ctx.dispose()
    }
  })
}

test("a stalled body reader is cancelled even when the transport ignores abort", async () => {
  let cancelled = false
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
    seamTimeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise<void>(() => {}) }
    }))
  })
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      ctx.boundedFetch("https://app.test/api/test").then((response) => response.text()).catch((error: unknown) => error),
      new Promise((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 500) })
    ])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("seam timeout")
    expect(cancelled).toBe(true)
  } finally {
    clearTimeout(watchdog)
    await ctx.dispose()
  }
})

for (const status of [200, 503]) {
  test(`the seam rejects and cancels an oversized HTTP ${status} body`, async () => {
    let cancelled = false
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024))
          controller.enqueue(new Uint8Array(1))
        },
        cancel() { cancelled = true }
      }), { status })
    })
    try {
      await expect(ctx.boundedFetch("https://app.test/api/test")).rejects.toThrow("seam response exceeds 8 MiB")
      expect(cancelled).toBe(true)
    } finally {
      await ctx.dispose()
    }
  })
}

test("buffered responses retain JSON, error text, headers, and empty-body semantics", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const replies = [
    Response.json({ message: "ready ✓" }, { status: 201, statusText: "Created", headers: { "x-test": "yes" } }),
    new Response("offline", { status: 503 }),
    new Response(null, { status: 204 })
  ]
  const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
    fetchImpl: async () => replies.shift()!
  })
  try {
    const response = await ctx.boundedFetch("https://app.test/api/test")
    expect(response.status).toBe(201)
    expect(response.statusText).toBe("Created")
    expect(response.headers.get("x-test")).toBe("yes")
    expect(await response.json()).toEqual({ message: "ready ✓" })
    expect(await ctx.errorMessageOf(await ctx.boundedFetch("https://app.test/api/test"), "failed")).toBe("failed (offline)")
    const empty = await ctx.boundedFetch("https://app.test/api/test")
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    expect(await empty.text()).toBe("")
  } finally {
    await ctx.dispose()
  }
})
