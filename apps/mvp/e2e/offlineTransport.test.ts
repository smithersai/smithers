import { createServer, connect, type AddressInfo } from "node:net"
import { get } from "node:http"
import { once } from "node:events"
import { expect, test } from "vitest"
import { offlineTransport } from "./offlineTransport"

const closed = (socket: import("node:net").Socket) => new Promise<void>(resolve => socket.once("close", () => resolve()))

test("the relay forwards real bytes, cuts established connections and refuses new ones", async () => {
  const echo = createServer(socket => socket.pipe(socket))
  echo.listen(0, "127.0.0.1")
  await once(echo, "listening")
  const relay = await offlineTransport()
  const address = new URL(relay.proxy.server)
  const client = connect(Number(address.port), address.hostname)
  try {
    await once(client, "connect")
    client.write(`CONNECT 127.0.0.1:${(echo.address() as AddressInfo).port} HTTP/1.1\r\nHost: localhost\r\n\r\nopaque-head`)
    let received = ""
    await new Promise<void>(resolve => client.on("data", chunk => { received += chunk; if (received.includes("opaque-head")) resolve() }))
    expect(received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nopaque-head")
    client.write("end-to-end bytes")
    await expect.poll(() => received).toContain("end-to-end bytes")
    expect(relay.forwarded()).toBe(1)
    const ended = closed(client)
    relay.disconnect()
    await ended
    const refused = connect(Number(address.port), address.hostname)
    await once(refused, "connect")
    refused.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: localhost\r\n\r\n")
    await closed(refused)
    expect(relay.forwarded()).toBe(1)
  } finally {
    client.destroy()
    await relay.close()
    await new Promise<void>(resolve => echo.close(() => resolve()))
  }
})

test("a refused upstream and a non-CONNECT request close without inventing a response", async () => {
  const relay = await offlineTransport()
  const address = new URL(relay.proxy.server)
  const unused = createServer()
  unused.listen(0, "127.0.0.1")
  await once(unused, "listening")
  const port = (unused.address() as AddressInfo).port
  await new Promise<void>(resolve => unused.close(() => resolve()))
  try {
    for (const destination of [`127.0.0.1:${port}`, "127.0.0.2"]) {
      const client = connect(Number(address.port), address.hostname)
      await once(client, "connect")
      client.write(`CONNECT ${destination} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
      await closed(client)
    }
    expect(relay.forwarded()).toBe(0)
    const error = await new Promise<Error>(resolve => get(relay.proxy.server, response => response.destroy()).on("error", resolve))
    expect(error.message).toContain("socket hang up")
  } finally { await relay.close() }
})
