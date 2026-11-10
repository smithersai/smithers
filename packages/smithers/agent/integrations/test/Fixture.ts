import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** One request a fixture server received, with its body already read. */
export interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
  /** When the server finished reading the request, in wall-clock milliseconds. */
  readonly receivedAt: number
}

/** A real HTTP server the clients talk to over a real socket. No mocks. */
export interface Fixture {
  readonly origin: string
  readonly requests: ReadonlyArray<Recorded>
  /**
   * Resolves with the first request the server received. A test that means to
   * act on a request in flight waits for this rather than for a duration, so a
   * loaded machine cannot let it act before the request arrived.
   */
  readonly arrived: Promise<Recorded>
  /** Resolves when the socket of a received request closes, aborted or answered. */
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

export type Handler = (
  request: Recorded,
  response: ServerResponse
) => void | Promise<void>

interface Signal<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
}

const signal = <A>(): Signal<A> => {
  let settle: ((value: A) => void) | undefined
  const promise = new Promise<A>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle as (value: A) => void }
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

/** Starts a fixture server on an ephemeral port and records what it receives. */
export const startFixture = async (handler: Handler): Promise<Fixture> => {
  const requests: Array<Recorded> = []
  const arrival = signal<Recorded>()
  const closure = signal<void>()
  const server: Server = createServer((request, response) => {
    response.on("close", () => closure.resolve(undefined))
    void readBody(request).then(async (body) => {
      const recorded: Recorded = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers as Record<string, string | undefined>,
        body,
        receivedAt: Date.now()
      }
      requests.push(recorded)
      arrival.resolve(recorded)
      await handler(recorded, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    arrived: arrival.promise,
    closed: closure.promise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
  }
}

/** Replies with `status` and a JSON body. */
export const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

/** A workerd SQL port whose disk has failed. */
export const faultySql = {
  exec: (): { readonly toArray: () => Array<Record<string, unknown>> } => {
    throw new Error("disk")
  }
}

/** Actual SQLite for the broker's conditional-consumption tests; it implements the workerd SQL port. */
export const openBrokerSqlite = async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(":memory:")
  return {
    sql: { exec: (query: string, ...bindings: Array<string | number>) => {
      const rows = database.prepare(query).all(...bindings)
      return { toArray: () => rows }
    } },
    close: () => database.close(),
  }
}
