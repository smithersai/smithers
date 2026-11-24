/**
 * The reconnecting WebSocket a page holds to a terminal: one socket to a host
 * that speaks `TerminalProtocol` from `@smthrs/sandbox`.
 *
 * {@link connect} dials the terminal's URL and keeps dialing it. Binary frames
 * carry bytes: the shell's output arrives at `onOutput`, and {@link Connection}
 * `send` writes keystrokes. Text frames carry control: the host's `ready`
 * opens the terminal with the viewer's access, and its `ended` ends it.
 *
 * - **Keystrokes are never queued.** `send` writes only while the terminal is
 *   open with write access, split into frames of at most
 *   `TerminalProtocol.maxFrameBytes`; anything sent otherwise is dropped,
 *   because input whose delivery is unknown is not safe to repeat.
 * - **Only the latest size is kept.** `resize` remembers it and writes it once
 *   the terminal opens with write access, and again only when it changes.
 * - **Reconnects follow the protocol, as the flow engine decides them.** A
 *   final close (`TerminalProtocol.isFinal`) or an `ended` frame never
 *   redials. Any other close redials on {@link reconnect}, the protocol's
 *   backoff as a `RetryPolicy` from `@smthrs/flow`: `RetryPolicy.schedule`
 *   decides each delay and when to give up, as the engine decides an
 *   action's, on Effect's clock; reaching `ready` resets the count. A socket
 *   lives in the page that shows its bytes, so no durable step holds it.
 * - **The scope owns it.** Closing the scope closes the socket and stops
 *   redialing. An `onOutput` that throws ends the connection, `Closed` with
 *   `TerminalProtocol.CloseCode.failed`.
 *
 * The socket comes from Effect's `Socket.WebSocketConstructor` service;
 * {@link layerWebSocket} provides the browser's own `WebSocket`.
 *
 * @since 1.0.0
 */

import { RetryPolicy } from "@smthrs/flow"
import { TerminalProtocol } from "@smthrs/sandbox"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"

/**
 * Where the terminal stands.
 *
 * - `Connecting`: dialing, or connected and waiting for the host's `ready`;
 * - `Open`: attached, with the viewer's `access`;
 * - `Offline`: closed with `code`, and redialing as reconnect `attempt`
 *   (1 for the first) after its delay;
 * - `Ended`: the host ended the session, for `reason`; final;
 * - `Closed`: closed with `code`, either final or after the last attempt;
 *   final.
 *
 * @category models
 * @since 1.0.0
 */
export type Status =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Open"; readonly access: TerminalProtocol.Access }
  | { readonly _tag: "Offline"; readonly attempt: number; readonly code: number }
  | { readonly _tag: "Ended"; readonly reason: TerminalProtocol.EndReason }
  | { readonly _tag: "Closed"; readonly code: number }

/**
 * An open connection to a terminal.
 *
 * @category models
 * @since 1.0.0
 */
export interface Connection {
  /** Writes keystrokes while open with write access; drops them otherwise. */
  readonly send: (data: string | Uint8Array) => Effect.Effect<void>
  /** Keeps the terminal's size, clamped to the protocol's bounds, and writes it when it can. */
  readonly resize: (cols: number, rows: number) => Effect.Effect<void>
  /** The current status, then every change, until the scope closes. */
  readonly status: Stream.Stream<Status>
}

/**
 * What {@link connect} delivers.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Each binary frame from the host, in order, as a fresh array the callee may keep or transfer. */
  readonly onOutput: (bytes: Uint8Array) => void
  /** How the terminal redials after a close that is not final; {@link reconnect} by default. */
  readonly reconnect?: RetryPolicy.RetryPolicy | undefined
}

/**
 * The protocol's backoff (`TerminalProtocol.reconnect`) as a flow
 * `RetryPolicy`: the first dial, then up to ten redials, after 1 s doubling to
 * 30 s.
 *
 * @category constants
 * @since 1.0.0
 */
export const reconnect: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: TerminalProtocol.reconnect.initialMs,
  factor: 2,
  maxMs: TerminalProtocol.reconnect.maxMs,
  maxAttempts: TerminalProtocol.reconnect.maxAttempts + 1
})

