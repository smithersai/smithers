/*
 * JSON-RPC 2.0 over a child's stdio with the LSP base protocol's
 * `Content-Length` framing (LSP 3.17 "Base Protocol"). No dependency: one
 * reader loop over stdout, one writer on stdin, ids and timeouts here.
 * Notifications from the server go to `onNotification`; the server's own
 * requests (`workspace/configuration`, `client/registerCapability`) are
 * answered by `onRequest`, `null` when it declines.
 */

export type JsonRpcErrorKind = "timeout" | "closed" | "busy" | "response"

export class JsonRpcError extends Error {
  constructor(
    readonly kind: JsonRpcErrorKind,
    message: string,
    /** The server's error code when `kind` is "response". */
    readonly code?: number
  ) {
    super(message)
    this.name = "JsonRpcError"
  }
}

/** The stdio pair of a `Bun.spawn({ stdin: "pipe", stdout: "pipe" })` child. */
export interface JsonRpcIo {
  readonly stdin: { write(chunk: string): number | Promise<number>; flush(): number | Promise<number>; end(): unknown }
  readonly stdout: ReadableStream<Uint8Array>
}

export interface JsonRpcOptions {
  readonly onNotification: (method: string, params: unknown) => void
  /** The answer to a server→client request; undefined answers `null`. */
  readonly onRequest?: (method: string, params: unknown) => unknown
  /** Requests pending past this many reject with kind "busy". */
  readonly maxInFlight?: number
  readonly log?: (line: string) => void
}

export interface JsonRpc {
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>
  notify(method: string, params: unknown): void
  /**
   * Rejects every pending request and cancels the stdout reader, so a read
   * suspended on a pipe the child still holds open stops. The child is the
   * caller's to end.
   */
  close(): void
  /** Settles once the reader has stopped, after stdout ends or `close` runs. */
  readonly closed: Promise<void>
}

