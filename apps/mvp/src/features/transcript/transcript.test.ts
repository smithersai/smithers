// The Transcript panel in the browser (decision 0141, docs/features/agent-transcripts.md#the-panel): the transcript
// layer on Node, dialing a real WebSocket server on loopback at the app's origin that speaks the transcript socket as a
// run's `RunContent` does: JSON text frames, a replay, `live` with the run's digest, then each event as it is stored. A
// plain GET of the same route answers as ChatApi's would (426 to a Member, or the refusal). The object's own store is
// tested in worker/runners/RunContent.test.ts; this tests what the page does with what it sends.
import { NodeWS } from "@effect/platform-node/NodeSocket"
import { RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test, vi } from "vitest"
import { socketUrl } from "./actions"
import { GENESIS, transcribed, transcriptRoute } from "./contract"
import { chain } from "./digest"
import { dials, replays } from "./metrics"
import type { Frame, Row } from "./schema"
import { Transcript } from "./transcript"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const until = (assertion: () => void | Promise<void>, timeout = 15_000) => vi.waitFor(assertion, { timeout, interval: 20 })

const RUN = "todo:0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11"

/** One socket the page opened: the URL it dialed, and the host's side. */
interface Peer {
  readonly url: string
  readonly send: (frame: Frame | string | Uint8Array) => void
  readonly close: (code: number) => void
  /** Drops the connection with no close frame, as a network does (1006). */
  readonly drop: () => void
}

/** A transcript host on loopback: sockets arrive on `peers`; a plain GET answers `plain.status`. */
const transcriptHost = async () => {
  const server = createServer((request, response) => {
    gets.push(request.url ?? "")
    response.writeHead(plain.status, { "content-type": "application/json" }).end(JSON.stringify({ code: "x" }))
  })
  const sockets = new NodeWS.WebSocketServer({ server })
  const peers: Array<Peer> = []
  const gets: Array<string> = []
  const plain = { status: 426 }
  sockets.on("connection", (socket, request) => {
    peers.push({
      url: request.url ?? "",
      send: (frame) => socket.send(typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame)),
      close: (code) => socket.close(code),
      drop: () => socket.terminate(),
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  let stopped: Promise<void> | undefined
  const stop = () =>
    stopped ??= new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.closeAllConnections()
      server.close(() => resolve())
    })
  closers.push(stop)
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, peers, gets, plain, stop }
}

/** The transcript layer of one tab on `origin`, with its own metrics and a quick redial. */
const QUICK = RetryPolicy.make({ initialMs: 20, factor: 1, maxMs: 20, maxAttempts: 3 })

/** The transcript layer of one tab on `origin`, with its own metrics; `redial` null is the panel's own policy. */
const tab = async (origin: string, redial: RetryPolicy.RetryPolicy | null = QUICK) => {
  const registry: Metric.MetricRegistry = new Map()
  const runtime = ManagedRuntime.make(
    Transcript.layer(redial === null ? { origin } : { origin, redial }).pipe(
      Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
      Layer.provideMerge(FetchHttpClient.layer),
    ),
  )
  closers.push(() => runtime.dispose())
  const transcript = await runtime.runPromise(Effect.service(Transcript))
  transcript.queries.panel.startSyncImmediate()
  transcript.queries.items.startSyncImmediate()
  const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
    runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    )).count
  return {
    actions: transcript.actions,
    panel: () => transcript.queries.panel.toArray[0]!,
    items: () => transcript.queries.items.toArray.map((item) => [item.kind, item.text, item.status]),
    count,
  }
}

let n = 0
const row = (kind: string, update: Record<string, unknown>, seq = n): Row => ({
  n: ++n,
  generation: 1,
  seq,
  at: Date.now() - 50,
  kind,
  update: { sessionUpdate: kind, ...update },
})
const said = (text: string, messageId = "m1") => row("agent_message_chunk", { content: { type: "text", text }, messageId })
const digestOf = (rows: ReadonlyArray<Row>) => rows.reduce(chain, GENESIS)

