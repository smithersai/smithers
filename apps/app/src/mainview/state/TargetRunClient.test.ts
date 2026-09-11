/*
 * The target-run transport (docs/LOCAL-APP.md "HTTP and WebSocket API")
 * against a REAL WebSocket server: one socket to `/ws` shared by every run
 * card, `subscribe` + `target-run.attach` on the first listener, the topic
 * released when the last one detaches, and every live topic re-announced
 * after a reconnect. Nothing here is stubbed — Bun.serve speaks the protocol
 * the local backend speaks, so the seam under test is the product's seam.
 */
import { afterEach, expect, test } from "bun:test"
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import { createTargetRunClient } from "./TargetRunClient"

interface Harness {
  readonly url: string
  readonly seen: Array<Record<string, unknown>>
  readonly publish: (runId: string, frame: unknown) => void
  readonly raw: (data: string | Uint8Array) => void
  readonly drop: () => void
  readonly sockets: () => number
  readonly stop: () => void
}

const serve = (): Harness => {
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
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    seen,
    publish: (runId, frame) => {
      for (const ws of open) ws.send(JSON.stringify({ type: "target-run", runId, frame }))
    },
    raw: (data) => {
      for (const ws of open) (ws as { send: (value: string | Uint8Array) => void }).send(data)
    },
    /** Every message the server sends that the client must ignore. */
    drop: () => {
      for (const ws of open) ws.close()
    },
    sockets: () => open.size,
    stop: () => server.stop(true)
  }
}

const until = async (predicate: () => boolean, budgetMs = 4000): Promise<void> => {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const harnesses: Array<Harness> = []
const start = (): Harness => {
  const harness = serve()
  harnesses.push(harness)
  return harness
}
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
})

test("the first listener subscribes the topic and announces the attachment", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url })
  const frames: Array<TargetRunFrame> = []
  const detach = client.attach("run-1", (frame) => frames.push(frame))

  await until(() => server.seen.length >= 2)
  expect(server.seen[0]).toEqual({ type: "subscribe", topic: "target-run:run-1" })
  /* The attach is what starts the child, so no frame is published unheard. */
  expect(server.seen[1]).toEqual({ type: "target-run.attach", runId: "run-1" })

  server.publish("run-1", { type: "stdout", data: "hello", seq: 0 })
  await until(() => frames.length >= 1)
  expect(frames[0]).toMatchObject({ type: "stdout", data: "hello" })

  detach()
  await until(() => server.seen.some((message) => message.type === "unsubscribe"))
  expect(server.seen.at(-1)).toEqual({ type: "unsubscribe", topic: "target-run:run-1" })
  client.dispose()
})

test("a second listener on the same run shares one subscription and both get frames", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url })
  const first: Array<TargetRunFrame> = []
  const second: Array<TargetRunFrame> = []
  const detachFirst = client.attach("run-1", (frame) => first.push(frame))
  await until(() => server.seen.length >= 2)
  const detachSecond = client.attach("run-1", (frame) => second.push(frame))

  server.publish("run-1", { type: "exit", code: 0, seq: 1 })
  await until(() => first.length >= 1 && second.length >= 1)
  /* One topic, not two: the second listener announces nothing. */
  expect(server.seen.filter((message) => message.type === "subscribe").length).toBe(1)

  /* Releasing one listener must NOT release the topic the other still reads. */
  detachFirst()
  expect(server.seen.some((message) => message.type === "unsubscribe")).toBe(false)
  server.publish("run-1", { type: "exit", code: 1, seq: 2 })
  await until(() => second.length >= 2)
  expect(first.length).toBe(1)

  detachSecond()
  await until(() => server.seen.some((message) => message.type === "unsubscribe"))
  /* Detaching twice is a no-op, not a second unsubscribe. */
  detachSecond()
  expect(server.seen.filter((message) => message.type === "unsubscribe").length).toBe(1)
  client.dispose()
})

