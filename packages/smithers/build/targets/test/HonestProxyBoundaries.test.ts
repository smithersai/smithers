import * as Http from "node:http"
import * as Net from "node:net"
import { afterEach, expect, it } from "vitest"
import * as Secret from "../src/Secret.ts"
import * as Proxy from "../src/SecretProxy.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const proxy = async (vault = Proxy.makeVault()) => {
  const resource = await Proxy.startProxy(vault)
  cleanup.push(resource.close)
  return resource
}
const request = (url: string, path: string, body?: Buffer): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const call = Http.request(url, {
      path,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-length": body.length } })
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", reject)
    })
    call.on("error", reject)
    call.setTimeout(5000, () => call.destroy(new Error("local proxy request timed out")))
    call.end(body)
  })

it("reuses a destination capability without resolving its credential eagerly", async () => {
  let reads = 0
  const service = await proxy(Proxy.makeVault({
    read: () => {
      reads++
      return "http://example.invalid/"
    }
  }))
  const first = service.urlFor(Secret.Secret("DESTINATION"))
  expect(service.urlFor(Secret.Secret("DESTINATION"))).toBe(first)
  expect(reads).toBe(0)
  expect(() => service.urlFor({} as never)).toThrow(/secret declaration/)
})

it.each(["https://example.invalid/", "ftp://example.invalid/"])(
  "refuses a non-HTTP absolute proxy request before forwarding",
  async (path) => {
    const service = await proxy()
    expect(await request(service.endpoint, path)).toEqual({ status: 400, body: "proxy forwards http requests only" })
  }
)

it("ignores an empty byte-redaction needle", () => {
  const boundary = Proxy.makeVault().request("https://example.invalid", [{ value: "", placeholder: "replacement" }])
  expect(boundary.redactBytes(Buffer.from("unchanged")).toString("utf8")).toBe("unchanged")
})

it("refuses origin-changing broker request targets, including a broker sent through the proxy", async () => {
  const vault = Proxy.makeVault({ read: () => "fixture-value" })
  const audience = "https://api.example.invalid"
  vault.mint(Secret.HttpSecret(Secret.Secret("BROKER_TOKEN"), [audience]))
  const service = await proxy(vault)
  const origin = await service.originFor(audience)
  expect(await request(origin, "/\\outside.invalid/path")).toMatchObject({ status: 400 })
  expect(await request(service.endpoint, origin + "/.//outside.invalid")).toMatchObject({ status: 400 })
})

it("forwards CONNECT bytes coalesced with the handshake and closes the tunnel", async () => {
  const upstream = Net.createServer((socket) => socket.on("data", (chunk) => socket.end(chunk)))
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject)
    upstream.listen(0, "127.0.0.1", resolve)
  })
  const address = upstream.address() as Net.AddressInfo
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())))
  const service = await proxy()
  const endpoint = new URL(service.endpoint)
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = Net.connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    let text = ""
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8")
    })
    socket.on("end", () => resolve(text))
    socket.on("error", reject)
    socket.setTimeout(5000, () => socket.destroy(new Error("local CONNECT timed out")))
    socket.once("connect", () =>
      socket.write(
        "CONNECT 127.0.0.1:" + address.port + " HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\ntunnel-payload"
      ))
  })
  expect(answer).toContain("200 Connection Established")
  expect(answer.endsWith("tunnel-payload")).toBe(true)
})

it("rejects an oversized request before contacting its upstream", async () => {
  let contacts = 0
  const upstream = Http.createServer((_request, response) => {
    contacts++
    response.end("unexpected")
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject)
    upstream.listen(0, "127.0.0.1", resolve)
  })
  const address = upstream.address() as Net.AddressInfo
  cleanup.push(() =>
    new Promise<void>((resolve) => {
      upstream.closeAllConnections()
      upstream.close(() => resolve())
    })
  )
  const service = await proxy()
  const answer = await request(
    service.endpoint,
    "http://127.0.0.1:" + address.port + "/upload",
    Buffer.alloc(Proxy.maximumRequestBodyBytes + 128 * 1024)
  )
  expect(answer.status).toBe(413)
  expect(contacts).toBe(0)
})
