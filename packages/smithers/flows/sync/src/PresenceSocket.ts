/**
 * The reconnecting WebSocket a page holds to a presence room: one socket to a
 * host that speaks `PresenceProtocol`.
 *
 * {@link connect} dials the room's URL and keeps dialing it. The room's first
 * roster opens the connection; every roster after it updates `roster`.
 *
 * - **Only the latest state is kept.** `set` remembers it and sends it while
 *   open, and again after every reconnect, since a fresh connection joins
 *   with no state. A state the room already holds is not sent again.
 * - **Reconnects follow the protocol.** A final close
 *   (`PresenceProtocol.isFinal`) never redials. Any other close redials after
 *   `PresenceProtocol.reconnectDelay(attempt)` on Effect's clock, until the
 *   attempts run out; a roster resets the count.
 * - **The scope owns it.** Closing the scope closes the socket with 1000 and
 *   stops redialing.
 *
 * The socket comes from Effect's `Socket.WebSocketConstructor` service. In a
 * browser, `Socket.layerWebSocketConstructorGlobal` from `effect/socket/Socket`
 * provides the page's own `WebSocket`.
 *
 * @since 1.0.0-rc.17
 */

import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import type * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { fits } from "./internal/PresenceWire.ts"
import {
  decodeServerFrame,
  encodeClientFrame,
  isFinal,
  maxStateBytes,
  type Participant,
  reconnectDelay
} from "./PresenceProtocol.vibe"

/**
 * Where the connection stands.
 *
 * - `Connecting`: dialing, or connected and waiting for the room's first
 *   roster;
 * - `Open`: joined, as connection `self`;
 * - `Offline`: closed with `code`, and redialing as reconnect `attempt`
 *   (1 for the first) after its delay;
 * - `Closed`: closed with `code`, either final or after the last attempt;
 *   final.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Status =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Open"; readonly self: string }
  | { readonly _tag: "Offline"; readonly attempt: number; readonly code: number }
  | { readonly _tag: "Closed"; readonly code: number }

/**
 * An open connection to a presence room.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Connection {
  /**
   * Keeps `state` as this participant's latest; sends it now when open and
   * again after every reconnect. Only the latest is ever sent. A state over
   * `PresenceProtocol.maxStateBytes` is the caller's bug and dies.
   */
  readonly set: (state: string | null) => Effect.Effect<void>
  /** The current roster, then every change, until the scope closes; empty while not open. */
  readonly roster: Stream.Stream<ReadonlyArray<Participant>>
  /** The current status, then every change, until the scope closes. */
  readonly status: Stream.Stream<Status>
}

type Event =
  | { readonly _tag: "Message"; readonly data: unknown }
  | { readonly _tag: "Close"; readonly code: number }

interface Outcome {
  readonly code: number
  readonly opened: boolean
}

/** The code a connection that dropped without a close frame reports. */
const dropped = 1006

const empty: ReadonlyArray<Participant> = []

/**
 * Connects to the presence room at `url` and keeps it connected until the
 * scope closes. The connection starts dialing at once; `status` says where it
 * stands.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const connect = (url: string): Effect.Effect<Connection, never, Scope.Scope | Socket.WebSocketConstructor> =>
  Effect.gen(function*() {
    const construct = yield* Socket.WebSocketConstructor
    const status = yield* Effect.acquireRelease(
      SubscriptionRef.make<Status>({ _tag: "Connecting" }),
      (ref) => PubSub.shutdown(ref.pubsub)
    )
    const roster = yield* Effect.acquireRelease(
      SubscriptionRef.make(empty),
      (ref) => PubSub.shutdown(ref.pubsub)
    )
    const live: {
      socket: Socket.WebSocketLike | undefined
      open: boolean
      state: string | null
      sent: string | null
    } = { socket: undefined, open: false, state: null, sent: null }

    /** Sends the latest state once open, unless the room already holds it. */
    const writeState = () => {
      const { open, sent, socket, state } = live
      if (socket === undefined || !open || state === sent) return
      live.sent = state
      socket.send(encodeClientFrame({ type: "state", state }))
    }

    /** Opens one socket whose events land in `events`; returns its hang-up. */
    const dial = (events: Queue.Queue<Event>): () => void => {
      let socket: Socket.WebSocketLike
      try {
        socket = construct(url)
      } catch {
        Queue.offerUnsafe(events, { _tag: "Close", code: dropped })
        return () => {}
      }
      const onMessage = (event: Socket.WebSocketEvent) => {
        Queue.offerUnsafe(events, { _tag: "Message", data: event.data })
      }
      // A close event always follows an error event.
      const onError = () => {}
      const onClose = (event: Socket.WebSocketEvent) => {
        live.socket = undefined
        live.open = false
        Queue.offerUnsafe(events, { _tag: "Close", code: event.code ?? dropped })
      }
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)
      live.socket = socket
      // A fresh connection joins with no state.
      live.sent = null
      return () => {
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
        live.socket = undefined
        live.open = false
        socket.close(1000)
      }
    }

    /** One connection, from dialing to its close. */
    const session: Effect.Effect<Outcome> = Effect.scoped(Effect.gen(function*() {
      const events = yield* Queue.unbounded<Event>()
      yield* Effect.acquireRelease(Effect.sync(() => dial(events)), (hangUp) => Effect.sync(hangUp))
      let opened = false
      while (true) {
        const event = yield* Queue.take(events)
        if (event._tag === "Close") return { code: event.code, opened }
        const frame = typeof event.data === "string" ? decodeServerFrame(event.data) : undefined
        if (frame === undefined) continue
        yield* SubscriptionRef.set(roster, frame.participants)
        if (!opened) {
          opened = true
          live.open = true
          writeState()
          yield* SubscriptionRef.set(status, { _tag: "Open", self: frame.self })
        }
      }
    }))

    const run = Effect.gen(function*() {
      let attempt = 0
      while (true) {
        const outcome = yield* session
        if ((yield* SubscriptionRef.get(roster)).length > 0) yield* SubscriptionRef.set(roster, empty)
        attempt = outcome.opened ? 1 : attempt + 1
        const delay = isFinal(outcome.code) ? undefined : reconnectDelay(attempt)
        if (delay === undefined) return yield* SubscriptionRef.set(status, { _tag: "Closed", code: outcome.code })
        yield* SubscriptionRef.set(status, { _tag: "Offline", attempt, code: outcome.code })
        yield* Effect.sleep(delay)
        yield* SubscriptionRef.set(status, { _tag: "Connecting" })
      }
    })
    yield* Effect.forkScoped(run)

    return {
      set: (state) =>
        state !== null && !fits(state, maxStateBytes)
          ? Effect.die(
            PlatformError.badArgument({
              module: "PresenceSocket",
              method: "set",
              description: `state over ${maxStateBytes} bytes`
            })
          )
          : Effect.sync(() => {
            live.state = state
            writeState()
          }),
      roster: SubscriptionRef.changes(roster),
      status: SubscriptionRef.changes(status)
    }
  })
