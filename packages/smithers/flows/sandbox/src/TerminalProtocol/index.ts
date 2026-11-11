/**
 * The wire protocol between a browser terminal and the host that attaches it
 * to a shell in a sandbox: one WebSocket per viewer.
 *
 * - **Binary frames carry bytes.** From the host, the shell's output; from a
 *   viewer who may write, keystrokes. The host drops every byte from a
 *   read-only viewer, its terminal's automatic replies included.
 * - **Text frames carry JSON control.** A writer sends `resize`; the host
 *   sends `ready` once attached and `ended` before a close that ends the
 *   session.
 * - **Frames are capped** at {@link maxFrameBytes}; a larger one closes the
 *   socket with {@link CloseCode.tooBig}, a malformed control frame with
 *   {@link CloseCode.unsupported}.
 * - **Close codes say whether to come back.** {@link isFinal} is true for an
 *   ended session, no access, and a protocol violation; a dropped or failed
 *   connection reconnects after {@link reconnect}'s backoff.
 *
 * Keystrokes are never queued while disconnected: input whose delivery is
 * unknown is not safe to repeat. The module is pure, so the host in a
 * Worker and the client in a browser share one definition.
 *
 * @since 1.0.0-rc.17
 */

import { RetryPolicy } from "@smthrs/flow"
import * as Option from "effect/Option"

/**
 * The largest frame either side sends or accepts: 64 KiB.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const maxFrameBytes = 64 * 1024

/**
 * The close codes the host uses.
 *
 * - `ended` (1000): the session ended; final.
 * - `unsupported` (1003): a malformed control frame; final.
 * - `noAccess` (1008): the viewer may not attach, or lost access; final.
 * - `tooBig` (1009): a frame over {@link maxFrameBytes}; final.
 * - `failed` (1011): the host failed; the client reconnects.
 *
 * A connection that drops without a close frame arrives as 1006 and
 * reconnects too.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const CloseCode = {
  ended: 1000,
  unsupported: 1003,
  noAccess: 1008,
  tooBig: 1009,
  failed: 1011
} as const

/**
 * Whether a close code ends the connection for good: no reconnect follows.
 *
 * @category close codes
 * @since 1.0.0-rc.17
 */
export const isFinal = (code: number): boolean =>
  code === CloseCode.ended || code === CloseCode.unsupported || code === CloseCode.noAccess ||
  code === CloseCode.tooBig

/**
 * How a client reconnects after a close that is not final: after
 * `initialMs`, doubling up to `maxMs`, at most `maxAttempts` times in a row.
 * A connection that reaches `ready` resets the count.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const reconnect = { initialMs: 1_000, maxMs: 30_000, maxAttempts: 10 } as const

/** {@link reconnect} as a retry policy; the first connection counts as an attempt. */
const reconnectPolicy = RetryPolicy.make({
  initialMs: reconnect.initialMs,
  factor: 2,
  maxMs: reconnect.maxMs,
  maxAttempts: reconnect.maxAttempts + 1
})

/**
 * The delay before reconnect attempt `attempt` (1 for the first), or
 * `undefined` once `reconnect.maxAttempts` attempts have been spent.
 *
 * @category close codes
 * @since 1.0.0-rc.17
 */
export const reconnectDelay = (attempt: number): number | undefined =>
  Option.getOrUndefined(RetryPolicy.nextDelay(reconnectPolicy, attempt))

/**
 * What the viewer may do: type into the shell (`write`) or only watch
 * (`read`).
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Access = "write" | "read"

/**
 * Why a session ended: its owner closed it, its machine slept, its machine
 * was lost, or the owner's access was revoked.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type EndReason = "closed" | "slept" | "lost" | "revoked"

const endReasons: ReadonlyArray<EndReason> = ["closed", "slept", "lost", "revoked"]

/**
 * The widest terminal a resize may ask for.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const maxCols = 1_000

/**
 * The tallest terminal a resize may ask for.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const maxRows = 500

/**
 * A control frame from a viewer: a writer's terminal size.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Resize {
  readonly type: "resize"
  readonly cols: number
  readonly rows: number
}

/**
 * A control frame from the host: attached, with the viewer's access; or the
 * session ended, and why.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type ServerControl =
  | { readonly type: "ready"; readonly access: Access }
  | { readonly type: "ended"; readonly reason: EndReason }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parse = (text: string): unknown => {
  if (text.length > maxFrameBytes) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isDimension = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max

/**
 * Encodes a writer's terminal size as a text frame.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export const encodeResize = (cols: number, rows: number): string => JSON.stringify({ type: "resize", cols, rows })

/**
 * Decodes a viewer's text frame: a `resize` with whole `cols` from 1 to
 * {@link maxCols} and `rows` from 1 to {@link maxRows}, or `undefined` for
 * anything else.
 *
 * @category decoding
 * @since 1.0.0-rc.17
 */
export const decodeClientControl = (text: string): Resize | undefined => {
  const value = parse(text)
  if (!isRecord(value) || value.type !== "resize") return undefined
  return isDimension(value.cols, maxCols) && isDimension(value.rows, maxRows)
    ? { type: "resize", cols: value.cols, rows: value.rows }
    : undefined
}

/**
 * Encodes a host control frame as a text frame.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export const encodeServerControl = (control: ServerControl): string => JSON.stringify(control)

/**
 * Decodes a host's text frame, or `undefined` for anything that isn't a
 * `ready` or `ended` frame this protocol defines.
 *
 * @category decoding
 * @since 1.0.0-rc.17
 */
export const decodeServerControl = (text: string): ServerControl | undefined => {
  const value = parse(text)
  if (!isRecord(value)) return undefined
  if (value.type === "ready" && (value.access === "write" || value.access === "read")) {
    return { type: "ready", access: value.access }
  }
  if (value.type === "ended" && endReasons.includes(value.reason as EndReason)) {
    return { type: "ended", reason: value.reason as EndReason }
  }
  return undefined
}
