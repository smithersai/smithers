// The `RunContent` Durable Object (worker/RunContent.vibe, docs/features/agent-transcripts.md) on Node: the real Alchemy
// registration (worker/test/durableObject.ts) constructs the object with its real `SocketChecks` and
// `TranscriptHost` over Node's SQLite, as `ctx.storage.sql` answers. Only workerd's own pieces are stood in: the
// hibernating sockets, the key-value storage beside the SQLite, and the upgrade, which `RoomUpgrade` injects.
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { Transcript } from "@smthrs/agent"
import { RuntimeContext } from "alchemy"
import { Effect, Exit, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"
import * as RunContent from "./RunContent.vibe"
import * as Store from "./runners/RunContent.vibe"
import { RETAIN_KEY } from "./runners/TranscriptHost.vibe"
import * as SocketAccess from "./SocketAccess.ts"
import { RoomUpgrade } from "./durable/SocketHost.vibe"
import { connection, objectRegistration, objectRuntime, unusedDatabase } from "./test/durableObject.ts"

/** The object's methods, as Alchemy calls them. */
interface Handlers {
  readonly append: (
    generation: number,
    events: ReadonlyArray<Transcript.Event>,
  ) => Effect.Effect<{ readonly next: number; readonly summary: Store.Summary }, never, RuntimeContext>
  readonly fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, HttpServerRequest.HttpServerRequest>
  readonly alarm: () => Effect.Effect<void, unknown>
  readonly webSocketMessage: () => Effect.Effect<void>
  readonly webSocketClose: () => Effect.Effect<void>
  readonly webSocketError: () => Effect.Effect<void>
}

/** A hibernating socket as workerd keeps it: its attachment, and what it was sent and closed with. */
const watcherSocket = (attachment: unknown = null) => {
  let kept = attachment
  const sent: Array<{ readonly type: string; readonly [key: string]: unknown }> = []
  const closed: Array<number> = []
  const socket: SocketAccess.HostSocket = {
    send: (frame) => Effect.sync(() => void sent.push(JSON.parse(frame))),
    close: (code) => Effect.sync(() => void closed.push(code)),
    serializeAttachment: (value) => void (kept = value),
    deserializeAttachment: <T>() => kept as T | null,
  }
  return { socket, sent, closed }
}

/** One run's object: its SQLite, its storage and sockets, and its handlers once constructed. */
const object = async (options?: Parameters<typeof RunContent.live>[1], legacy: Array<SocketAccess.HostSocket> = []) => {
  const db = new DatabaseSync(":memory:")
  const sockets: Array<SocketAccess.HostSocket> = [...legacy]
  const kv = new Map<string, unknown>()
  let alarm: number | null = null
  const state = {
    storage: {
      sql: {
        raw: { exec: (query: string, ...bindings: Array<never>) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      },
      get: <T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined),
      put: (key: string, value: unknown) => Effect.sync(() => void kv.set(key, value)),
      getAlarm: () => Effect.sync(() => alarm),
      setAlarm: (at: number) => Effect.sync(() => void (alarm = at)),
      deleteAll: () => Effect.sync(() => kv.clear()),
    },
    getWebSockets: () => Effect.sync(() => sockets),
  } as unknown as Cloudflare.DurableObjectState["Service"]
  const { exports, services } = objectRegistration("RunContent")
  const handlers = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Layer.build(options === undefined ? RunContent.live(connection) : RunContent.live(connection, options))
    const value = exports.get("RunContent") as {
      readonly kind: string
      readonly constructor: Effect.Effect<Effect.Effect<Handlers, never, RuntimeContext>, never, never>
    }
    expect(value.kind).toBe("durableObject")
    return yield* yield* value.constructor
  })).pipe(
    Effect.provideContext(services),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(Cloudflare.DurableObjectState, state),
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
  ))
  /** A watcher's request, answered by the object; an upgrade attaches a fresh socket. */
  const fetch = (request: HttpServerRequest.HttpServerRequest) => {
    const watcher = watcherSocket()
    const upgrade = Effect.sync(() => {
      sockets.push(watcher.socket)
      return [HttpServerResponse.empty({ status: 101 }), watcher.socket as unknown as Cloudflare.WebSocket] as const
    })
    return handlers.fetch.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(RoomUpgrade, upgrade),
      Effect.map((response) => ({ response, watcher })),
    )
  }
  const append = (generation: number, events: ReadonlyArray<Transcript.Event>) =>
    Effect.runPromise(handlers.append(generation, events).pipe(Effect.provideService(RuntimeContext, objectRuntime)))
  return { db, kv, sockets, handlers, fetch, append, alarm: () => alarm }
}

const event = (seq: number): Transcript.Event => ({
  seq,
  at: 1_000 + seq,
  kind: "agent_message_chunk",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `word ${seq}` } },
})

const admissionOf = (principal: string, expiresAt: number | null = null): SocketAccess.Admission => ({
  session: null,
  alias: null,
  expiresAt,
  admittedAt: Date.now(),
  principal,
  role: "member",
  basis: { kind: "run", repoId: "github/octo/widgets" },
  access: "member",
})

/** A watcher's request at `url`, admitted as `admitted`, or with no admission (`null`). */
const requestAt = (url: string, admitted: SocketAccess.Admission | null = admissionOf("person:1")) =>
  HttpServerRequest.fromWeb(
    new Request(url, {
      headers: admitted === null ? {} : { [SocketAccess.ADMISSION_HEADER]: JSON.stringify(admitted) },
    }),
  )

const status = async (run: Awaited<ReturnType<typeof object>>, request: HttpServerRequest.HttpServerRequest) =>
  (await Effect.runPromise(run.fetch(request))).response.status

