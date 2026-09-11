/* The terminal transport against a real WebSocket server. */
import { afterEach, expect, test } from "bun:test"
import { createPtyClient } from "./PtyClient"

interface Harness {
  readonly url: string
  readonly seen: Array<Record<string, unknown>>
  readonly acknowledge: (sessionId: string) => void
  readonly output: (sessionId: string, data: string) => void
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
