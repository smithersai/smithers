/**
 * The server-sent event hub behind `GET /global/event` and `GET /event`.
 *
 * Every event is published once, stamped with an `evt_` id, and broadcast to
 * every open stream. A stream begins with `server.connected`, then carries
 * live events, and every fifteen seconds an SSE comment `: heartbeat` and a
 * `server.heartbeat` event, which is what OpenCode 1.18.31 sends on its
 * global stream. Session-scoped events travel in the envelope
 * `{directory, project, payload: {id, type, properties}}`; server events
 * carry `{payload}` only.
 *
 * A bounded replay buffer keeps the last events so a stream opened with
 * `Last-Event-ID` after a reconnect gets what it missed. The app reloads
 * history over HTTP on connect, so the buffer only has to cover a reconnect.
 *
 * @since 1.0.0
 */
import { type Cause, Context, type Duration, Effect, Layer, Queue, Stream } from "effect"
import * as Ids from "./Ids.ts"
import type * as Protocol from "./Protocol.ts"

/**
 * The wire envelope of one event.
 *
 * @category models
 * @since 1.0.0
 */
export interface Envelope {
  readonly directory?: string
  readonly project?: string
  readonly payload: { readonly id: string; readonly type: string; readonly properties: Record<string, unknown> }
}

/**
 * How the hub is built.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The directory every session-scoped event is stamped with. */
  readonly directory: string
  /** The project id every session-scoped event is stamped with. */
  readonly project: string
  /** How often an open stream is kept alive. Fifteen seconds by default. */
  readonly heartbeat?: Duration.Input | undefined
  /** How many events the replay buffer keeps. 256 by default. */
  readonly replay?: number | undefined
}

/**
 * What the hub does.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /** Stamps an id, envelopes, remembers, and broadcasts one session-scoped event. Returns the envelope. */
  readonly publish: (event: Protocol.Emitted) => Effect.Effect<Envelope>
  /** The envelopes after the given event id, oldest first; everything remembered when no id is given. */
  readonly replay: (after?: string) => Effect.Effect<Array<Envelope>>
  /**
   * One SSE body: `server.connected`, the replay after `after`, then live
   * events and heartbeats until the consumer stops reading or the hub closes.
   * `bare` frames each event as the payload alone (`{id, type, properties}`),
   * the shape `GET /event` answers; the default is the global envelope.
   */
  readonly stream: (
    options?: { readonly after?: string | undefined; readonly bare?: boolean | undefined }
  ) => Stream.Stream<string>
  /**
   * Ends every open stream and every stream opened afterwards, so the
   * responses finish and the server can close its connections at once
   * instead of waiting on clients that never disconnect.
   */
  readonly close: Effect.Effect<void>
}

/**
 * The hub service.
 *
 * @category services
 * @since 1.0.0
 */
export class Events extends Context.Service<Events, Service>()("@smthrs/opencode/Events") {}

/**
 * The default keepalive cadence.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultHeartbeat: Duration.Input = "15 seconds"

/**
 * The default replay depth.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultReplay = 256

/**
 * One SSE frame for an envelope: the envelope itself, or with `bare` its
 * payload alone, the `Event` shape of the 1.18.31 OpenAPI for `GET /event`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const frame = (envelope: Envelope, bare = false): string =>
  `data: ${JSON.stringify(bare ? envelope.payload : envelope)}\n\n`

/**
 * The keepalive comment.
 *
 * @category constants
 * @since 1.0.0
 */
export const heartbeatComment = ": heartbeat\n\n"

const serverEvent = (type: string): Envelope => ({ payload: { id: Ids.make("event"), type, properties: {} } })

/**
 * Builds the hub.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<Service> =>
  Effect.sync(() => {
    const capacity = options.replay ?? defaultReplay
    const buffer: Array<Envelope> = []
    const subscribers = new Set<Queue.Queue<Envelope, Cause.Done>>()
    let closed = false

    const publish: Service["publish"] = (event) =>
      Effect.sync(() => {
        const envelope: Envelope = {
          directory: options.directory,
          project: options.project,
          payload: { id: Ids.make("event"), type: event.type, properties: event.properties }
        }
        buffer.push(envelope)
        if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity)
        for (const queue of subscribers) Queue.offerUnsafe(queue, envelope)
        return envelope
      })

    const replay: Service["replay"] = (after) =>
      Effect.sync(() => {
        if (after === undefined) return [...buffer]
        const index = buffer.findIndex((envelope) => envelope.payload.id === after)
        return index < 0 ? [...buffer] : buffer.slice(index + 1)
      })

    const stream: Service["stream"] = (streamOptions = {}) => {
      const bare = streamOptions.bare === true
      // A stalled consumer (a backgrounded tab, a half-closed socket) keeps
      // the newest `capacity` events, never every event of every later
      // turn: the app reloads history on reconnect and `Last-Event-ID`
      // replays the gap.
      const live = Stream.callback<Envelope>((queue) =>
        Effect.suspend(() =>
          closed ? Queue.end(queue) : Effect.acquireRelease(
            Effect.sync(() => {
              subscribers.add(queue)
            }),
            () =>
              Effect.sync(() => {
                subscribers.delete(queue)
              })
          )
        ), { bufferSize: capacity, strategy: "sliding" })
      const beats = Stream.tick(options.heartbeat ?? defaultHeartbeat).pipe(
        Stream.drop(1),
        Stream.map(() =>
          heartbeatComment + frame(serverEvent("server.heartbeat"), bare)
        )
      )
      return Stream.fromEffect(replay(streamOptions.after)).pipe(
        Stream.flatMap((missed) =>
          Stream.concat(
            Stream.fromIterable([
              frame(serverEvent("server.connected"), bare),
              ...missed.map((envelope) => frame(envelope, bare))
            ]),
            Stream.merge(Stream.map(live, (envelope) => frame(envelope, bare)), beats, { haltStrategy: "left" })
          )
        )
      )
    }

    const close: Service["close"] = Effect.suspend(() => {
      closed = true
      return Effect.forEach(subscribers, (queue) => Queue.end(queue), { discard: true })
    })

    return { publish, replay, stream, close }
  })

/**
 * The hub as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<Events> => Layer.effect(Events, make(options))
