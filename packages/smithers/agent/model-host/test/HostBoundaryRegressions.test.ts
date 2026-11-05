import { Clock, Context, Effect, Exit, Scope } from "effect"
import { createServer, type RequestListener } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "vitest"
import { createHostDiagnostics } from "../src/HostDiagnostics.ts"
import { type DurableChatGrant, DurableChatProducer } from "./fixtures/durable.ts"
import { sourceLister, sourceReader } from "./fixtures/durable.ts"

const grant: DurableChatGrant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "producer-capability",
  expiresAt: "2099-01-01T00:00:00Z",
  producerBaseUrl: "http://127.0.0.1",
  cursor: { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) },
  request: { runId: "run", instructions: "answer", messages: [] }
}

const withRecorder = async (
  run: (diagnostics: ReturnType<typeof createHostDiagnostics>, lines: Array<Record<string, unknown>>) => void
) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const lines: Array<Record<string, unknown>> = []
    const diagnostics = createHostDiagnostics({
      runtime: { clock: yield* Clock.Clock, scope: yield* Scope.Scope },
      write: (line) => lines.push(JSON.parse(line)),
      clock: () => 0,
      detailLimit: 0
    })
    run(diagnostics, lines)
  })))
}

test("diagnostic event and phase reject content and oversized labels", async () => {
  await withRecorder((diagnostics, lines) => {
    for (const value of ["private prompt text", "https://secret.example", "x".repeat(10_000)]) {
      diagnostics.record(value, "start")
      diagnostics.record("model_stream", value)
    }
    expect(JSON.stringify(lines)).not.toContain("private prompt text")
    expect(JSON.stringify(lines)).not.toContain("secret.example")
    expect(JSON.stringify(lines).length).toBeLessThan(2_000)
  })
})

test("diagnostics refuse credentials even when their characters fit the token pattern", async () => {
  await withRecorder((diagnostics, lines) => {
    diagnostics.record("model_stream", "first_event", {
      authorization: "sk-live-private123",
      secret: "opaque_token_123",
      kind: "opaque_token_123",
      "sk-live-private123": true,
      token: 123,
      events: 1
    })
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain("sk-live-private123")
    expect(raw).not.toContain("opaque_token_123")
    expect(lines[0]).toMatchObject({ events: 1, droppedFields: 5 })
  })
})

const ObservationContext = Context.Reference<string>("test/ObservationContext", { defaultValue: () => "default" })

test("diagnostic observation inherits the caller's Effect context", async () => {
  const observed: string[] = []
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const clock = yield* Clock.Clock
      const diagnostics = createHostDiagnostics({
        runtime: {
          clock: {
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanos: clock.monotonicTimeNanos,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: () => Effect.andThen(Effect.map(ObservationContext, (value) => observed.push(value)), Effect.never)
          },
          scope: yield* Scope.Scope
        },
        write: () => {}
      })
      yield* diagnostics.begin("chat_callback")
      yield* Effect.yieldNow
      expect(observed).toEqual(["host-context"])
    })).pipe(Effect.provideService(ObservationContext, "host-context"))
  )
})

test("fast failed observations survive the detail limit", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const lines: Array<Record<string, unknown>> = []
    const diagnostics = createHostDiagnostics({
      runtime: { clock: yield* Clock.Clock, scope: yield* Scope.Scope },
      write: (line) => lines.push(JSON.parse(line)),
      clock: () => 0,
      detailLimit: 0
    })
    for (const status of [0, 403, 500]) {
      const settle = yield* diagnostics.begin("chat_callback")
      settle({ status })
    }
    expect(lines.map((line) => line.status)).toEqual([0, 403, 500])
  })))
})

const listen = async (handler: RequestListener) => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}
const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve) => server.close(() => resolve()))

test("capability-bearing source callbacks refuse redirects before reaching another endpoint", async () => {
  const leaked: string[] = []
  const target = await listen((request, response) => {
    leaked.push(request.headers.authorization ?? "")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({ repository: "acme/app", path: "", commit: "a".repeat(40), entries: [], truncated: false })
    )
  })
  const source = await listen((_request, response) => {
    response.writeHead(307, { location: `${target.url}/stolen` })
    response.end()
  })
  try {
    for (const make of [sourceReader, sourceLister]) {
      expect(await Effect.runPromise<unknown, never>(make(source.url, grant, globalThis.fetch)(""))).toEqual({
        code: "call_refused"
      })
    }
    expect(leaked).toEqual([])
  } finally {
    await Promise.all([close(source.server), close(target.server)])
  }
})

