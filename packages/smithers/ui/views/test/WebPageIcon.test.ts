/** Page icons are fetched by the host, never by a conversation viewer. */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { WebPage } from "../src/index.ts"

let server: Server
let origin: string
let directory: string
let ca: Buffer
const seen: Array<string> = []
const imageHeaders: Array<{ accept: string | undefined; destination: string | string[] | undefined }> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "web-page-icon-"))
  const key = join(directory, "key.pem")
  const cert = join(directory, "cert.pem")
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert
  ], { stdio: "ignore" })
  ca = readFileSync(cert)
  server = createServer({ key: readFileSync(key), cert: ca }, (request, response) => {
    const url = new URL(request.url!, origin)
    seen.push(url.pathname)
    if (url.pathname === "/image") {
      imageHeaders.push({ accept: request.headers.accept, destination: request.headers["sec-fetch-dest"] })
    }
    if (url.pathname === "/page") {
      response.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" })
      response.end(
        `<head><title>Page</title><link rel="icon" href="${url.searchParams.get("icon") ?? "/image"}"></head>`
      )
    } else if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/image" }).end()
    } else if (url.pathname === "/private") {
      response.writeHead(302, { location: "https://10.0.0.1/icon" }).end()
    } else if (url.pathname === "/loop") {
      response.writeHead(302, { location: "/loop" }).end()
    } else if (url.pathname === "/hang") {
      request.on("close", () => response.destroy())
    } else if (url.pathname === "/reset") {
      response.writeHead(200, { "content-type": "image/png" })
      response.write(new Uint8Array([1]))
      setTimeout(() => response.socket?.destroy(), 10)
    } else {
      const status = url.pathname === "/missing" ? 404 : 200
      const type = url.pathname === "/html" ? "text/html" : "image/png"
      const size = url.pathname === "/large"
        ? 65_537
        : url.pathname === "/limit"
        ? 65_536
        : url.pathname === "/empty"
        ? 0
        : 4
      response.writeHead(status, { "content-type": type })
      response.end(new Uint8Array(size).fill(42))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  seen.length = 0
  imageHeaders.length = 0
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})
const check = (icon: string) =>
  Effect.runPromise(
    WebPage.check(
      `${origin}/page?icon=${encodeURIComponent(icon)}`,
      { ancestors: ["https://app.example.com"], privateHosts: ["127.0.0.1"], headTimeout: "100 millis" }
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttpOptions({ ca })))
  )

describe("host-served page icons", () => {
  it("returns image bytes inline even when the page refuses framing", async () => {
    const result = await check("/image")
    expect(result).toEqual({
      framing: "refused",
      reason: "x_frame_options",
      status: 200,
      title: "Page",
      icon: "data:image/png;base64,KioqKg=="
    })
    expect(seen).toEqual(["/page", "/image"])
    expect(imageHeaders).toEqual([{ accept: "image/*", destination: "image" }])
    expect(Schema.decodeUnknownSync(WebPage.Checked)(result)).toEqual(result)
  })
  it("follows a guarded icon redirect", async () => {
    expect((await check("/redirect")).icon).toBe("data:image/png;base64,KioqKg==")
    expect(seen).toEqual(["/page", "/redirect", "/image"])
  })
  it("retains a bounded icon large enough for a real favicon and schema decode", async () => {
    const result = await check("/limit")
    expect(result.icon?.length).toBeGreaterThan(WebPage.MAX_ICON_URL)
    expect(Schema.decodeUnknownSync(WebPage.Checked)(result)).toEqual(result)
  })
  it.each(["/missing", "/html", "/empty", "/large", "/private", "/loop", "/hang", "/reset"])(
    "omits unavailable or unsafe icon %s without losing the page",
    async (icon) => {
      const result = await check(icon)
      expect(result.title).toBe("Page")
      expect(result.framing).toBe("refused")
      expect(result.icon).toBeUndefined()
      expect(seen).not.toContain("/icon")
    }
  )
  it("refuses a private icon before making a request", async () => {
    expect((await check("https://10.0.0.1/icon")).icon).toBeUndefined()
    expect(seen).toEqual(["/page"])
  })
})