describe("a run's transcript object", () => {
  test("migrates its SQLite, closes a socket from before leases, stores events, and arms its retention", async () => {
    const legacy = watcherSocket()
    const run = await object(undefined, [legacy.socket])
    expect(legacy.closed).toEqual([SocketAccess.CLOSES.legacy.code])
    expect(run.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events'").get()).toEqual({ n: 1 })

    const first = await run.append(1, [event(0), event(1)])
    expect(first).toMatchObject({ next: 2, summary: { events: 2, last: 2 } })
    expect(run.db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 })
    expect(run.kv.get(RETAIN_KEY)).toBeGreaterThan(Date.now())
    expect(run.alarm()).toBe(run.kv.get(RETAIN_KEY))

    await Effect.runPromise(run.handlers.alarm())
    expect(run.db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 })
    for (const ignored of [run.handlers.webSocketMessage, run.handlers.webSocketClose, run.handlers.webSocketError]) {
      expect(Exit.isSuccess(await Effect.runPromiseExit(ignored()))).toBe(true)
    }
  })

  test("joins an admitted watcher from `?after=`, or from the start, then sends it what is stored next", async () => {
    const run = await object({ local: true })
    await run.append(1, [event(0), event(1), event(2)])
    const admitted = admissionOf("person:1")

    const late = await Effect.runPromise(run.fetch(requestAt("http://run/?after=2", admitted)))
    expect(late.response.status).toBe(101)
    expect(late.watcher.sent.map((frame) => frame.type)).toEqual(["events", "live"])
    expect((late.watcher.sent[0]!.events as Array<{ seq: number }>).map((row) => row.seq)).toEqual([2])
    expect(late.watcher.socket.deserializeAttachment()).toMatchObject({ admission: admitted })

    const fresh = await Effect.runPromise(run.fetch(requestAt("http://run/")))
    expect(fresh.response.status).toBe(101)
    expect((fresh.watcher.sent[0]!.events as Array<{ seq: number }>).map((row) => row.seq)).toEqual([0, 1, 2])
    expect(fresh.watcher.sent[1]).toMatchObject({ type: "live", n: 3 })

    await run.append(1, [event(3)])
    expect(late.watcher.sent.at(-1)).toMatchObject({ type: "events", events: [{ seq: 3 }] })
    expect(fresh.watcher.sent.at(-1)).toMatchObject({ type: "events", events: [{ seq: 3 }] })
  })

  test("refuses a malformed cursor or a request without an admission", async () => {
    const run = await object()
    for (const request of [
      requestAt("http://run/?after=x"),
      requestAt("http://run/?after=1.5"),
      requestAt("http://run/?after=-2"),
      requestAt("http://run/", null),
    ]) {
      expect(await status(run, request)).toBe(400)
    }
    expect(run.sockets).toEqual([])
  })

  test("answers an ended session 401 and a person over the cap 429", async () => {
    const run = await object()
    expect(await status(run, requestAt("http://run/", admissionOf("person:1", 1)))).toBe(401)
    for (let count = 0; count < SocketAccess.MAX_SOCKETS_PER_PERSON; count++) {
      expect(await status(run, requestAt("http://run/", admissionOf("crowd")))).toBe(101)
    }
    expect(await status(run, requestAt("http://run/", admissionOf("crowd")))).toBe(429)
    expect(run.sockets).toHaveLength(SocketAccess.MAX_SOCKETS_PER_PERSON)
  })
})

describe("ChatApi's side of the namespace", () => {
  /** The namespace over real objects by run id; `down` is a run whose object's RPC fails. */
  const namespace = async () => {
    const runs = new Map<string, Awaited<ReturnType<typeof object>>>()
    const run = await object()
    runs.set("run-1", run)
    const unreachable = Effect.fail(new Error("object unreachable"))
    const objects = {
      getByName: (runId: string) => {
        const found = runs.get(runId)
        if (found === undefined) return { append: () => unreachable, fetch: () => unreachable }
        return {
          append: found.handlers.append,
          fetch: (request: HttpServerRequest.HttpServerRequest) =>
            Effect.map(found.fetch(request), ({ response }) => response),
        }
      },
    } as unknown as Parameters<typeof RunContent.connect>[0]
    return { run, objects }
  }

  test("appends through the run's object, and a failed append is TranscriptsUnavailable", async () => {
    const { run, objects } = await namespace()
    const { ok, down } = await Effect.runPromise(Effect.gen(function* () {
      const transcripts = yield* Store.Transcripts
      const ok = yield* transcripts.append("run-1", 3, [event(0)])
      const down = yield* Effect.flip(transcripts.append("down", 3, [event(0)]))
      return { ok, down }
    }).pipe(Effect.provide(RunContent.transcriptsLayer(objects)), Effect.provideService(RuntimeContext, objectRuntime)))
    expect(ok).toMatchObject({ next: 1, summary: { events: 1 } })
    expect(run.db.prepare("SELECT generation, seq FROM events").all()).toEqual([{ generation: 3, seq: 0 }])
    expect(down).toBeInstanceOf(Store.TranscriptsUnavailable)
  })

  test("connects a watcher to the run's object with its admission, or answers 503", async () => {
    const { run, objects } = await namespace()
    const admitted = admissionOf("person:2")
    const connect = (runId: string) =>
      Effect.runPromise(
        RunContent.connect(objects, runId, admitted).pipe(
          Effect.provideService(RuntimeContext, objectRuntime),
          Effect.provideService(HttpServerRequest.HttpServerRequest, requestAt("http://app/api/runs/run-1/transcript", null)),
        ),
      )
    expect((await connect("run-1")).status).toBe(101)
    expect(run.sockets[0]!.deserializeAttachment()).toMatchObject({ admission: admitted })
    expect((await connect("down")).status).toBe(503)
  })
})
