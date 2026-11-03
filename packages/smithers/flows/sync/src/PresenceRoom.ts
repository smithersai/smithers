/**
 * The host side of a presence room: one room per page, such as a branch,
 * that tells everyone on it who else is there and where.
 *
 * The room keeps no state of its own. Everything about a connection lives in
 * its socket's attachment, so a Cloudflare Durable Object that hibernates
 * with its sockets open wakes with the whole room intact. The host is
 * structural: a Durable Object passes its accepted WebSockets and
 * `state.getWebSockets()` in as they are, and a test passes an in-memory one.
 *
 * - **{@link join}** admits an accepted socket with the identity the host's
 *   authentication gave it, and sends everyone the new roster.
 * - **{@link receive}** handles a page's frame: a new state is relayed to
 *   everyone; a binary, malformed or oversized frame closes that socket.
 * - **{@link leave}** forgets a socket the host saw close or fail.
 * - **{@link close}** and **{@link evict}** let the host remove a connection,
 *   or every connection of one principal, with a close code.
 *
 * Sending to a socket that has already closed never fails the room: that
 * socket is dropped from the roster instead. Spans, metrics and logs carry
 * connection ids and counts only, never a state, a name or host data.
 *
 * @since 1.0.0-rc.17
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { fits, participantOf, rosterFrame } from "./internal/PresenceWire.ts"
import {
  type Access,
  CloseCode,
  decodeClientFrame,
  maxDataBytes,
  maxFrameBytes,
  maxParticipants,
  type Participant
} from "./PresenceProtocol.vibe"

/**
 * One socket the host holds open, shaped like Alchemy's `Cloudflare.WebSocket`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RoomSocket<R = never> {
  readonly send: (text: string) => Effect.Effect<void, unknown, R>
  readonly close: (code: number, reason: string) => Effect.Effect<void, unknown, R>
  /** Keeps `value` with the socket, through hibernation. */
  readonly serializeAttachment: (value: unknown) => void
  /** The value last kept with {@link serializeAttachment}, or `null`. */
  readonly deserializeAttachment: <T>() => T | null
}

/**
 * The host a room runs on.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RoomHost<S extends RoomSocket<R>, R = never> {
  /** Every socket the host holds open, hibernated ones included (a Durable Object's `state.getWebSockets()`). */
  readonly sockets: Effect.Effect<ReadonlyArray<S>, never, R>
}

/**
 * Who a socket is, as the host's authentication says.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Identity {
  readonly principal: string
  readonly name: string
  readonly access: Access
  /** Host-only data, never sent to anyone, at most `PresenceProtocol.maxDataBytes`. */
  readonly data?: string
}

/**
 * One joined connection, as {@link connections} reads it from the attachments.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Connection<S> {
  readonly socket: S
  readonly participant: Participant
  readonly data: string | undefined
}

/**
 * {@link join} calls, by `outcome`: `joined` or `full`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const joins = Metric.counter("smithers_presence_joins", {
  description: "Presence room joins, by outcome",
  incremental: true
})

/**
 * Frames from pages, by `outcome`: `state`, `unsupported` or `too_big`. A
 * count, never content.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const frames = Metric.counter("smithers_presence_frames", {
  description: "Presence frames from pages, by outcome; counts only",
  incremental: true
})

/**
 * Connections {@link evict} closed.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const evictions = Metric.counter("smithers_presence_evictions", {
  description: "Presence connections closed by eviction",
  incremental: true
})

/**
 * Joined connections right now: up on a join, down when a connection leaves,
 * is closed, or is found gone.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const open = Metric.counter("smithers_presence_open", {
  description: "Presence connections joined right now"
})

/** What a socket keeps through hibernation. `presence` marks it as this room's. */
const Attachment = Schema.Struct({
  presence: Schema.Literal(1),
  id: Schema.String,
  principal: Schema.String,
  name: Schema.String,
  access: Schema.Literals(["read", "write"]),
  state: Schema.NullOr(Schema.String),
  data: Schema.optionalKey(Schema.String),
  seq: Schema.Number
})

type Attachment = typeof Attachment.Type

const decodeAttachment = Schema.decodeUnknownOption(Attachment)

const attachmentOf = (socket: RoomSocket<any>): Attachment | undefined =>
  Option.getOrUndefined(decodeAttachment(socket.deserializeAttachment<unknown>()))

const forget = (socket: RoomSocket<any>): void => socket.serializeAttachment(null)