interface Pending {
  readonly resolve: (value: never) => void
  readonly reject: (error: JsonRpcError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const HEADER_END = "\r\n\r\n"
/** A header block without a terminator within this many bytes is not a frame. */
const MAX_HEADER_BYTES = 8 * 1024
/** The largest `Content-Length` body accepted; beyond it the transport is retired. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const createJsonRpc = (io: JsonRpcIo, options: JsonRpcOptions): JsonRpc => {
  const log = options.log ?? (() => {})
  const maxInFlight = options.maxInFlight ?? 8
  const pending = new Map<number, Pending>()
  let seq = 0
  let closed = false
  let resolveClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const send = (message: Record<string, unknown>): void => {
    if (closed) return
    const body = JSON.stringify({ jsonrpc: "2.0", ...message })
    try {
      void io.stdin.write(`Content-Length: ${encoder.encode(body).byteLength}${HEADER_END}${body}`)
      void io.stdin.flush()
    } catch (error) {
      log(`json-rpc write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id)
    if (entry === undefined) return undefined
    pending.delete(id)
    clearTimeout(entry.timer)
    return entry
  }

  const dispatch = (message: Record<string, unknown>): void => {
    const { id, method } = message
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        options.onNotification(method, message.params)
        return
      }
      let result: unknown = null
      try {
        result = options.onRequest?.(method, message.params) ?? null
      } catch (error) {
        send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
        return
      }
      send({ id, result })
      return
    }
    if (typeof id !== "number") return
    const entry = settle(id)
    if (entry === undefined) return
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined
      const text = typeof message.error.message === "string" ? message.error.message : "The language server answered an error."
      entry.reject(new JsonRpcError("response", text, code))
      return
    }
    entry.resolve(message.result as never)
  }

  /**
   * Unframed stdout bytes, kept as chunks so a read never copies the backlog;
   * they are joined once, when a whole header block or body is present.
   */
  const chunks: Array<Uint8Array> = []
  let buffered = 0
  /** The declared body length of a parsed header whose body has not fully arrived. */
  let awaitingBody: number | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  /** The byte offset of the header terminator across the chunks, or -1. */
  const findHeaderEnd = (): number => {
    let base = 0
    let matched = 0
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.byteLength; index += 1) {
        const byte = chunk[index]
        if (byte === HEADER_END.charCodeAt(matched)) matched += 1
        else matched = byte === HEADER_END.charCodeAt(0) ? 1 : 0
        if (matched === HEADER_END.length) return base + index + 1 - HEADER_END.length
      }
      base += chunk.byteLength
    }
    return -1
  }

  /** The first `count` buffered bytes, removed from the front. */
  const take = (count: number): Uint8Array => {
    const out = new Uint8Array(count)
    let filled = 0
    while (filled < count) {
      const chunk = chunks[0]
      const wanted = count - filled
      if (chunk.byteLength <= wanted) {
        out.set(chunk, filled)
        filled += chunk.byteLength
        chunks.shift()
      } else {
        out.set(chunk.subarray(0, wanted), filled)
        chunks[0] = chunk.subarray(wanted)
        filled = count
      }
    }
    buffered -= count
    return out
  }

  /** Dispatches every whole frame in the buffer; false once a limit retired the transport. */
  const frame = (): boolean => {
    for (;;) {
      if (awaitingBody === undefined) {
        const headerEnd = findHeaderEnd()
        if (headerEnd < 0) {
          if (buffered <= MAX_HEADER_BYTES) return true
          log(`json-rpc: a header ran past ${MAX_HEADER_BYTES} bytes without a terminator`)
          close()
          return false
        }
        const header = decoder.decode(take(headerEnd + HEADER_END.length).subarray(0, headerEnd))
        const match = /content-length:\s*(\d+)/i.exec(header)
        // A block without a length is not a frame; the next block may be.
        if (match === null) continue
        const length = Number(match[1])
        if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
          log(`json-rpc: a frame declared ${match[1]} bytes, past the ${MAX_FRAME_BYTES} byte cap`)
          close()
          return false
        }
        awaitingBody = length
      }
      if (buffered < awaitingBody) return true
      const body = decoder.decode(take(awaitingBody))
      awaitingBody = undefined
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        log("json-rpc: a frame was not JSON")
        continue
      }
      if (isRecord(parsed)) dispatch(parsed)
    }
  }

  const read = async (): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      reader = io.stdout.getReader()
      activeReader = reader
      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        if (value.byteLength === 0) continue
        chunks.push(value)
        buffered += value.byteLength
        if (!frame()) break
      }
    } catch (error) {
      if (!closed) log(`json-rpc read failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      activeReader = undefined
      try {
        reader?.releaseLock()
      } catch {
        // A cancel from close already dropped the lock.
      }
      close()
      resolveClosed()
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    // A read suspended on a stdout the child still holds open only wakes on cancel.
    const reader = activeReader
    activeReader = undefined
    if (reader !== undefined) {
      void reader.cancel().catch(() => {
        // The stream was already errored or cancelled with the child.
      })
    }
    chunks.length = 0
    buffered = 0
    for (const [id, entry] of pending) {
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new JsonRpcError("closed", "The language server closed."))
    }
    try {
      void io.stdin.end()
    } catch {
      // Already closed with the child.
    }
  }

  void read()

  return {
    request: <T>(method: string, params: unknown, timeoutMs: number): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new JsonRpcError("closed", "The language server closed."))
          return
        }
        if (pending.size >= maxInFlight) {
          reject(new JsonRpcError("busy", `At most ${maxInFlight} language-server requests may be in flight.`))
          return
        }
        const id = ++seq
        const timer = setTimeout(() => {
          if (settle(id) === undefined) return
          send({ method: "$/cancelRequest", params: { id } })
          reject(new JsonRpcError("timeout", `The language server did not answer ${method} within ${timeoutMs} ms.`))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (value: never) => void, reject, timer })
        send({ id, method, params })
      }),
    notify: (method, params) => send({ method, params }),
    close,
    closed: closedPromise
  }
}
