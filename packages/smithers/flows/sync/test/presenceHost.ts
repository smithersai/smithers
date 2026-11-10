/**
 * An in-memory presence host shaped like a hibernating Durable Object: every
 * read of `sockets` hands out fresh wrappers over the same raw sockets, the
 * way Alchemy's `state.getWebSockets()` does, and an attachment survives only
 * as a structured clone. A room that kept anything in memory, or compared
 * sockets by identity, fails against it.
 */
import * as Effect from "effect/Effect"
import type * as PresenceRoom from "../src/PresenceRoom.vibe"

/** How a raw socket's send or close misbehaves: fail, die, or throw before returning an Effect. */
export type Fault = "fail" | "die" | "throw" | undefined

/** One accepted WebSocket, as the runtime holds it across hibernation. */
export interface Raw {
  attachment: unknown
  /** Every text frame the room sent it. */
  readonly sent: Array<string>
  /** The close the room asked for, once it did. */
  closed: { readonly code: number; readonly reason: string } | undefined
  sendFault: Fault
  closeFault: Fault
  /** Called on every send that succeeds, for wiring a page to the room. */
  onSend: ((text: string) => void) | undefined
}

/** A wrapper the host hands out; `raw` is what the test inspects. */
export interface TestSocket extends PresenceRoom.RoomSocket {
  readonly raw: Raw
}

const faulty = (fault: Fault, run: () => void): Effect.Effect<void, unknown> => {
  switch (fault) {
    case "fail":
      return Effect.fail("socket closed")
    case "die":
      return Effect.die(new Error("socket closed"))
    case "throw":
      throw new TypeError("WebSocket send() after close()")
    default:
      return Effect.sync(run)
  }
}

const wrap = (raw: Raw): TestSocket => ({
  raw,
  send: (text) =>
    faulty(raw.sendFault, () => {
      // workerd throws on a send after close.
      if (raw.closed !== undefined) throw new TypeError("WebSocket send() after close()")
      raw.sent.push(text)
      raw.onSend?.(text)
    }),
  close: (code, reason) =>
    faulty(raw.closeFault, () => {
      raw.closed = { code, reason }
    }),
  serializeAttachment: (value) => {
    raw.attachment = structuredClone(value)
  },
  deserializeAttachment: <T>() => (raw.attachment === undefined ? null : structuredClone(raw.attachment)) as T | null
})

/** A room host over `raws`; each `sockets` read wraps them afresh. */
export const hostOver = (raws: Array<Raw>): PresenceRoom.RoomHost<TestSocket> => ({
  sockets: Effect.sync(() => raws.map(wrap))
})

/** A host and a way to accept sockets into it. */
export const makeHost = () => {
  const raws: Array<Raw> = []
  return {
    raws,
    host: hostOver(raws),
    /** Accepts a new socket, as a Durable Object's `upgrade` does, and answers a wrapper for it. */
    accept: (): TestSocket => {
      const raw: Raw = {
        attachment: undefined,
        sent: [],
        closed: undefined,
        sendFault: undefined,
        closeFault: undefined,
        onSend: undefined
      }
      raws.push(raw)
      return wrap(raw)
    },
    /** Removes a socket from the host, as the runtime does once its close completes. */
    drop: (socket: TestSocket) => {
      raws.splice(raws.indexOf(socket.raw), 1)
    }
  }
}
