/* The terminal transport against a real WebSocket server. */
import { afterEach, expect, test } from "bun:test"
import { createPtyClient } from "./PtyClient"

interface Harness {
  readonly url: string
  readonly seen: Array<Record<string, unknown>>
  readonly acknowledge: (sessionId: string) => void
  readonly output: (sessionId: string, data: string) => void
  readonly frame: (value: unknown) => void
  readonly stop: () => void
}

const harnesses: Array<Harness> = []

const serve = (): Harness => {
  const seen: Array<Record<string, unknown>> = []
  const open = new Set<{ send: (data: string) => void }>()
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => self.upgrade(request) ? undefined : new Response("no"),
    websocket: {
      open: (socket) => {
        open.add(socket as never)
      },
      close: (socket) => void open.delete(socket as never),
      message: (_socket, message) => {
        seen.push(JSON.parse(String(message)) as Record<string, unknown>)
      }
    }
  })
  const harness: Harness = {
    url: `ws://127.0.0.1:${server.port}/ws`,
    seen,
    acknowledge: (sessionId) => {
      for (const socket of open) socket.send(JSON.stringify({ type: "subscribed", topic: `pty:${sessionId}` }))
    },
    output: (sessionId, data) => {
      for (const socket of open) socket.send(JSON.stringify({ type: "pty.output", sessionId, data }))
    },
    frame: (value) => { for (const socket of open) socket.send(JSON.stringify(value)) },
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not pass")
    await Bun.sleep(5)
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
})

test("status shares the terminal subscription, is ordered, validates subject identity, and seeds a late view", async () => {
  const server = serve()
  const observed: unknown[] = [], first: unknown[] = [], second: unknown[] = []
  const client = createPtyClient({ baseUrl: "http://127.0.0.1", http: fetch, socketUrl: () => server.url,
    onStatus: (sessionId, status) => observed.push({ sessionId, status }) })
  const detach = client.attach("pty-1", { onOutput: () => {}, onExit: () => {}, onStatus: (status) => first.push(status) })
  await until(() => server.seen.some((frame) => frame.type === "subscribe"))
  const status = { subjectId: "session:pty-1", state: "running", activity: "idle", health: "healthy", attention: "none", freshness: "fresh", updatedAt: 10,
    provenance: { checkerId: "semantic", monitorId: "monitor", incarnation: "owner", evidenceSeq: 3, version: 5, observedAt: 10, expiresAt: 100 } }
  server.frame({ type: "pty.status", sessionId: "pty-1", status })
  await until(() => observed.length === 1)
  const detachLate = client.attach("pty-1", { onOutput: () => {}, onExit: () => {}, onStatus: (value) => second.push(value) })
  expect(first).toEqual([status])
  expect(second).toEqual([status])
  expect(observed).toHaveLength(1)
  server.frame({ type: "pty.status", sessionId: "pty-1", status: { ...status, subjectId: "other" } })
  server.frame({ type: "pty.status", sessionId: "pty-1", status: { ...status, activity: "made-up" } })
  server.frame({ type: "pty.status", sessionId: "pty-1", status: { ...status, provenance: { ...status.provenance, version: 4 } } })
  server.frame({ type: "pty.status", sessionId: "pty-1", status: { ...status, activity: "needs-input", attention: "needs-input",
    provenance: { ...status.provenance, version: 6 } } })
  await until(() => observed.length === 2)
  expect(first).toHaveLength(2)
  expect(second).toHaveLength(2)
  expect(server.seen.filter((frame) => frame.type === "subscribe")).toHaveLength(1)
  detachLate(); detach(); client.dispose()
})

