/*
 * The `/ws` topic lifecycle every local client shares (PtyClient.ts,
 * TargetRunClient.ts, LspClient.ts), against a REAL WebSocket server: one
 * subscription per key however many listeners it has, the topic released by
 * the last of them, every live topic re-subscribed after a reconnect, and no
 * reconnect once nothing is attached. Nothing is stubbed — Bun.serve speaks
 * the protocol the local backend speaks. The client-specific frame contracts
 * stay in each client's own test.
 */
import { afterEach, expect, test } from "bun:test"
import { createTopicSocket } from "./TopicSocket"

interface Harness {
  readonly url: string
  readonly seen: Array<Record<string, unknown>>
  readonly publish: (message: unknown) => void
  readonly raw: (data: string | Uint8Array) => void
  readonly drop: () => void
  readonly sockets: () => number
  readonly stop: () => void
}

const harnesses: Array<Harness> = []

const start = (): Harness => {
  const seen: Array<Record<string, unknown>> = []
  const open = new Set<{ send: (data: string) => void; close: () => void }>()
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response("no")),
    websocket: {
      open: (ws) => void open.add(ws as never),
      close: (ws) => void open.delete(ws as never),
      message: (_ws, message) => {
        try {
          seen.push(JSON.parse(String(message)) as Record<string, unknown>)
        } catch {
          // A frame the client never sends.
        }
      }
    }
  })
  const harness: Harness = {
    url: `ws://127.0.0.1:${server.port}/ws`,
    seen,
    publish: (message) => {
      for (const ws of open) ws.send(JSON.stringify(message))
    },
    raw: (data) => {
      for (const ws of open) (ws as { send: (value: string | Uint8Array) => void }).send(data)
    },
    drop: () => {
      for (const ws of open) ws.close()
    },
    sockets: () => open.size,
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

const until = async (predicate: () => boolean, budgetMs = 4000): Promise<void> => {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
})

/** The shape every client passes: a topic name and a message fan-out. */
const heard = (message: unknown, listeners: (key: string) => ReadonlySet<(value: string) => void> | undefined): void => {
  const frame = message as { key?: unknown; value?: unknown }
  if (typeof frame.key !== "string" || typeof frame.value !== "string") return
  const set = listeners(frame.key)
  if (set === undefined) return
  for (const listener of set) listener(frame.value)
}

test("one subscription serves every listener on a key, and the last one releases the topic", async () => {
  const server = start()
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    topicOf: (key) => `demo:${key}`,
    onMessage: heard
  })
  const first: Array<string> = []
  const second: Array<string> = []
  const detachFirst = socket.attach("a", (value) => first.push(value))
  await until(() => server.seen.length >= 1)
  const detachSecond = socket.attach("a", (value) => second.push(value))

  server.publish({ key: "a", value: "one" })
  await until(() => first.length >= 1 && second.length >= 1)
  /* One topic, not two: the second listener subscribes nothing. */
  expect(server.seen.filter((message) => message.type === "subscribe").length).toBe(1)
  expect(server.seen[0]).toEqual({ type: "subscribe", topic: "demo:a" })

  /* Releasing one listener must NOT release the topic the other still reads. */
  detachFirst()
  expect(server.seen.some((message) => message.type === "unsubscribe")).toBe(false)
  server.publish({ key: "a", value: "two" })
  await until(() => second.length >= 2)
  expect(first.length).toBe(1)

  detachSecond()
  await until(() => server.seen.some((message) => message.type === "unsubscribe"))
  expect(server.seen.at(-1)).toEqual({ type: "unsubscribe", topic: "demo:a" })
  /* Detaching twice is a no-op, not a second unsubscribe. */
  detachSecond()
  expect(server.seen.filter((message) => message.type === "unsubscribe").length).toBe(1)
  socket.dispose()
})

test("onSubscribe announces after the subscription, on the first attach and after every reconnect", async () => {
  const server = start()
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    reconnectMs: 10,
    topicOf: (key) => `demo:${key}`,
    onSubscribe: (key, send) => send(JSON.stringify({ type: "announce", key })),
    onMessage: heard
  })
  socket.attach("a", () => {})
  socket.attach("b", () => {})
  await until(() => server.seen.filter((message) => message.type === "announce").length >= 2)
  /*
   * The announcement is what starts work on the server, so it must follow the
   * subscription: announced first, the server could publish before this socket
   * is listening to the topic.
   */
  expect(server.seen.slice(0, 2)).toEqual([
    { type: "subscribe", topic: "demo:a" },
    { type: "announce", key: "a" }
  ])

  server.seen.length = 0
  server.drop()
  await until(() => server.seen.filter((message) => message.type === "announce").length >= 2, 8000)
  expect(new Set(server.seen.filter((message) => message.type === "subscribe").map((message) => message.topic)))
    .toEqual(new Set(["demo:a", "demo:b"]))
  socket.dispose()
})

