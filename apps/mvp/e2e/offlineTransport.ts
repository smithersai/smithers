import { createServer } from "node:http"
import { connect, type Socket } from "node:net"

/** A real HTTPS CONNECT relay. Cutting its TCP sockets loses the network without WebKit's offline emulation,
 * which also blocks service-worker navigation responses. TLS stays end to end; the relay never reads content.
 */
export const offlineTransport = async () => {
  const sockets = new Set<Socket>()
  let cut = false
  let forwarded = 0
  const keep = (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    return socket
  }
  const server = createServer((_request, response) => response.destroy())
  server.on("connection", keep)
  server.on("connect", (request, client, head) => {
    if (cut) { client.destroy(); return }
    const destination = new URL(`https://${request.url}`)
    const upstream = keep(connect(Number(destination.port || 443), destination.hostname))
    client.on("close", () => upstream.destroy())
    upstream.on("close", () => client.destroy())
    upstream.on("connect", () => {
      forwarded++
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as import("node:net").AddressInfo
  const disconnect = () => { cut = true; for (const socket of sockets) socket.destroy() }
  return {
    proxy: { server: `http://127.0.0.1:${address.port}`, bypass: "<-loopback>" },
    disconnect,
    forwarded: () => forwarded,
    close: async () => { disconnect(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