test("terminal input waits for the topic acknowledgement, then output reaches every attachment", async () => {
  const server = serve()
  const client = createPtyClient({
    baseUrl: "http://127.0.0.1",
    http: fetch,
    socketUrl: () => server.url
  })
  const first: Array<string> = []
  const second: Array<string> = []
  const detachFirst = client.attach("pty-1", { onOutput: (data) => first.push(data), onExit: () => {} })
  const detachSecond = client.attach("pty-1", { onOutput: (data) => second.push(data), onExit: () => {} })
  client.input("pty-1", "printf ready\r")

  await until(() => server.seen.some((frame) => frame.type === "subscribe"))
  expect(server.seen.some((frame) => frame.type === "pty.input")).toBe(false)
  server.acknowledge("pty-1")
  await until(() => server.seen.some((frame) => frame.type === "pty.input"))
  expect(server.seen.find((frame) => frame.type === "pty.input")).toEqual({
    type: "pty.input",
    sessionId: "pty-1",
    data: "printf ready\r"
  })

  server.output("pty-1", "ready\r\n")
  await until(() => first.length === 1 && second.length === 1)
  expect(first).toEqual(["ready\r\n"])
  expect(second).toEqual(first)

  detachFirst()
  expect(server.seen.some((frame) => frame.type === "unsubscribe")).toBe(false)
  detachSecond()
  await until(() => server.seen.some((frame) => frame.type === "unsubscribe"))
  client.dispose()
})

test("detaching before acknowledgement discards queued terminal input", async () => {
  const server = serve()
  const client = createPtyClient({
    baseUrl: "http://127.0.0.1",
    http: fetch,
    socketUrl: () => server.url
  })
  const detach = client.attach("pty-gone", { onOutput: () => {}, onExit: () => {} })
  client.input("pty-gone", "must-not-run")
  await until(() => server.seen.some((frame) => frame.type === "subscribe"))
  detach()
  server.acknowledge("pty-gone")
  await Bun.sleep(30)
  expect(server.seen.some((frame) => frame.type === "pty.input")).toBe(false)
  client.dispose()
})

test("reconnect requests only missing output, reports a retention gap and never replays disconnected input", async () => {
  const frames: Record<string, unknown>[] = []
  let socket: Bun.ServerWebSocket<unknown> | undefined
  let connections = 0
  const server = Bun.serve({
    port: 0,
    fetch: (request, host) => host.upgrade(request) ? undefined : new Response(null, { status: 404 }),
    websocket: {
      open: (opened) => { socket = opened; connections++ },
      message: (opened, raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>
        frames.push(frame)
        if (frame.type === "subscribe") {
          const replay = connections === 1
            ? { data: "first", start: 0, cursor: 5, truncated: false }
            : { data: "last", start: 12, cursor: 16, truncated: true }
          opened.send(JSON.stringify({ type: "pty.replay", sessionId: "continuity", ...replay, alive: true, code: null }))
          opened.send(JSON.stringify({ type: "subscribed", topic: "pty:continuity" }))
        }
      }
    }
  })
  const client = createPtyClient({ http: fetch, baseUrl: "", socketUrl: () => `ws://127.0.0.1:${server.port}`, reconnectMs: 80 })
  let output = ""
  const exits: (number | null)[] = []
  try {
    client.attach("continuity", { onOutput: (data) => { output += data }, onExit: (code) => exits.push(code) })
    await until(() => output === "first")
    socket!.close()
    await Bun.sleep(20)
    client.input("continuity", "must-never-replay\n")
    await until(() => connections === 2 && output.endsWith("last"))
    expect(frames.filter((frame) => frame.type === "subscribe").map((frame) => frame.cursor)).toEqual([0, 5])
    expect(output).toBe("first\r\n[Earlier terminal output is no longer retained.]\r\nlast")
    expect(frames.some((frame) => frame.type === "pty.input")).toBe(false)
    socket!.send(JSON.stringify({ type: "pty.output", sessionId: "continuity", data: "last", start: 12, cursor: 16 }))
    socket!.send(JSON.stringify({ type: "pty.exit", sessionId: "continuity", code: 7 }))
    socket!.send(JSON.stringify({ type: "pty.exit", sessionId: "continuity", code: 7 }))
    await until(() => exits.length === 1)
    expect(output.endsWith("lastlast")).toBe(false)
    expect(exits).toEqual([7])
    let attached = ""
    const attachedExits: (number | null)[] = []
    client.attach("continuity", { onOutput: (data) => { attached += data }, onExit: (code) => attachedExits.push(code) })
    expect(attached).toBe(output)
    expect(attachedExits).toEqual([7])
  } finally {
    client.dispose()
    server.stop(true)
  }
})
