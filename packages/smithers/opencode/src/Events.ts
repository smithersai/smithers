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
 * `Last-Event-ID` after a reconnect gets what it missed. Every buffered frame
 * carries an `id:` line, which is what makes that reachable from a browser:
 * `EventSource` sends back the last id it saw and nothing else, so a stream
 * with no ids has no gap to ask about and loses whatever arrived while it was
 * away. A stream that names no id is replayed nothing: the app reloads history over HTTP on connect,
 * and a replay it did not ask for re-animates finished turns and re-raises
 * every permission card in the window, which the app shows and can never take
 * down, because the reply that answered each one is in the same replay.
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
   * One SSE body: `server.connected`, the replay after `after` when one is
   * given and nothing when none is, then whatever `opening` reports as open
   * right now, then live events and heartbeats until the consumer stops
   * reading or the hub closes.
   * `bare` frames each event as the payload alone (`{id, type, properties}`),
   * the shape `GET /event` answers; the default is the global envelope.
   */
  readonly stream: (
    options?: {
      readonly after?: string | undefined
      readonly bare?: boolean | undefined
      /**
       * What is open as this stream opens: read when the stream is pulled,
       * framed after the replay, and never remembered, because it is the
       * state now and not something that happened. This is how a stream that
       * connects while a turn is parked learns about the card, which nothing
       * else would tell it: the ask was published before it connected, and a
       * restart publishes nothing at all.
       */
      readonly opening?: Effect.Effect<ReadonlyArray<Protocol.Emitted>> | undefined
    }
  ) => Stream.Stream<string>
  /**
   * Ends every open stream and every stream opened afterwards, so the
   * responses finish and the server can close its connections at once
   * instead of waiting on clients that never disconnect.
   */
  readonly close: Effect.Effect<void>
  /**
   * Whether {@link Service.close} has run, which is the server stopping.
   * The hub is closed before the socket is, so a request waiting on
   * something only a running turn can give it reads this and stops waiting:
   * nothing is going to give it, and a request still in flight is a
   * connection the socket's own close then waits on.
   */
  readonly stopping: Effect.Effect<boolean>
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
 * A frame the replay buffer holds carries an `id:` line as well, which is the
 * only way a browser can ask for what it missed: `EventSource` remembers the
 * last id it saw and sends it back as `Last-Event-ID` when it reconnects, and
 * a stream that never names an id leaves that header empty forever, so a
 * reload or a dropped connection loses whatever arrived in the gap without
 * anything saying so. 1.18.31 sends no id and loses it; this server sends one.
 *
 * `identified` is false for the frames nothing remembers: `server.connected`,
 * the heartbeats, and the opening cards, which are the state as the stream
 * opens rather than something that happened. Naming one of those as the last
 * id would point the next `Last-Event-ID` at an event no buffer holds, and an
 * id the buffer cannot find is answered with the whole buffer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const frame = (envelope: Envelope, bare = false, identified = false): string =>
  `${identified ? `id: ${envelope.payload.id}\n` : ""}data: ${JSON.stringify(bare ? envelope.payload : envelope)}\n\n`

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

    /** One event in its envelope, with an id of its own. */
    const stamp = (event: Protocol.Emitted): Envelope => ({
      directory: options.directory,
      project: options.project,
      payload: { id: Ids.make("event"), type: event.type, properties: event.properties }
    })

    const publish: Service["publish"] = (event) =>
      Effect.sync(() => {
        const envelope = stamp(event)
        buffer.push(envelope)
        if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity)
        for (const queue of subscribers) Queue.offerUnsafe(queue, envelope)
        return envelope
      })

    const replayed = (after: string | undefined): Array<Envelope> => {
      if (after === undefined) return [...buffer]
      const index = buffer.findIndex((envelope) => envelope.payload.id === after)
      return index < 0 ? [...buffer] : buffer.slice(index + 1)
    }

    const replay: Service["replay"] = (after) => Effect.sync(() => replayed(after))

    /**
     * What one stream missed: nothing at all unless it named where it left
     * off. A stream that asked for no replay is served none. The app reloads
     * history over HTTP on connect, so a replay it did not ask for tells it
     * about turns that finished long ago, and re-raises every permission card
     * in the window: the app shows each one again and can never take it down,
     * because the `permission.replied` that answered it is in the same replay
     * or older than it, and clicking it answers 404. A named id is answered
     * as {@link Service.replay} answers it, whether or not the buffer still
     * reaches back that far.
     */
    const missed = (after: string | undefined): Array<Envelope> => after === undefined ? [] : replayed(after)

    const stream: Service["stream"] = (streamOptions = {}) => {
      const bare = streamOptions.bare === true
      // A stalled consumer (a backgrounded tab, a half-closed socket) keeps
      // the newest `capacity` events, never every event of every later
      // turn: the app reloads history on reconnect and `Last-Event-ID`
      // replays the gap.
      const beats = Stream.tick(options.heartbeat ?? defaultHeartbeat).pipe(
        Stream.drop(1),
        Stream.map(() => heartbeatComment + frame(serverEvent("server.heartbeat"), bare))
      )
      return Stream.unwrap(Effect.gen(function*() {
        const queue = yield* Queue.make<Envelope, Cause.Done>({ capacity, strategy: "sliding" })
        // Snapshot the replay and subscribe in the same synchronous step.
        // Opening cards can read the database asynchronously, and delivering
        // the greeting can yield too: events in either gap must already have
        // a queue, without also appearing in the replay.
        const past = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const past = missed(streamOptions.after)
            if (closed) Queue.endUnsafe(queue)
            else subscribers.add(queue)
            return past
          }),
          () => Effect.sync(() => void subscribers.delete(queue))
        )
        const opening = yield* streamOptions.opening ?? Effect.succeed([])
        const live = Stream.fromQueue(queue)
        return Stream.concat(
          Stream.fromIterable([
            frame(serverEvent("server.connected"), bare),
            // The replay carries its ids, so a stream that drops again asks
            // from where this one left off; the opening cards carry none,
            // because nothing remembers them.
            ...past.map((envelope) => frame(envelope, bare, true)),
            ...opening.map((event) => frame(stamp(event), bare))
          ]),
          Stream.merge(Stream.map(live, (envelope) => frame(envelope, bare, true)), beats, { haltStrategy: "left" })
        )
      }))
    }

    const close: Service["close"] = Effect.suspend(() => {
      closed = true
      return Effect.forEach(subscribers, (queue) => Queue.end(queue), { discard: true })
    })

    const stopping: Service["stopping"] = Effect.sync(() => closed)

    return { publish, replay, stream, close, stopping }
  })

/**
 * The hub as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<Events> => Layer.effect(Events, make(options))