/**
 * Provides `Socket.WebSocketConstructor` with the browser's own `WebSocket`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWebSocket: Layer.Layer<Socket.WebSocketConstructor> = Socket.layerWebSocketConstructorGlobal

type Event =
  | { readonly _tag: "Message"; readonly data: unknown; readonly size: number }
  | { readonly _tag: "Close"; readonly code: number }

/** A close that is not final: the connection redials as its policy decides. */
class Dropped {
  readonly _tag = "@smthrs/platform-browser/TerminalDropped"
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}

/** What one event does to its connection: nothing to report, the host's `ready`, or the connection's end. */
type Step = "continue" | "ready" | "end"

interface Size {
  readonly cols: number
  readonly rows: number
}

/** The code a connection that dropped without a close frame reports. */
const dropped = 1006

const encoder = new TextEncoder()

const dimension = (value: number, max: number): number => Math.min(max, Math.max(1, Math.trunc(value) || 1))

const bytesOf = (data: unknown): Effect.Effect<Uint8Array> => {
  if (data instanceof ArrayBuffer) return Effect.succeed(new Uint8Array(data))
  return Effect.map(Effect.promise(() => (data as Blob).arrayBuffer()), (buffer) => new Uint8Array(buffer))
}

/**
 * Connects to the terminal at `url` and keeps it connected until the scope
 * closes. The connection starts dialing at once; `status` says where it
 * stands.
 *
 * @category constructors
 * @since 1.0.0
 */
