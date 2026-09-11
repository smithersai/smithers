import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createTopicSocket } from "./TopicSocket"

/*
 * The PTY transport (docs/LOCAL-APP.md "HTTP and WebSocket API"): one
 * WebSocket to `/ws` shared by every terminal and harness tab, plus the
 * resize POST. A tab attaches to its `pty:<sessionId>` topic and receives
 * that session's output and exit; keystrokes go back as `pty.input` frames.
 *
 * TopicSocket.ts owns the socket: it opens on the first attachment and
 * reconnects while attachments exist, re-subscribing every live topic. What
 * is the terminal's own is the acknowledgement queue below. Frames sent
 * before the server acknowledges the topic subscription wait for it, so a
 * fast shell cannot publish output before the renderer is listening.
 */

export interface PtyAttachment {
  readonly onOutput: (data: string) => void
  readonly onExit: (code: number | null) => void
}

export interface PtyClient {
  /** Subscribe to one session's output; the returned function detaches. */
  readonly attach: (sessionId: string, attachment: PtyAttachment) => () => void
  /** Text the user typed, forwarded to the session's stdin. */
  readonly input: (sessionId: string, data: string) => void
  /** `POST /api/pty/:id/resize`; a failure is swallowed (the next fit retries). */
  readonly resize: (sessionId: string, cols: number, rows: number) => Promise<void>
  /** Close the socket and forget every attachment. */
  readonly dispose: () => void
}

export interface PtyClientOptions {
  readonly http: FetchLike
  readonly baseUrl: string
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

type ServerFrame =
  | { readonly type: "pty.output"; readonly sessionId: string; readonly data: string }
  | { readonly type: "pty.exit"; readonly sessionId: string; readonly code: number | null }
  | { readonly type: "subscribed"; readonly topic: string }

/** One server frame, out of the JSON TopicSocket.ts already parsed. */
const parseFrame = (raw: unknown): ServerFrame | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const { type, sessionId } = raw as { type?: unknown; sessionId?: unknown }
  if (type === "subscribed") {
    const { topic } = raw as { topic?: unknown }
    return typeof topic === "string" ? { type, topic } : undefined
  }
  if (typeof sessionId !== "string") return undefined
  if (type === "pty.output") {
    const { data } = raw as { data?: unknown }
    return typeof data === "string" ? { type, sessionId, data } : undefined
  }
  if (type === "pty.exit") {
    const { code } = raw as { code?: unknown }
    return { type, sessionId, code: typeof code === "number" ? code : null }
  }
  return undefined
}

/** The same-origin `/ws` URL of the page, or undefined outside a browser. */
export const pageSocketUrl = (): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const { protocol, host } = window.location
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`
}

export const createPtyClient = (options: PtyClientOptions): PtyClient => {
  const queue: Array<{ readonly sessionId: string; readonly text: string }> = []
  /*
   * The backend acknowledges each subscription. Queued input waits for that
   * acknowledgement so a fast shell cannot publish output before this socket
   * is actually listening to its topic.
   */
  const subscribed = new Set<string>()

  const topics = createTopicSocket<PtyAttachment>({
    socketUrl: options.socketUrl,
    socketProtocols: options.socketProtocols,
    reconnectMs: options.reconnectMs,
    topicOf: (sessionId) => `pty:${sessionId}`,
    /* A fresh subscription is unacknowledged again, on the first attach and after every reconnect. */
    onSubscribe: (sessionId) => void subscribed.delete(sessionId),
    onDetach: (sessionId) => {
      subscribed.delete(sessionId)
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.sessionId === sessionId) queue.splice(index, 1)
      }
    },
    onClose: () => subscribed.clear(),
    onMessage: (message, attachments) => {
      const frame = parseFrame(message)
      if (frame === undefined) return
      if (frame.type === "subscribed") {
        if (!frame.topic.startsWith("pty:")) return
        const sessionId = frame.topic.slice("pty:".length)
        if (attachments(sessionId) === undefined) return
        subscribed.add(sessionId)
        flush(sessionId)
        return
      }
      const listeners = attachments(frame.sessionId)
      if (listeners === undefined) return
      for (const listener of listeners) {
        if (frame.type === "pty.output") listener.onOutput(frame.data)
        else listener.onExit(frame.code)
      }
    }
  })

  const flush = (sessionId: string): void => {
    if (!topics.isOpen() || !subscribed.has(sessionId)) return
    for (let index = 0; index < queue.length;) {
      const queued = queue[index]!
      if (queued.sessionId !== sessionId) {
        index += 1
        continue
      }
      topics.send(queued.text)
      queue.splice(index, 1)
    }
  }

  const send = (frame: Record<string, unknown> & { readonly sessionId: string }): void => {
    const text = JSON.stringify(frame)
    if (subscribed.has(frame.sessionId) && topics.send(text)) return
    queue.push({ sessionId: frame.sessionId, text })
    topics.ensure()
  }

  const input: PtyClient["input"] = (sessionId, data) => {
    send({ type: "pty.input", sessionId, data })
  }

  const resize: PtyClient["resize"] = async (sessionId, cols, rows) => {
    try {
      await options.http(`${options.baseUrl}/api/pty/${encodeURIComponent(sessionId)}/resize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols, rows })
      })
    } catch {
      // The next fit sends the geometry again; a missed resize is not an error state.
    }
  }

  const dispose = (): void => {
    queue.length = 0
    subscribed.clear()
    topics.dispose()
  }

  return { attach: topics.attach, input, resize, dispose }
}
