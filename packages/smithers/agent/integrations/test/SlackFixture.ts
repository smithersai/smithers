/**
 * A real Slack stand-in for the Slack suites: one `node:http` server that
 * answers Web API methods under `/api/<method>` and accepts WebSocket upgrades
 * for Socket Mode anywhere else.
 *
 * The WebSocket side is a minimal RFC 6455 server written against the raw
 * socket: the opening handshake, masked client frames, unmasked server frames,
 * ping/pong, and the close handshake. The client under test is Node's own
 * `WebSocket`, so every byte crosses a real TCP connection. Nothing is mocked.
 */
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"

/** One Web API call the server received. */
export interface ApiCall {
  /** The Slack method, such as `chat.postMessage`. */
  readonly method: string
  readonly authorization: string | undefined
  readonly contentType: string | undefined
  /** The form-decoded parameters. */
  readonly params: Readonly<Record<string, string>>
}

/** Answers one Web API call. `request` is the raw request, for a handler that drops the socket. */
export type ApiHandler = (call: ApiCall, response: ServerResponse, request: IncomingMessage) => void | Promise<void>

/** The server's side of one accepted WebSocket connection. */
export interface Peer {
  /** The request path the client connected to. */
  readonly path: string
  /** Every text frame the client sent, in order. */
  readonly received: ReadonlyArray<string>
  /** Resolves with the client's next text frame not yet taken. */
  readonly next: () => Promise<string>
  /** Sends `value` as a JSON text frame. */
  readonly send: (value: unknown) => void
  readonly sendText: (text: string) => void
  readonly sendBinary: (bytes: Uint8Array) => void
  /** Starts the close handshake with `code`. */
  readonly close: (code?: number) => void
  /** Destroys the TCP connection with no close frame. */
  readonly drop: () => void
  /** Resolves when the TCP connection has closed. */
  readonly closed: Promise<void>
}

/** What a suite drives. */
export interface SlackFixture {
  readonly origin: string
  /** The base URL a `SlackClient` is configured with. */
  readonly apiBaseUrl: string
  readonly calls: ReadonlyArray<ApiCall>
  /** A `ws://` URL on this server. */
  readonly socketUrl: (path?: string) => string
  /** Resolves with the next accepted WebSocket connection not yet taken. */
  readonly nextPeer: () => Promise<Peer>
  readonly peers: ReadonlyArray<Peer>
  readonly close: () => Promise<void>
}

/** How the server treats a WebSocket upgrade. */
export type UpgradeDecision = "accept" | "refuse"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** A FIFO whose `take` waits for the next value. */
const channel = <A>() => {
  const values: Array<A> = []
  const waiting: Array<(value: A) => void> = []
  return {
    push: (value: A) => {
      const taker = waiting.shift()
      if (taker === undefined) values.push(value)
      else taker(value)
    },
    take: (): Promise<A> =>
      values.length > 0 ? Promise.resolve(values.shift() as A) : new Promise((resolve) => waiting.push(resolve))
  }
}

const frame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

interface Frame {
  readonly opcode: number
  readonly payload: Buffer
}

/** Splits complete frames off the front of `buffer`, unmasking client frames. */
const parseFrames = (buffer: Buffer): { readonly frames: ReadonlyArray<Frame>; readonly rest: Buffer } => {
  const frames: Array<Frame> = []
  let rest = buffer
  while (rest.length >= 2) {
    const opcode = (rest[0] as number) & 0x0f
    const masked = ((rest[1] as number) & 0x80) !== 0
    let length = (rest[1] as number) & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    const maskAt = offset
    if (masked) offset += 4
    if (rest.length < offset + length) break
    const payload = Buffer.from(rest.subarray(offset, offset + length))
    if (masked) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] = (payload[index] as number) ^ (rest[maskAt + (index % 4)] as number)
      }
    }
    frames.push({ opcode, payload })
    rest = rest.subarray(offset + length)
  }
  return { frames, rest }
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const acceptPeer = (socket: Socket, path: string): Peer => {
  const received: Array<string> = []
  const inbox = channel<string>()
  let pending: Buffer = Buffer.alloc(0)
  let closing = false
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()))
  const write = (bytes: Buffer) => {
    if (!socket.destroyed) socket.write(bytes)
  }
  socket.on("error", () => {})
  socket.on("data", (chunk: Buffer) => {
    const parsed = parseFrames(Buffer.concat([pending, chunk]))
    pending = parsed.rest
    for (const { opcode, payload } of parsed.frames) {
      if (opcode === 0x1) {
        const text = payload.toString("utf8")
        received.push(text)
        inbox.push(text)
      } else if (opcode === 0x9) {
        write(frame(0xa, payload))
      } else if (opcode === 0x8) {
        if (!closing) write(frame(0x8, payload))
        socket.end()
      }
    }
  })
  return {
    path,
    received,
    next: inbox.take,
    send: (value) => write(frame(0x1, Buffer.from(JSON.stringify(value)))),
    sendText: (text) => write(frame(0x1, Buffer.from(text))),
    sendBinary: (bytes) => write(frame(0x2, Buffer.from(bytes))),
    close: (code = 1000) => {
      closing = true
      const payload = Buffer.alloc(2)
      payload.writeUInt16BE(code, 0)
      write(frame(0x8, payload))
    },
    drop: () => socket.destroy(),
    closed
  }
}

/**
 * Starts the fixture on an ephemeral loopback port.
 *
 * `upgrade` decides each WebSocket upgrade; it defaults to accepting.
 */
export const startSlackFixture = async (
  api: ApiHandler,
  upgrade: (path: string) => UpgradeDecision = () => "accept"
): Promise<SlackFixture> => {
  const calls: Array<ApiCall> = []
  const peers: Array<Peer> = []
  const accepted = channel<Peer>()
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    void readBody(request).then(async (body) => {
      const call: ApiCall = {
        method: (request.url ?? "/").replace(/^\/api\//, "").replace(/\?.*$/, ""),
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        params: Object.fromEntries(new URLSearchParams(body))
      }
      calls.push(call)
      await api(call, response, request)
    })
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (request, socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    const path = request.url ?? "/"
    const key = request.headers["sec-websocket-key"]
    if (upgrade(path) === "refuse" || typeof key !== "string") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    const acceptKey = createHash("sha1").update(`${key}${GUID}`).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    )
    const peer = acceptPeer(socket, path)
    peers.push(peer)
    accepted.push(peer)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    apiBaseUrl: `${origin}/api`,
    calls,
    socketUrl: (path = "/link") => `ws://127.0.0.1:${port}${path}`,
    nextPeer: accepted.take,
    peers,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
  }
}

/** Replies `200 { ok: true, ...body }`. */
export const ok = (response: ServerResponse, body: Record<string, unknown> = {}): void => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ ok: true, ...body }))
}

/** Replies `{ ok: false, error }` with `status`, 200 by default, as Slack does. */
export const refuse = (
  response: ServerResponse,
  error: string,
  status = 200,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify({ ok: false, error }))
}

/** Replies with a raw status and body. */
export const raw = (
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, headers)
  response.end(body)
}
