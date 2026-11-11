/**
 * Scoped HTTP egress through exact destination names. The client runs in a
 * private network namespace and reaches this broker only through a Unix socket.
 * @since 1.0.0
 */

import { Effect } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Path from "node:path"
import { BrokerError, createBrokerDirectory, destinationBrokerRoot } from "./internal/DestinationBrokerRoot.ts"
export { BrokerError } from "./internal/DestinationBrokerRoot.ts"

/** Starts a broker; redirects require a fresh request and a fresh host check.
 * No suffix matching, ambient proxies, or direct-network fallback is used.
 * @category constructors
 * @since 1.0.0
 */
export const open = (socket: string, destinations: ReadonlyArray<string>, token: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const allowed = new Set(destinations)
        const expected = Buffer.from("Basic " + Buffer.from("broker:" + token).toString("base64"))
        const authenticated = (request: Http.IncomingMessage) => {
          const header = request.headers["proxy-authorization"]
          if (typeof header !== "string") return false
          const supplied = Buffer.from(header)
          return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        }
        const connections = new Set<Net.Socket>()
        const track = (connection: Net.Socket) => {
          connections.add(connection)
          connection.on("error", () => connection.destroy())
          connection.once("close", () => connections.delete(connection))
          return connection
        }
        const permitted = (url: URL) =>
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.username === "" && url.password === "" && allowed.has(url.hostname)
        const server = Http.createServer((request, response) => {
          if (!authenticated(request)) {
            response.writeHead(407).end("proxy authentication required")
            return
          }
          let url: URL
          try {
            url = new URL(request.url!)
          } catch {
            response.writeHead(400).end()
            return
          }
          if (!permitted(url) || url.protocol !== "http:") {
            response.writeHead(403).end("destination is not declared")
            return
          }
          // Hop-by-hop headers and a user-supplied Host never cross the boundary.
          const headers: Http.OutgoingHttpHeaders = { ...request.headers, host: url.host }
          delete headers["proxy-authorization"]
          delete headers["proxy-connection"]
          delete headers["connection"]
          const upstream = Http.request(url, { method: request.method, headers, agent: false }, (incoming) => {
            response.writeHead(incoming.statusCode!, incoming.headers)
            incoming.pipe(response)
          })
          upstream.on("socket", track)
          upstream.on("error", () => response.destroy())
          // A client that goes away closes its response, which ends the upstream.
          response.on("close", () => upstream.destroy())
          request.pipe(upstream)
        })
        server.on("connection", track)
        server.on("connect", (request, client, head) => {
          const downstream = track(client as Net.Socket)
          if (!authenticated(request)) {
            downstream.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n")
            return
          }
          let url: URL
          try {
            url = new URL(`https://${request.url!}`)
          } catch {
            downstream.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return
          }
          if (!permitted(url) || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
            downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
          }
          const upstream = track(Net.connect({ host: url.hostname, port: Number(url.port || 443) }))
          downstream.once("close", () => upstream.destroy())
          upstream.once("close", () => downstream.destroy())
          upstream.once("connect", () => {
            downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            if (head.length > 0) upstream.write(head)
            downstream.pipe(upstream)
            upstream.pipe(downstream)
          })
        })
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(socket, () => {
            server.removeListener("error", reject)
            resolve()
          })
        })
        return { socket, server, connections }
      },
      catch: (cause) => new BrokerError({ message: "destination broker could not start", cause })
    }),
    ({ server, connections }) =>
      Effect.promise(() =>
        new Promise<void>((resolve) => {
          for (const connection of connections) connection.destroy()
          server.close(() => resolve())
        })
      )
  ).pipe(Effect.asVoid)

// This small relay executes INSIDE the private network namespace. The only
// route out is the mounted Unix socket. Go uses the loopback HTTP proxy; DNS
// and upstream connections happen in the host broker, after the name check.
const relay = `
const net = require("node:net")
const cp = require("node:child_process")
const [socket, executable, ...args] = process.argv.slice(1)
const token = process.env.SMTHRS_DESTINATION_TOKEN
delete process.env.SMTHRS_DESTINATION_TOKEN
if (!token) { console.error("missing destination broker authentication"); process.exit(1) }
const peers = new Set()
const server = net.createServer(client => {
  const upstream = net.connect(socket)
  for (const peer of [client, upstream]) {
    peers.add(peer)
    peer.on("error", () => { client.destroy(); upstream.destroy() })
    peer.on("close", () => { peers.delete(peer); client.destroy(); upstream.destroy() })
  }
  client.pipe(upstream); upstream.pipe(client)
})
server.on("error", error => { console.error(error.message); process.exit(1) })
server.listen(0, "127.0.0.1", () => {
  const endpoint = "http://broker:" + encodeURIComponent(token) + "@127.0.0.1:" + server.address().port
  const env = { ...process.env, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint,
    http_proxy: endpoint, https_proxy: endpoint, NO_PROXY: "", no_proxy: "" }
  const child = cp.spawn(executable, args, { env, stdio: "inherit" })
  const finish = code => {
    for (const peer of peers) peer.destroy()
    server.close(() => process.exit(code))
  }
  child.on("error", error => { console.error(error.message); finish(1) })
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return }
    finish(code === null ? 1 : code)
  })
})
`

/** Wraps a command with an in-namespace TCP-to-Unix relay.
 * The caller must keep the namespace closed and mount only the broker socket.
 * @category rendering
 * @since 1.0.0
 */
export const wrap = (
  argv: ReadonlyArray<string>,
  socket: string
): readonly [string, ...Array<string>] => [
  process.execPath,
  "--input-type=commonjs",
  "-e",
  relay,
  "--",
  socket,
  ...argv
]

/** Creates a private broker outside the workspace and its shared cache grants.
 * Other network namespaces see neither its directory nor its socket. The
 * caller mounts only the returned socket in the owning namespace.
 * @category constructors
 * @since 1.0.0
 */
export const isolated = (destinations: ReadonlyArray<string>, workspaceRoot: string) =>
  Effect.gen(function*() {
    const directory = yield* Effect.acquireRelease(
      createBrokerDirectory(destinationBrokerRoot, process.getuid?.()),
      (directory) => Effect.promise(() => Fs.rm(directory, { recursive: true, force: true }))
    )
    const relative = Path.relative(workspaceRoot, directory)
    if (!relative.startsWith(".." + Path.sep)) {
      return yield* Effect.fail(new BrokerError({ message: "destination broker must be outside the workspace grants" }))
    }
    const socket = Path.join(directory, "p.sock")
    const token = randomBytes(32).toString("base64url")
    yield* open(socket, destinations, token)
    return { socket, token }
  })
