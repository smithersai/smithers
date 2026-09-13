/**
 * Dropping the WebSocket a control client is streaming over.
 *
 * `@smthrs/control`'s `ControlClient` takes its socket from
 * `Socket.WebSocketConstructor`, the same seam `@smthrs/cli` uses to attach a
 * bearer credential. Handing it {@link trackingWebSocketConstructor} keeps the
 * real `ws` client and only records the instances, so a fault suite can reach
 * the live socket and cut it the way a network does.
 *
 * @since 1.0.0
 */
import type * as Socket from "effect/unstable/socket/Socket"
import * as NodeWebSocket from "../../../src/internal/NodeWebSocket.ts"

/**
 * How a socket is taken away.
 *
 * `abrupt` destroys the TCP connection without a close frame, so the peer
 * learns about it from a read error — the shape a lost network gives. `close`
 * sends a normal closing handshake.
 *
 * @since 1.0.0
 * @category models
 */
export type DropMode = "abrupt" | "close"

/**
 * The `ws` ready states, so a case can name the state it expects instead of
 * repeating a number.
 *
 * @since 1.0.0
 * @category models
 */
export const SocketState = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3
} as const

/**
 * What one drop did.
 *
 * `cut` separates a real network fault from a no-op against a socket that had
 * already gone away. A case whose reader has already released its client cuts
 * nothing, and without this it still reads as though it had.
 *
 * @since 1.0.0
 * @category models
 */
export interface DropReport {
  /** The socket's `readyState` when the drop was asked for. */
  readonly stateBefore: number
  /** Whether this call actually cut a connection that was still there. */
  readonly cut: boolean
}

/** The half of the `ws` client surface this harness drives. */
export interface DroppableSocket {
  readonly readyState: number
  close: (code?: number) => void
  terminate?: () => void
  once: (event: "close", listener: () => void) => unknown
}

/**
 * Drops one socket and resolves when it reports closed, reporting whether there
 * was anything left to drop.
 *
 * @since 1.0.0
 * @category constructors
 */
export const dropWebSocket = async (socket: DroppableSocket, mode: DropMode = "abrupt"): Promise<DropReport> => {
  const stateBefore = socket.readyState
  if (stateBefore === SocketState.closed) return { stateBefore, cut: false }
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
  })
  if (mode === "close") socket.close(1000)
  else if (typeof socket.terminate === "function") socket.terminate()
  else socket.close(1006)
  await closed
  return { stateBefore, cut: true }
}

/**
 * A tracked `Socket.WebSocketConstructor`.
 *
 * @since 1.0.0
 * @category models
 */
export interface TrackedWebSockets {
  /** The value to provide as `Socket.WebSocketConstructor`. */
  readonly construct: (address: string, options?: Socket.WebSocketConstructorOptions) => globalThis.WebSocket
  /** Every socket constructed so far, oldest first. */
  readonly sockets: ReadonlyArray<DroppableSocket>
  /** How many sockets have been constructed. A reconnect is a second one. */
  readonly opened: () => number
  /**
   * The most recently constructed socket's `readyState`, or `undefined` when
   * none has been constructed. A case that means to cut a live connection
   * asserts on this before it cuts.
   */
  readonly latestState: () => number | undefined
  /** Drops the most recently constructed socket. */
  readonly dropLatest: (mode?: DropMode) => Promise<DropReport>
}

/**
 * Builds a WebSocket constructor that keeps every socket it makes.
 *
 * `credential` is attached as a bearer header, matching what the CLI's remote
 * transport does, so a tracked client authenticates exactly like a real one.
 *
 * @since 1.0.0
 * @category constructors
 */
export const trackingWebSocketConstructor = (credential?: string): TrackedWebSockets => {
  const sockets: Array<DroppableSocket> = []
  const construct = (address: string, options?: Socket.WebSocketConstructorOptions): globalThis.WebSocket => {
    const socket = NodeWebSocket.make(credential)(address, options)
    sockets.push(socket as unknown as DroppableSocket)
    return socket as unknown as globalThis.WebSocket
  }
  return {
    construct,
    sockets,
    opened: () => sockets.length,
    latestState: () => sockets[sockets.length - 1]?.readyState,
    dropLatest: async (mode: DropMode = "abrupt") => {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) throw new Error("dropLatest: no socket has been constructed yet")
      return await dropWebSocket(socket, mode)
    }
  }
}