const connectionOf = <S extends RoomSocket<any>>(socket: S, attachment: Attachment): Connection<S> => ({
  socket,
  participant: {
    id: attachment.id,
    principal: attachment.principal,
    name: attachment.name,
    access: attachment.access,
    state: attachment.state
  },
  data: attachment.data
})

/** Join order; two joins that read the room at once share a sequence, and their ids break the tie. */
const byJoin = (left: Attachment, right: Attachment): number => left.seq - right.seq || left.id.localeCompare(right.id)

const opened = (delta: number) => Metric.update(open, delta)

/**
 * Runs a send or a close and reports whether it worked. A socket that has
 * already closed may fail or throw (workerd throws on a send after close);
 * either way the caller treats it as gone.
 */
const attempt = <R>(effect: () => Effect.Effect<void, unknown, R>): Effect.Effect<boolean, never, R> =>
  Effect.map(Effect.exit(Effect.suspend(effect)), Exit.isSuccess)

interface Joined<S> {
  readonly socket: S
  readonly attachment: Attachment
}

/** Every socket with this room's attachment, in join order. */
const joinedOf = <S extends RoomSocket<R>, R>(host: RoomHost<S, R>): Effect.Effect<Array<Joined<S>>, never, R> =>
  Effect.map(host.sockets, (sockets) =>
    sockets
      .flatMap((socket) => {
        const attachment = attachmentOf(socket)
        return attachment === undefined ? [] : [{ socket, attachment }]
      })
      .sort((left, right) => byJoin(left.attachment, right.attachment)))

/**
 * Every joined connection, in join order, read from the sockets'
 * attachments alone. A socket with no attachment, or another kind of
 * attachment, is not part of the room.
 *
 * @category queries
 * @since 1.0.0-rc.17
 */
export const connections = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>
): Effect.Effect<ReadonlyArray<Connection<S>>, never, R> =>
  Effect.map(joinedOf(host), (joined) => joined.map(({ attachment, socket }) => connectionOf(socket, attachment)))

/**
 * Sends the roster to every connection but those in `gone`, each with its own
 * `self`. A socket whose send fails joins `gone`, loses its attachment, and
 * the rest hear again without it.
 */
const publish = <S extends RoomSocket<R>, R>(host: RoomHost<S, R>, gone: Set<string>): Effect.Effect<void, never, R> =>
  Effect.gen(function*() {
    while (true) {
      const live = (yield* connections(host)).filter((connection) => !gone.has(connection.participant.id))
      const participants = JSON.stringify(live.map((connection) => participantOf(connection.participant)))
      const failed: Array<Connection<S>> = []
      for (const connection of live) {
        const frame = rosterFrame(connection.participant.id, participants)
        if (!(yield* attempt(() => connection.socket.send(frame)))) failed.push(connection)
      }
      if (failed.length === 0) return
      for (const connection of failed) {
        gone.add(connection.participant.id)
        forget(connection.socket)
        yield* opened(-1)
        yield* Effect.logDebug("presence.gone").pipe(Effect.annotateLogs({ connection: connection.participant.id }))
      }
    }
  })

/**
 * Forgets `socket`, closes it with `code`, and tells the others. Answers the
 * connection's id, or `undefined` when the socket had not joined (it is
 * closed all the same).
 */
const remove = <S extends RoomSocket<R>, R>(
  host: RoomHost<S, R>,
  socket: S,
  code: number
): Effect.Effect<string | undefined, never, R> =>
  Effect.gen(function*() {
    const attachment = attachmentOf(socket)
    if (attachment !== undefined) forget(socket)
    yield* attempt(() => socket.close(code, ""))
    if (attachment === undefined) return undefined
    yield* opened(-1)
    yield* publish(host, new Set([attachment.id]))
    return attachment.id
  })