export const connect = (
  url: string,
  options: Options
): Effect.Effect<Connection, never, Scope.Scope | Socket.WebSocketConstructor> =>
  Effect.gen(function*() {
    const construct = yield* Socket.WebSocketConstructor
    const status = yield* Effect.acquireRelease(
      SubscriptionRef.make<Status>({ _tag: "Connecting" }),
      (ref) => PubSub.shutdown(ref.pubsub)
    )
    const live: {
      socket: Socket.WebSocketLike | undefined
      access: TerminalProtocol.Access | undefined
      size: Size | undefined
      sent: Size | undefined
    } = { socket: undefined, access: undefined, size: undefined, sent: undefined }

    const writeSize = () => {
      const { access, sent, size, socket } = live
      if (socket === undefined || access !== "write" || size === undefined) return
      if (sent?.cols === size.cols && sent.rows === size.rows) return
      live.sent = size
      socket.send(TerminalProtocol.encodeResize(size.cols, size.rows))
    }

    /** Opens one socket whose events land in `events`; returns its hang-up. */
    const dial = (events: Queue.Queue<Event>, receive: (data: unknown) => void): () => void => {
      let socket: Socket.WebSocketLike
      try {
        socket = construct(url)
      } catch {
        Queue.offerUnsafe(events, { _tag: "Close", code: dropped })
        return () => {}
      }
      ;(socket as { binaryType?: string }).binaryType = "arraybuffer"
      const onMessage = (event: Socket.WebSocketEvent) => {
        receive(event.data)
      }
      // A close event always follows an error event.
      const onError = () => {}
      const onClose = (event: Socket.WebSocketEvent) => {
        live.socket = undefined
        live.access = undefined
        Queue.offerUnsafe(events, { _tag: "Close", code: (event as CloseEvent).code })
      }
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)
      live.socket = socket
      live.sent = undefined
      return () => {
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
        live.socket = undefined
        live.access = undefined
        socket.close(1000)
      }
    }

    /**
     * One connection, from dialing to its end: it emits when the host's `ready`
     * opens the terminal, ends at the host's `ended` or a final close, and fails
     * with `Dropped` at any other close.
     */
    const session: Stream.Stream<"ready", Dropped> = Stream.unwrap(Effect.gen(function*() {
      if ((yield* SubscriptionRef.get(status))._tag !== "Connecting") {
        yield* SubscriptionRef.set(status, { _tag: "Connecting" })
      }
      // Count frames until delivery, including frames already pulled into a stream chunk.
      const capacity = 64
      const events = yield* Queue.bounded<Event>(capacity + 1)
      const rejected = yield* Deferred.make<number>()
      let retained = 0
      let frames = 0
      const receive = (data: unknown) => {
        if (Deferred.isDoneUnsafe(rejected)) return
        if (
          typeof data !== "string" && !(data instanceof Blob) && !(data instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(data)
        ) {
          Deferred.doneUnsafe(rejected, Effect.succeed(TerminalProtocol.CloseCode.unsupported))
          return
        }
        const limit = TerminalProtocol.maxFrameBytes
        const size = typeof data === "string"
          ? (data.length > limit ? data.length : encoder.encode(data).length)
          : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? data.byteLength
          : data.size
        if (size > limit || frames >= capacity || retained + size > 16 * limit) {
          Deferred.doneUnsafe(rejected, Effect.succeed(TerminalProtocol.CloseCode.tooBig))
          return
        }
        frames++
        retained += size
        const frame = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
          : data
        Queue.offerUnsafe(events, { _tag: "Message", data: frame, size })
      }
      yield* Effect.acquireRelease(Effect.sync(() => dial(events, receive)), (hangUp) => Effect.sync(hangUp))
      const step = (event: Event): Effect.Effect<Step, Dropped> => {
        if (event._tag === "Close") {
          return TerminalProtocol.isFinal(event.code)
            ? Effect.as(SubscriptionRef.set(status, { _tag: "Closed", code: event.code }), "end")
            : Effect.fail(new Dropped(event.code))
        }
        if (typeof event.data !== "string") {
          return Effect.map(bytesOf(event.data), (bytes) => {
            options.onOutput(bytes)
            return "continue"
          })
        }
        const control = TerminalProtocol.decodeServerControl(event.data)
        if (control?.type === "ready") {
          live.access = control.access
          writeSize()
          return Effect.as(SubscriptionRef.set(status, { _tag: "Open", access: control.access }), "ready")
        }
        if (control?.type === "ended") {
          live.access = undefined
          return Effect.as(SubscriptionRef.set(status, { _tag: "Ended", reason: control.reason }), "end")
        }
        return Effect.succeed("continue")
      }
      return Stream.fromQueue(events).pipe(
        Stream.mapEffect((event) =>
          step(event).pipe(Effect.ensuring(Effect.sync(() => {
            if (event._tag === "Message") {
              frames--
              retained -= event.size
            }
          })))
        ),
        Stream.interruptWhen(
          Deferred.await(rejected).pipe(Effect.flatMap((code) => SubscriptionRef.set(status, { _tag: "Closed", code })))
        ),
        Stream.takeWhile((step) => step !== "end"),
        Stream.filter((step): step is "ready" => step === "ready")
      )
    }))

    const redial = RetryPolicy.schedule<Dropped>(options.reconnect ?? reconnect).pipe(
      Schedule.tap(({ input, output }) =>
        SubscriptionRef.set(status, { _tag: "Offline", attempt: output, code: input.code })
      )
    )
    yield* session.pipe(
      // Each emit is a `ready`, which starts the count over.
      Stream.retry(redial),
      Stream.runDrain,
      // The policy gave up: closed with the last close's code.
      Effect.catch((dropped) => SubscriptionRef.set(status, { _tag: "Closed", code: dropped.code })),
      // A defect, such as an `onOutput` that throws, ends the connection as failed.
      Effect.catchDefect((defect) =>
        Effect.logWarning("browser.terminal.closed").pipe(
          Effect.annotateLogs({ outcome: "defect", "error.type": RetryPolicy.errorTag(defect) ?? "unknown" }),
          Effect.andThen(SubscriptionRef.set(status, { _tag: "Closed", code: TerminalProtocol.CloseCode.failed }))
        )
      ),
      Effect.forkScoped
    )

    return {
      send: (data) =>
        Effect.sync(() => {
          const socket = live.socket
          if (socket === undefined || live.access !== "write") return
          const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
          for (let at = 0; at < bytes.byteLength; at += TerminalProtocol.maxFrameBytes) {
            socket.send(bytes.subarray(at, at + TerminalProtocol.maxFrameBytes))
          }
        }),
      resize: (cols, rows) =>
        Effect.sync(() => {
          live.size = {
            cols: dimension(cols, TerminalProtocol.maxCols),
            rows: dimension(rows, TerminalProtocol.maxRows)
          }
          writeSize()
        }),
      status: SubscriptionRef.changes(status)
    }
  })
