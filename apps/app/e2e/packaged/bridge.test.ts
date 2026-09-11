import { afterEach, expect, test } from "bun:test"
import { PackagedApp } from "./PackagedApp"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const client = (): Pick<PackagedApp, "eval" | "evalReadOnly" | "screenshot"> & {
  json<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T>
} => Object.create(PackagedApp.prototype, {
  bridgeToken: { value: "test-only" },
  bridgeOrigin: { value: "http://127.0.0.1:1" },
  artifactsDirectory: { value: "/unused-stalled-screenshot" }
})

for (const scenario of ["success", "error", "screenshot"] as const) {
  test(`the deadline includes a stalled ${scenario} body`, async () => {
    const app = client()
    let body: ReadableStream<Uint8Array> | undefined
    let signal: AbortSignal | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      signal = init!.signal!
      body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          value.enqueue(new TextEncoder().encode("{"))
          signal!.addEventListener("abort", () => value.error(new Error("aborted")), { once: true })
        }
      })
      return new Response(body, { status: scenario === "error" ? 500 : 200 })
    }) as unknown as typeof fetch
    const pending = (scenario === "screenshot" ? app.screenshot() : app.json("/state", {}, 20))
      .then(() => "resolved", (error: Error) => error.message)
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), scenario === "screenshot" ? 5300 : 100))
      ])
      expect(result).toContain("timed out after")
      expect(signal?.aborted).toBe(true)
      expect(body?.locked).toBe(false)
    } finally {
      controller?.error(new Error("test cleanup"))
      await pending
    }
  }, 10_000)
}

test("a mutation with a lost renderer reply executes once and reports ambiguity", async () => {
  let executions = 0
  globalThis.fetch = (async () => {
    executions += 1
    return executions === 1
      ? new Response('{"message":"RPC request timed out."}', { status: 504 })
      : Response.json({ result: "ok" })
  }) as unknown as typeof fetch
  const result = await client().eval('document.querySelector("button").click()')
    .then(() => "resolved", (error: Error) => error.message)
  expect(executions).toBe(1)
  expect(result).toContain("outcome is unknown")
})

test("only explicitly read-only evaluations retry a lost reply", async () => {
  const bodies: Array<string> = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return bodies.length === 1
      ? new Response('{"message":"RPC request timed out."}', { status: 500 })
      : Response.json({ result: "ready" })
  }) as unknown as typeof fetch
  expect(await client().evalReadOnly<string>("document.readyState")).toBe("ready")
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe(bodies[1])
})

test("read-only retries do not swallow renderer errors", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{"message":"renderer exploded"}', { status: 500 })
  }) as unknown as typeof fetch
  await expect(client().evalReadOnly("throw new Error('renderer exploded')")).rejects.toThrow("renderer exploded")
  expect(calls).toBe(1)
})

test("a stalled body cannot exceed the read-only retry budget even if the transport ignores abort", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch
  const pending = client().evalReadOnly("document.readyState", 20)
    .then(() => "resolved", (error: Error) => error.message)
  let boundary: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => { boundary = setTimeout(() => resolve("still pending"), 200) })
    ])
    expect(result).toContain("did not recover within 20ms")
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  } finally {
    clearTimeout(boundary)
    await body.cancel()
    await pending
  }
})

for (const scenario of ["success", "invalid JSON", "HTTP error"] as const) {
  test(`releases the reader and deadline after ${scenario}`, async () => {
    let signal: AbortSignal | undefined
    const response = new Response(scenario === "success" ? '{"answer":42}' : "broken", {
      status: scenario === "HTTP error" ? 503 : 200
    })
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      signal = init!.signal!
      return response
    }) as unknown as typeof fetch
    const pending = client().json("/state", {}, 20)
    if (scenario === "success") expect(await pending).toEqual({ answer: 42 })
    else await expect(pending).rejects.toThrow(scenario === "HTTP error" ? "returned 503: broken" : "JSON")
    expect(response.body?.locked).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal?.aborted).toBe(false)
  })
}

test("a successful evaluation preserves undefined and statement-shaped scripts", async () => {
  let script: string | undefined
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    script = JSON.parse(String(init?.body)).script
    return Response.json({ result: null, valueUndefined: true })
  }) as unknown as typeof fetch
  expect(await client().eval("return undefined")).toBeUndefined()
  expect(script).toBe("return undefined")
})