test("a dropped socket reconnects while listeners remain and delivers again", async () => {
  const server = start()
  const closes: Array<number> = []
  const values: Array<string> = []
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    reconnectMs: 10,
    topicOf: (key) => `demo:${key}`,
    onClose: () => closes.push(Date.now()),
    onMessage: heard
  })
  socket.attach("a", (value) => values.push(value))
  await until(() => server.seen.length >= 1)

  server.seen.length = 0
  server.drop()
  /* onClose reports the drop, and the reconnect re-subscribes the live topic. */
  await until(() => closes.length >= 1)
  await until(() => server.seen.some((message) => message.type === "subscribe"), 8000)
  server.publish({ key: "a", value: "after reconnect" })
  await until(() => values.length >= 1)
  expect(values).toEqual(["after reconnect"])
  socket.dispose()
})

test("a socket with nothing attached never reconnects", async () => {
  const server = start()
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    reconnectMs: 10,
    topicOf: (key) => `demo:${key}`,
    onMessage: heard
  })
  const detach = socket.attach("a", () => {})
  await until(() => server.sockets() >= 1)
  detach()
  server.drop()
  await new Promise((resolve) => setTimeout(resolve, 80))
  /* Nothing is listening, so retrying would keep a dead socket alive forever. */
  expect(server.sockets()).toBe(0)
  socket.dispose()
})

test("dispose closes the socket, forgets the listeners and stops reconnecting", async () => {
  const server = start()
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    reconnectMs: 10,
    topicOf: (key) => `demo:${key}`,
    onMessage: heard
  })
  const values: Array<string> = []
  socket.attach("a", (value) => values.push(value))
  await until(() => server.sockets() >= 1)
  socket.dispose()
  await until(() => server.sockets() === 0)
  server.drop()
  await new Promise((resolve) => setTimeout(resolve, 80))
  /* A disposed client never comes back: no socket, no re-subscription. */
  expect(server.sockets()).toBe(0)
  expect(values).toEqual([])
  expect(socket.isOpen()).toBe(false)
  expect(socket.send(JSON.stringify({ type: "late" }))).toBe(false)
})

test("binary frames and text that is not JSON never reach onMessage", async () => {
  const server = start()
  const seen: Array<unknown> = []
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    topicOf: (key) => `demo:${key}`,
    onMessage: (message, listeners) => {
      seen.push(message)
      heard(message, listeners)
    }
  })
  const values: Array<string> = []
  socket.attach("a", (value) => values.push(value))
  await until(() => server.seen.length >= 1)

  server.raw("{not json")
  server.raw(new TextEncoder().encode("binary"))
  server.publish({ key: "a", value: "mine" })
  await until(() => values.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(values).toEqual(["mine"])
  /* Only the one parseable text frame was ever offered to the client. */
  expect(seen).toEqual([{ key: "a", value: "mine" }])
  socket.dispose()
})

test("onDetach reports the key only when its last listener leaves", async () => {
  const server = start()
  const detached: Array<string> = []
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => server.url,
    topicOf: (key) => `demo:${key}`,
    onDetach: (key) => detached.push(key),
    onMessage: heard
  })
  const detachFirst = socket.attach("a", () => {})
  const detachSecond = socket.attach("a", () => {})
  socket.attach("b", () => {})
  await until(() => server.seen.filter((message) => message.type === "subscribe").length >= 2)

  detachFirst()
  expect(detached).toEqual([])
  detachSecond()
  expect(detached).toEqual(["a"])
  socket.dispose()
})

test("no socket exists where the app cannot make one", () => {
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => undefined,
    topicOf: (key) => `demo:${key}`,
    onMessage: heard
  })
  const values: Array<string> = []
  /* Server render and unit tests: attaching is a no-op, never a throw. */
  const detach = socket.attach("a", (value) => values.push(value))
  socket.ensure()
  expect(socket.isOpen()).toBe(false)
  expect(socket.send("{}")).toBe(false)
  detach()
  socket.dispose()
  expect(values).toEqual([])
})

test("a socket that never connects errors, closes and retries until the backend is up", async () => {
  const server = start()
  /*
   * The backend is not listening yet — the app boots before it. The socket
   * errors, closes, and the retry is what eventually subscribes; a client that
   * gave up on the first error would read nothing forever.
   */
  let url = "ws://127.0.0.1:1/ws"
  const socket = createTopicSocket<(value: string) => void>({
    socketUrl: () => url,
    reconnectMs: 10,
    topicOf: (key) => `demo:${key}`,
    onMessage: heard
  })
  const values: Array<string> = []
  socket.attach("a", (value) => values.push(value))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(server.seen.length).toBe(0)

  url = server.url
  await until(() => server.seen.some((message) => message.type === "subscribe"), 8000)
  server.publish({ key: "a", value: "late" })
  await until(() => values.length >= 1)
  socket.dispose()
})