test("frames for another run, malformed JSON and non-string data are ignored", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url })
  const frames: Array<TargetRunFrame> = []
  client.attach("run-1", (frame) => frames.push(frame))
  await until(() => server.seen.length >= 2)

  server.publish("run-2", { type: "stdout", data: "someone else's run", seq: 0 })
  server.publish("run-1", { type: "not-a-frame" })
  /* Text that is not JSON at all, and a binary frame: both are ignored. */
  server.raw("{not json")
  server.raw(new TextEncoder().encode("binary"))
  server.publish("run-1", { type: "stdout", data: "mine", seq: 1 })
  await until(() => frames.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  /* Only the well-formed frame for the attached run lands. */
  expect(frames.length).toBe(1)
  expect(frames[0]).toMatchObject({ data: "mine" })
  client.dispose()
})

test("a dropped socket reconnects and re-announces every live topic", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url, reconnectMs: 10 })
  const frames: Array<TargetRunFrame> = []
  client.attach("run-1", (frame) => frames.push(frame))
  client.attach("run-2", (frame) => frames.push(frame))
  await until(() => server.seen.filter((message) => message.type === "subscribe").length >= 2)

  server.seen.length = 0
  server.drop()
  /*
   * After a reconnect the client re-subscribes AND re-announces the
   * attachment for every live topic, or the reconnected run streams to
   * nobody while the card still shows it running.
   */
  await until(() => server.seen.filter((message) => message.type === "target-run.attach").length >= 2, 8000)
  expect(new Set(server.seen.filter((m) => m.type === "subscribe").map((m) => m.topic)))
    .toEqual(new Set(["target-run:run-1", "target-run:run-2"]))

  server.publish("run-1", { type: "stdout", data: "after reconnect", seq: 0 })
  await until(() => frames.length >= 1)
  client.dispose()
})

test("dispose closes the socket and stops reconnecting", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url, reconnectMs: 10 })
  client.attach("run-1", () => {})
  await until(() => server.sockets() >= 1)
  client.dispose()
  await until(() => server.sockets() === 0)
  server.drop()
  await new Promise((resolve) => setTimeout(resolve, 80))
  /* A disposed client never comes back: no socket, no re-announcement. */
  expect(server.sockets()).toBe(0)
})

test("no socket exists where the app cannot make one", () => {
  const client = createTargetRunClient({ socketUrl: () => undefined })
  const frames: Array<TargetRunFrame> = []
  /* Server render and unit tests: attaching is a no-op, never a throw. */
  const detach = client.attach("run-1", (frame) => frames.push(frame))
  detach()
  client.dispose()
  expect(frames).toEqual([])
})

test("a socket that never connects errors, closes and retries until the backend is up", async () => {
  const server = start()
  /*
   * The backend is not listening yet — the app boots before it. The socket
   * errors, closes, and the retry is what eventually attaches; a client that
   * gave up on the first error would leave every run card blank forever.
   */
  const dead = "ws://127.0.0.1:1/ws"
  let url = dead
  const client = createTargetRunClient({ socketUrl: () => url, reconnectMs: 10 })
  const frames: Array<TargetRunFrame> = []
  client.attach("run-1", (frame) => frames.push(frame))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(server.seen.length).toBe(0)

  url = server.url
  await until(() => server.seen.filter((message) => message.type === "target-run.attach").length >= 1, 8000)
  server.publish("run-1", { type: "stdout", data: "late", seq: 0 })
  await until(() => frames.length >= 1)
  client.dispose()
})

test("the run-local seq survives the transport's parse", async () => {
  const server = start()
  const client = createTargetRunClient({ socketUrl: () => server.url })
  const frames: Array<TargetRunFrame> = []
  client.attach("run-1", (frame) => frames.push(frame))
  await until(() => server.seen.length >= 2)

  /*
   * The backend stamps every frame with a run-local `seq`, which the contract
   * names as replay's ONLY total order — stdout/stderr/exit/error frames have
   * no `at`. The client parses each frame through TargetRunFrameSchema, and a
   * zod object strips what it does not declare, so a schema without `seq`
   * silently deletes the ordering key off every frame in flight.
   */
  server.publish("run-1", { type: "stdout", data: "one", seq: 7 })
  server.publish("run-1", { type: "exit", code: 0, seq: 8 })
  await until(() => frames.length >= 2)
  expect(frames.map((frame) => (frame as { seq?: number }).seq)).toEqual([7, 8])
  client.dispose()
})