test("source callbacks bound response bytes before parsing schema-valid oversized JSON", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({ repository: "acme/app", path: "", commit: "a".repeat(40), entries: [], truncated: false }) +
        " ".repeat(4 * 1024 * 1024)
    )
  })
  try {
    const answer = await Effect.runPromise(sourceLister(server.url, grant, globalThis.fetch)(""))
    expect(answer).toEqual({ code: "invalid_answer" })
  } finally {
    await close(server.server)
  }
})

test("unknown observation labels cannot enter pending or completion records", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const lines: string[] = []
    const diagnostics = createHostDiagnostics({
      runtime: { clock: yield* Clock.Clock, scope: yield* Scope.Scope },
      write: (line) => lines.push(line)
    })
    const settle = yield* diagnostics.begin("sk-private-token", { status: 200 })
    settle()
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => !line.includes("sk-private-token"))).toBe(true)
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["diagnostics", "diagnostics"])
  })))
})

test("source callbacks distinguish absent bodies from JSON refusal bodies", async () => {
  let emptyStatus = 204
  const server = await listen((request, response) => {
    const absent = request.headers["x-case"] === "absent"
    const status = absent ? emptyStatus : 404
    response.writeHead(status, { "content-type": "application/json" })
    response.end(absent ? undefined : JSON.stringify({ code: 123 }))
  })
  try {
    expect(await Effect.runPromise(sourceReader(server.url, grant, globalThis.fetch)("README.md")))
      .toEqual({ code: "status_404" })
    const fetchAbsent: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-case": "absent" }
      })) as typeof globalThis.fetch
    expect(await Effect.runPromise(sourceReader(server.url, grant, fetchAbsent)("README.md")))
      .toEqual({ code: "invalid_answer" })
    emptyStatus = 404
    expect(await Effect.runPromise(sourceReader(server.url, grant, fetchAbsent)("README.md")))
      .toEqual({ code: "status_404" })
  } finally {
    await close(server.server)
  }
})

test("source response limits count multibyte UTF-8 and admit exactly the byte bound", async () => {
  const bound = 4 * 1024 * 1024
  const base = { repository: "acme/app", path: "README.md", commit: "a".repeat(40), content: "", binary: false }
  const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength
  let length = bound
  const server = await listen((_request, response) => {
    const available = length - overhead
    const content = "é".repeat(Math.floor(available / 2)) + (available % 2 === 0 ? "" : "x")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ...base, content }))
  })
  try {
    const answer = await Effect.runPromise(sourceReader(server.url, grant, globalThis.fetch)(base.path))
    expect("file" in answer).toBe(true)
    if ("file" in answer) expect(new TextEncoder().encode(JSON.stringify(answer.file))).toHaveLength(bound)
    length = bound + 1
    expect(await Effect.runPromise(sourceReader(server.url, grant, globalThis.fetch)(base.path)))
      .toEqual({ code: "invalid_answer" })
  } finally {
    await close(server.server)
  }
})

test("fast failed receipts remain observable even when HTTP answered 200", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const lines: Array<Record<string, unknown>> = []
      const diagnostics = createHostDiagnostics({
        runtime: { clock: yield* Clock.Clock, scope: yield* Scope.Scope },
        write: (line) => lines.push(JSON.parse(line)),
        detailLimit: 0,
        slowMillis: 1_000_000
      })
      const producer = new DurableChatProducer(server.url, grant, globalThis.fetch, diagnostics)
      const exit = yield* Effect.exit(producer.write({ runId: "run", type: "delta", kind: "text", text: "hello" }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(lines).toEqual([
        expect.objectContaining({ phase: "end", status: 200, failed: true })
      ])
    })))
  } finally {
    await close(server.server)
  }
})

test("a fast receipt integrity failure remains visible after the detail limit", async () => {
  const frame = { runId: "run", type: "delta" as const, kind: "text" as const, text: "hello" }
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      status: "committed",
      batch: {
        version: 1,
        runId: "run",
        legId: "leg",
        batch: 1,
        from: 1,
        previousHash: grant.cursor.hash,
        frames: [frame],
        hash: "0".repeat(64)
      },
      cursor: { ...grant.cursor, batch: 1, position: 1, hash: "0".repeat(64) }
    }))
  })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const lines: Array<Record<string, unknown>> = []
      const diagnostics = createHostDiagnostics({
        runtime: { clock: yield* Clock.Clock, scope: yield* Scope.Scope },
        write: (line) => lines.push(JSON.parse(line)),
        detailLimit: 0,
        slowMillis: 1_000_000
      })
      const exit = yield* Effect.exit(
        new DurableChatProducer(server.url, grant, globalThis.fetch, diagnostics).write(frame)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(lines).toEqual([expect.objectContaining({ event: "chat_callback", phase: "refused", failed: true })])
    })))
  } finally {
    await close(server.server)
  }
})