describe("watching a run's transcript", () => {
  test("replays the run, checks its digest, then follows live, folding each event into what the panel shows", async () => {
    n = 0
    const host = await transcriptHost()
    const page = await tab(host.origin, null)
    page.actions.watch(RUN)
    await until(() => expect(host.peers).toHaveLength(1))
    expect(page.panel()).toMatchObject({ runId: RUN, phase: "connecting" })
    const peer = host.peers[0]!
    expect(peer.url).toBe(`${transcriptRoute(RUN)}?after=-1`)
    const replay = [row("user_message_chunk", { content: { type: "text", text: "Add alpha" } }), said("Working ")]
    peer.send({ type: "events", events: replay })
    await until(() => expect(page.panel()).toMatchObject({ phase: "replaying", events: 2, last: 2 }))
    peer.send({ type: "live", n: 2, digest: digestOf(replay) })
    await until(() => expect(page.panel()).toMatchObject({ phase: "live", verified: true }))
    const live = [said("on it."), row("tool_call", { toolCallId: "t1", title: "Edit", status: "in_progress" })]
    peer.send({ type: "events", events: live })
    await until(() =>
      expect(page.items()).toEqual([
        ["prompt", "Add alpha", null],
        ["message", "Working on it.", null],
        ["tool", "Edit", "in_progress"],
      ])
    )
    expect(page.panel().digest).toBe(digestOf([...replay, ...live]))
    expect(page.panel().lagMs).toBeGreaterThanOrEqual(0)
    expect(page.count(replays, { verified: "true" })).toBe(1)
    // Watching the run it watches asks nothing more; a binary frame and a frame that isn't one change nothing.
    page.actions.watch(RUN)
    peer.send(new Uint8Array([1, 2, 3]))
    peer.send("not a frame")
    peer.send({ type: "events", events: [] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.peers).toHaveLength(1)
    expect(page.panel().events).toBe(4)
  })

  test("a socket that drops dials again from its last event, and holds each event once", async () => {
    n = 0
    const host = await transcriptHost()
    const page = await tab(host.origin)
    page.actions.watch(RUN)
    await until(() => expect(host.peers).toHaveLength(1))
    const first = [said("one "), said("two ")]
    host.peers[0]!.send({ type: "events", events: first })
    host.peers[0]!.send({ type: "live", n: 2, digest: digestOf(first) })
    await until(() => expect(page.panel().phase).toBe("live"))
    host.peers[0]!.close(1011)
    await until(() => expect(host.peers).toHaveLength(2))
    expect(host.gets).toEqual([transcriptRoute(RUN)])
    expect(page.count(dials, { outcome: "dropped" })).toBe(1)
    const second = host.peers[1]!
    expect(second.url).toBe(`${transcriptRoute(RUN)}?after=2`)
    // An event it holds already, sent again, is dropped.
    const more = [said("three")]
    second.send({ type: "events", events: [first[1]!, ...more] })
    second.send({ type: "live", n: 3, digest: digestOf([...first, ...more]) })
    await until(() => expect(page.panel()).toMatchObject({ phase: "live", events: 3, verified: true }))
    expect(page.items()).toEqual([["message", "one two three", null]])
    // A digest that doesn't match says so.
    second.send({ type: "live", n: 3, digest: "other" })
    await until(() => expect(page.panel().verified).toBe(false))
  })

  test.each([[401, "authentication"], [403, "forbidden"], [404, "not_found"]] as const)(
    "a dial the route refuses %s ends the panel for good",
    async (status, closed) => {
      const host = await transcriptHost()
      host.plain.status = status
      const page = await tab(host.origin)
      page.actions.watch(RUN)
      await until(() => expect(host.peers).toHaveLength(1))
      host.peers[0]!.drop()
      await until(() => expect(page.panel()).toMatchObject({ phase: "closed", closed }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(host.peers).toHaveLength(1)
      expect(page.count(dials, { outcome: closed })).toBe(1)
    },
  )

  test("a run that can't be reached for the redial's whole policy closes the panel; letting go empties it", async () => {
    n = 0
    const host = await transcriptHost()
    const page = await tab(host.origin)
    page.actions.watch(RUN)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.send({ type: "events", events: [said("hello")] })
    await until(() => expect(page.items()).toHaveLength(1))
    // The host goes away: every dial and every plain GET fails, until the policy gives up.
    await host.stop()
    await until(() => expect(page.panel()).toMatchObject({ phase: "closed", closed: "failed" }))
    page.actions.watch(null)
    await until(() => expect(page.panel()).toMatchObject({ runId: null, phase: "idle", events: 0 }))
    expect(page.items()).toEqual([])
  })

  test("a ChatApi that can't be asked over plain HTTP leaves the panel dialing", async () => {
    const host = await transcriptHost()
    const page = await tab(host.origin)
    page.actions.watch(RUN)
    await until(() => expect(host.peers).toHaveLength(1))
    host.plain.status = 503
    host.peers[0]!.close(1011)
    await until(() => expect(host.peers).toHaveLength(2))
    expect(page.panel().phase).toBe("offline")
  })
})

describe("the transcript's contract", () => {
  test("the socket's URL is the app's origin, ws: for http: and wss: for https:", () => {
    expect(socketUrl("https://smithers.sh", RUN, 4)).toBe(`wss://smithers.sh${transcriptRoute(RUN)}?after=4`)
    expect(socketUrl("http://localhost:1337", RUN, -1)).toBe(`ws://localhost:1337${transcriptRoute(RUN)}?after=-1`)
  })

  test("only a run with an external agent's session has a transcript", () => {
    expect(transcribed([{ action: "todo/Begin" }, { action: "agent/Session" }])).toBe(true)
    expect(transcribed([{ action: "todo/Implement" }, { action: null }, {}])).toBe(false)
  })
})
