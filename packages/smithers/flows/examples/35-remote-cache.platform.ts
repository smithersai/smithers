// The platform code of 35-remote-cache.vibe, which a .vibe file does not import as a value (EK4402).

import { createServer, type Server } from "node:http"

/** The recorded entries the in-process action cache holds, keyed by digest. */
interface SharedTier {
  readonly url: string
  readonly reads: () => number
  readonly writes: () => number
  readonly close: () => Promise<void>
}
/** The largest entry body the example tier accepts, in bytes. */
const maxEntryBytes = 1024 * 1024
/**
 * A real HTTP action cache: `GET /ac/{key}` answers a stored entry or 404,
 * `PUT /ac/{key}` records one. `refusePut` makes every write answer 503, which
 * is how the third scenario reproduces an unreachable shared tier.
 *
 * `port` defaults to an ephemeral listener; startup errors reject the promise.
 * A key that is not valid percent-encoding answers 400, and a body larger than
 * `maxEntryBytes` answers 413, so a malformed request cannot crash or exhaust
 * the process.
 */
export const startSharedTier = (refusePut: boolean, port = 0): Promise<SharedTier> => {
  const entries = new Map<string, string>()
  let reads = 0
  let writes = 0
  const server: Server = createServer((request, response) => {
    let key: string
    try {
      key = decodeURIComponent((request.url ?? "").replace(/^\/ac\//, ""))
    } catch {
      request.resume()
      response.writeHead(400).end()
      return
    }
    if (request.method === "GET") {
      reads++
      const entry = entries.get(key)
      if (entry === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(entry)
      return
    }
    if (request.method === "PUT") {
      if (refusePut) {
        request.resume()
        response.writeHead(503).end()
        return
      }
      const chunks: Array<Buffer> = []
      let size = 0
      let tooLarge = false
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return
        size += chunk.length
        if (size > maxEntryBytes) {
          tooLarge = true
          chunks.length = 0
          response.writeHead(413, { connection: "close" }).end()
          return
        }
        chunks.push(chunk)
      })
      request.on("end", () => {
        if (tooLarge) return
        writes++
        entries.set(key, Buffer.concat(chunks).toString("utf8"))
        response.writeHead(201).end()
      })
      return
    }
    response.writeHead(405).end()
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        reads: () => reads,
        writes: () => writes,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })
}