/**
 * Joins an accepted socket as `identity`: keeps a fresh connection id, the
 * identity and a `null` state in its attachment, then sends the roster to
 * every connection, each with its own `self`.
 *
 * With `PresenceProtocol.maxParticipants` connections already joined,
 * it closes the socket with `CloseCode.full` and answers `full`.
 *
 * Join a socket once. To change who a connection is, close it with
 * `CloseCode.changed` and let the page reconnect. Joining a socket twice, or
 * an identity whose `data` is over `maxDataBytes`, is the host's bug and
 * dies.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const join = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>,
  socket: S,
  identity: Identity
): Effect.Effect<"joined" | "full", never, R> =>
  Effect.gen(function*() {
    if (identity.data !== undefined && !fits(identity.data, maxDataBytes)) {
      return yield* Effect.die(
        PlatformError.badArgument({
          module: "PresenceRoom",
          method: "join",
          description: `data over ${maxDataBytes} bytes`
        })
      )
    }
    if (attachmentOf(socket) !== undefined) {
      return yield* Effect.die(
        PlatformError.badArgument({
          module: "PresenceRoom",
          method: "join",
          description: "the socket has already joined"
        })
      )
    }
    const joined = yield* joinedOf(host)
    if (joined.length >= maxParticipants) {
      yield* attempt(() => socket.close(CloseCode.full, "full"))
      yield* Effect.annotateCurrentSpan({ "smithers.presence.outcome": "full" })
      yield* Metric.update(Metric.withAttributes(joins, { outcome: "full" }), 1)
      return "full" as const
    }
    const id = crypto.randomUUID()
    const attachment: Attachment = {
      presence: 1,
      id,
      principal: identity.principal,
      name: identity.name,
      access: identity.access,
      state: null,
      ...(identity.data === undefined ? {} : { data: identity.data }),
      seq: joined.reduce((last, { attachment }) => Math.max(last, attachment.seq), 0) + 1
    }
    socket.serializeAttachment(attachment)
    yield* opened(1)
    yield* Effect.annotateCurrentSpan({
      "smithers.presence.outcome": "joined",
      "smithers.presence.connection": id,
      "smithers.presence.participants": joined.length + 1
    })
    yield* Metric.update(Metric.withAttributes(joins, { outcome: "joined" }), 1)
    yield* publish(host, new Set())
    return "joined" as const
  }).pipe(Effect.withSpan("presence.join"))

/**
 * Handles one message from a page. A valid `state` frame becomes this
 * connection's state and everyone receives the roster. A binary or malformed
 * frame closes this socket with `CloseCode.unsupported`, and one over
 * `maxFrameBytes` with `CloseCode.tooBig`; the others then receive the
 * roster without it. A socket that has not joined, or has left, is ignored.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const receive = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>,
  socket: S,
  message: string | ArrayBuffer | ArrayBufferView
): Effect.Effect<void, never, R> =>
  Effect.gen(function*() {
    const attachment = attachmentOf(socket)
    if (attachment === undefined) return
    const refuse = (code: number, outcome: "unsupported" | "too_big") =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(frames, { outcome }), 1),
        remove(host, socket, code)
      )
    if (typeof message !== "string") return yield* refuse(CloseCode.unsupported, "unsupported")
    if (!fits(message, maxFrameBytes)) return yield* refuse(CloseCode.tooBig, "too_big")
    const frame = decodeClientFrame(message)
    if (frame === undefined) return yield* refuse(CloseCode.unsupported, "unsupported")
    socket.serializeAttachment({ ...attachment, state: frame.state })
    yield* Metric.update(Metric.withAttributes(frames, { outcome: "state" }), 1)
    yield* publish(host, new Set())
  })

/**
 * Forgets a socket after the host saw it close or fail, and sends the roster
 * to the others. Leaving a socket that has not joined, or has left, does
 * nothing.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const leave = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>,
  socket: S
): Effect.Effect<void, never, R> =>
  Effect.gen(function*() {
    const attachment = attachmentOf(socket)
    if (attachment === undefined) return
    forget(socket)
    yield* opened(-1)
    yield* publish(host, new Set([attachment.id]))
  })

/**
 * Closes one connection with `code`, forgets it, and sends the roster to the
 * others. A socket that has not joined is closed all the same.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const close = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>,
  socket: S,
  code: number
): Effect.Effect<void, never, R> => Effect.asVoid(remove(host, socket, code))

/**
 * Closes every connection of `principal` with `code` (`CloseCode.noAccess`
 * unless given), tells the others once, and answers how many it closed.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const evict = <S extends RoomSocket<R>, R = never>(
  host: RoomHost<S, R>,
  principal: string,
  code: number = CloseCode.noAccess
): Effect.Effect<number, never, R> =>
  Effect.gen(function*() {
    const evicted = (yield* connections(host)).filter((connection) => connection.participant.principal === principal)
    for (const connection of evicted) {
      forget(connection.socket)
      yield* attempt(() => connection.socket.close(code, ""))
    }
    yield* Effect.annotateCurrentSpan({ "smithers.presence.evicted": evicted.length })
    if (evicted.length === 0) return 0
    yield* opened(-evicted.length)
    yield* Metric.update(evictions, evicted.length)
    yield* publish(host, new Set(evicted.map((connection) => connection.participant.id)))
    return evicted.length
  }).pipe(Effect.withSpan("presence.evict", { attributes: { "smithers.presence.close_code": code } }))
