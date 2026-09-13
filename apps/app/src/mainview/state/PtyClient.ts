import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createTopicSocket } from "./TopicSocket"

export interface PtyAttachment {
  readonly onOutput: (data: string) => void
  readonly onExit: (code: number | null) => void
  readonly onUnavailable?: () => void
}
export interface PtyClient {
  readonly attach: (sessionId: string, attachment: PtyAttachment) => () => void
  readonly input: (sessionId: string, data: string) => void
  readonly resize: (sessionId: string, cols: number, rows: number) => Promise<void>
  /** Detach all viewers; process lifetime belongs to the daemon. */
  readonly dispose: () => void
}
export interface PtyClientOptions {
  readonly http: FetchLike
  readonly baseUrl: string
  readonly socketUrl: () => string | undefined
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

export const pageSocketUrl = (): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const { protocol, host } = window.location
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`
}

interface Stream {
  cursor: number
  tail: string
  exit?: number | null
  missing?: boolean
}
/** Absolute output cursors are UTF-16 offsets, shared with Pty.replay. */
export const createPtyClient = (options: PtyClientOptions): PtyClient => {
  const queue: Array<{ sessionId: string; text: string }> = []
  const subscribed = new Set<string>()
  const streams = new Map<string, Stream>()
  let connected = false
  const topics = createTopicSocket<PtyAttachment>({
    socketUrl: options.socketUrl,
    socketProtocols: options.socketProtocols,
    reconnectMs: options.reconnectMs,
    topicOf: (id) => `pty:${id}`,
    subscription: (id) => ({ cursor: streams.get(id)?.cursor ?? 0 }),
    onSubscribe: (id) => { subscribed.delete(id) },
    onDetach: (id) => {
      subscribed.delete(id)
      streams.delete(id)
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.sessionId === id) queue.splice(i, 1)
    },
    onClose: () => {
      subscribed.clear()
      queue.length = 0
      // There is no input acknowledgement: never repeat a command after a drop.
      connected = true
    },
    onMessage: (raw, attachments) => {
      if (typeof raw !== "object" || raw === null) return
      const frame = raw as Record<string, unknown>
      if (frame.type === "subscribed" && typeof frame.topic === "string" && frame.topic.startsWith("pty:")) {
        const id = frame.topic.slice(4)
        if (attachments(id) === undefined) return
        subscribed.add(id)
        connected = true
        for (let i = 0; i < queue.length;) {
          const entry = queue[i]!
          if (entry.sessionId !== id) { i++; continue }
          topics.send(entry.text)
          queue.splice(i, 1)
        }
        return
      }
      if (typeof frame.sessionId !== "string") return
      const stream = streams.get(frame.sessionId)
      const listeners = attachments(frame.sessionId)
      if (stream === undefined || listeners === undefined) return
      if (frame.type === "pty.missing") {
        if (!stream.missing) for (const listener of listeners) listener.onUnavailable?.()
        stream.missing = true
        return
      }
      if (frame.type === "pty.output" || frame.type === "pty.replay") {
        if (typeof frame.data !== "string") return
        const positioned = typeof frame.start === "number" && Number.isSafeInteger(frame.start) && frame.start >= 0 &&
          typeof frame.cursor === "number" && Number.isSafeInteger(frame.cursor) && frame.cursor === frame.start + frame.data.length
        // Legacy output can still be read, but replay always requires a position.
        if (frame.type === "pty.replay" && (!positioned || typeof frame.alive !== "boolean" || typeof frame.truncated !== "boolean")) return
        const start = positioned ? frame.start as number : stream.cursor
        const cursor = positioned ? frame.cursor as number : start + frame.data.length
        let data = frame.data.slice(Math.max(0, stream.cursor - start))
        if (start > stream.cursor || (frame.type === "pty.replay" && frame.truncated)) {
          data = "\r\n[Earlier terminal output is no longer retained.]\r\n" + data
        }
        stream.cursor = Math.max(stream.cursor, cursor)
        if (data !== "") {
          stream.tail = (stream.tail + data).slice(-64 * 1024)
          if (/^[\udc00-\udfff]/.test(stream.tail)) stream.tail = stream.tail.slice(1)
          for (const listener of listeners) listener.onOutput(data)
        }
      }
      if ((frame.type === "pty.exit" || (frame.type === "pty.replay" && !frame.alive)) && stream.exit === undefined) {
        stream.exit = typeof frame.code === "number" ? frame.code : null
        for (const listener of listeners) listener.onExit(stream.exit)
      }
    }
  })
  return {
    attach: (id, attachment) => {
      const previous = streams.get(id)
      if (previous === undefined) streams.set(id, { cursor: 0, tail: "" })
      else {
        if (previous.tail !== "") attachment.onOutput(previous.tail)
        if (previous.exit !== undefined) attachment.onExit(previous.exit)
        if (previous.missing) attachment.onUnavailable?.()
      }
      return topics.attach(id, attachment)
    },
    input: (sessionId, data) => {
      if (streams.get(sessionId)?.missing || streams.get(sessionId)?.exit !== undefined) return
      const text = JSON.stringify({ type: "pty.input", sessionId, data })
      if (subscribed.has(sessionId) && topics.send(text)) return
      // Only the first connection can buffer input, with a bounded queue.
      // Keystrokes during a reconnect are never silently executed later.
      if (!connected && queue.reduce((bytes, entry) => bytes + entry.text.length, 0) + text.length <= 64 * 1024) {
        queue.push({ sessionId, text })
      }
      topics.ensure()
    },
    resize: async (sessionId, cols, rows) => {
      try {
        await options.http(`${options.baseUrl}/api/pty/${encodeURIComponent(sessionId)}/resize`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols, rows })
        })
      } catch { /* The next fit retries. */ }
    },
    dispose: () => {
      queue.length = 0
      subscribed.clear()
      streams.clear()
      topics.dispose()
    }
  }
}
