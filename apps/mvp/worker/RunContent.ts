import type { Transcript } from "@smthrs/agent"
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { RETENTION_MS } from "../src/features/transcript/contract.ts"
import type { Frame, Row } from "../src/features/transcript/schema.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Store from "./runners/RunContent.ts"

// Runs' transcripts on Cloudflare (decision 0134, docs/features/agent-transcripts.md): `RunContent`, one Durable Object
// per run, named by the run's id, keeps its external agent's transcript in its own SQLite (worker/runners/RunContent.ts)
// and holds the sockets of everyone watching it. The runner events route (worker/runners/Api.ts) appends through
// `append`; ChatApi hands it each watcher's socket after checking the person may read the run
// (worker/RemoteRuns.ts). It hibernates: an idle object bills no duration and keeps its sockets. Its alarm forgets the
// transcript `RETENTION_MS` after the last event. Nothing here logs an event's content.

/** The object's methods, as ChatApi calls them. */
export interface RunContentShape {
  readonly append: (
    generation: number,
    events: ReadonlyArray<Transcript.Event>,
  ) => Effect.Effect<{ readonly next: number; readonly summary: Store.Summary }, never, RuntimeContext>
}

/** The `RunContent` Durable Object namespace: a run's transcript is `getByName(runId)`. */
export class RunContent extends Cloudflare.DurableObject<RunContent, RunContentShape>()("RunContent") {}

/** How long before its alarm the object moves it on: at most once an hour per run. */
const REARM_MS = 60 * 60 * 1000

/** A frame as the socket sends it. */
const frame = (value: Frame) => JSON.stringify(value)

/** The object's implementation: the transcript of one run. */
export const live = RunContent.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    return Effect.gen(function* () {
      const runtime = yield* RuntimeContext
      const sql: Store.Sql = {
        exec: (query, ...bindings) =>
          state.storage.sql.raw.exec(query, ...bindings).toArray() as ReadonlyArray<Record<string, Store.SqlValue>>,
      }
      Store.migrate(sql)

      const sockets = state.getWebSockets().pipe(Effect.provideService(RuntimeContext, runtime))
      const sendAll = (events: ReadonlyArray<Row>) =>
        Effect.gen(function* () {
          if (events.length === 0) return
          const text = frame({ type: "events", events })
          for (const socket of yield* sockets) yield* socket.send(text).pipe(Effect.ignore)
        })

      /** Moves the retention alarm to `RETENTION_MS` after now, at most once an hour. */
      const retain = (now: number) =>
        Effect.gen(function* () {
          const alarm = yield* state.storage.getAlarm()
          if (alarm === null || alarm < now + RETENTION_MS - REARM_MS) yield* state.storage.setAlarm(now + RETENTION_MS)
        })

      const append = (generation: number, events: ReadonlyArray<Transcript.Event>) =>
        Effect.gen(function* () {
          const now = Date.now()
          const appended = Store.append(sql, generation, events, now)
          yield* sendAll(appended.stored)
          if (appended.stored.length > 0) yield* retain(now)
          return { next: appended.next, summary: appended.summary }
        }).pipe(Effect.withSpan("run_content.append", { attributes: { "smithers.transcript.generation": generation } }))

      /**
       * A socket ChatApi admitted: every event after `?after=` in pages, then `live` with the run's digest, then each
       * event as it is stored. The replay runs inside this one event, so nothing is stored between its pages.
       */
      const join = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const after = Number(new URL(request.url, "http://run").searchParams.get("after") ?? "-1")
        if (!Number.isInteger(after) || after < -1) return HttpServerResponse.empty({ status: 400 })
        const [response, socket] = yield* Cloudflare.upgrade()
        let cursor = after
        for (;;) {
          const rows = Store.page(sql, cursor)
          if (rows.length === 0) break
          yield* socket.send(frame({ type: "events", events: rows })).pipe(Effect.ignore)
          cursor = rows[rows.length - 1]!.n
        }
        const totals = Store.summary(sql)
        yield* socket.send(frame({ type: "live", n: totals.last, digest: totals.digest })).pipe(Effect.ignore)
        yield* Effect.logInfo("run_content.join").pipe(Effect.annotateLogs({ after, events: totals.events }))
        return response
      })

      const forget = Effect.gen(function* () {
        for (const socket of yield* sockets) yield* socket.close(1000, "forgotten").pipe(Effect.ignore)
        yield* state.storage.deleteAll()
        yield* Effect.logInfo("run_content.forget")
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("run_content.forget").pipe(Effect.annotateLogs({ errorCode: codeOf(cause) }))
        ),
      )

      return {
        append,
        fetch: join,
        alarm: () => forget,
        // Watchers only read; anything they send is ignored.
        webSocketMessage: () => Effect.void,
        webSocketClose: () => Effect.void,
        webSocketError: () => Effect.void,
      }
    })
  }),
)

/** The namespace as ChatApi holds it once it has bound it (`yield* RunContent`). */
type Objects = Cloudflare.DurableObject<RunContentShape>

/** ChatApi's `Transcripts` over the bound namespace, for the request that calls it. */
export const transcriptsOver = (objects: Objects) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext
    return Store.Transcripts.of({
      append: (runId, generation, events) =>
        objects.getByName(runId).append(generation, events).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.mapError(() => new Store.TranscriptsUnavailable()),
        ),
    })
  })

/** `Transcripts` as a layer, for the runtime that calls it. */
export const transcriptsLayer = (objects: Objects) => Layer.effect(Store.Transcripts, transcriptsOver(objects))

/** Hands run `runId`'s transcript the request's socket, which ChatApi already admitted; `503` when it can't. */
export const connect = (objects: Objects, runId: string) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* objects.getByName(runId).fetch(request).pipe(Effect.provideService(RuntimeContext, runtime))
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })))
