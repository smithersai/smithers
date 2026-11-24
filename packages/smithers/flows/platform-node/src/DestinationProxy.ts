/**
 * Scoped HTTP egress through exact destination names. The client runs in a
 * private network namespace and reaches this broker only through a Unix socket.
 * @since 1.0.0
 */

import { Effect } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import Dns from "node:dns/promises"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Path from "node:path"
import { BrokerError, createBrokerDirectory, destinationBrokerRoot } from "./internal/DestinationBrokerRoot.ts"
export { BrokerError } from "./internal/DestinationBrokerRoot.ts"

// Only exact IP-literal declarations grant access to a non-public address.
const nonPublic = new Net.BlockList()
for (
  const [network, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3]
  ] as const
) nonPublic.addSubnet(network, bits, "ipv4")
const globalV6 = new Net.BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
// Exclude special-purpose allocations, documentation and transition tunnels.
for (const [network, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  nonPublic.addSubnet(network, bits, "ipv6")
}

const publicAddress = (address: string) =>
  Net.isIPv4(address)
    ? !nonPublic.check(address, "ipv4")
    : Net.isIPv6(address) && !address.includes("%") && globalV6.check(address, "ipv6") &&
      !nonPublic.check(address, "ipv6")

const destination = async (
  url: URL,
  allowed: ReadonlySet<string>
): Promise<Net.TcpNetConnectOpts | undefined> => {
  const defaultPort = url.protocol === "https:" ? "443" : "80"
  const port = url.port || defaultPort
  if (
    url.username || url.password ||
    !(allowed.has(url.hostname + ":" + port) || (port === defaultPort && allowed.has(url.hostname)))
  ) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (Net.isIP(host)) return { host, port: Number(port) }
  // Dial this exact answer. A second lookup could return a different address.
  const answers = await Dns.lookup(host, { all: true })
  if (answers.length === 0 || !answers.every(({ address }) => publicAddress(address))) return undefined
  return { host: answers[0]!.address, port: Number(port) }
}

const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]

const forwardedHeaders = (headers: Http.IncomingHttpHeaders): Http.OutgoingHttpHeaders => {
  const kept = { ...headers }
  for (const name of [...hopByHop, ...(headers.connection ?? "").toLowerCase().split(",")]) delete kept[name.trim()]
  return kept
}

/** Starts a broker; redirects require a fresh request and a fresh host check.
 * A bare host grants port 80 for HTTP and 443 for CONNECT. A host:port grants
 * that port. A private endpoint requires an explicit IP-literal destination.
 * @category constructors
 * @since 1.0.0
 */
export const open = (socket: string, destinations: ReadonlyArray<string>, token: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const allowed = new Set(destinations.map((destination) => destination.toLowerCase()))
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
        const server = Http.createServer(async (request, response) => {
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
          let endpoint: Net.TcpNetConnectOpts | undefined
          try {
            if (url.protocol === "http:") endpoint = await destination(url, allowed)
          } catch {
            response.writeHead(502).end()
            return
          }
          if (request.socket.destroyed) return
          if (endpoint === undefined) {
            response.writeHead(403).end("destination is not declared")
            return
          }
          // Hop-by-hop headers and a user-supplied Host never cross the boundary.
          const headers = { ...forwardedHeaders(request.headers), host: url.host }
          const upstream = Http.request(
            url,
            { hostname: endpoint.host, port: endpoint.port, method: request.method, headers, agent: false },
            (incoming) => {
              response.writeHead(incoming.statusCode!, forwardedHeaders(incoming.headers))
              incoming.pipe(response)
            }
          )
          upstream.on("socket", track)
          upstream.on("error", () => response.destroy())
          // A client that goes away closes its response, which ends the upstream.
          response.on("close", () => upstream.destroy())
          request.pipe(upstream)
        })
        server.on("connection", track)
        server.on("connect", async (request, client, head) => {
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
          let endpoint: Net.TcpNetConnectOpts | undefined
          try {
            if (url.pathname === "/" && url.search === "" && url.hash === "") {
              endpoint = await destination(url, allowed)
            }
          } catch {
            downstream.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return
          }
          if (downstream.destroyed) {
            return
          }
          if (endpoint === undefined) {
            downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
          }
          const upstream = track(Net.connect(endpoint))
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
  const finish = (code, signal) => {
    for (const peer of peers) peer.destroy()
    server.close(() => {
      if (signal && signal !== "SIGUSR1" && signal !== "SIGPIPE") process.kill(process.pid, signal)
      process.exit(code)
    })
  }
  child.on("error", error => { console.error(error.message); finish(1) })
  child.on("exit", (code, signal) => {
    finish(signal ? 128 + require("node:os").constants.signals[signal] : (code ?? 1), signal)
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
 * caller mounts only the returned socket in the owning namespace. `root` is
 * the private directory the broker is made under: by default
 * `/tmp/.smthrs-egress`, the one bubblewrap masks; a confined run refuses a
 * broker under any other.
 * @category constructors
 * @since 1.0.0
 */
export const isolated = (
  destinations: ReadonlyArray<string>,
  workspaceRoot: string,
  root: string = destinationBrokerRoot
) =>
  Effect.gen(function*() {
    const directory = yield* Effect.acquireRelease(
      createBrokerDirectory(root, process.getuid?.()),
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
