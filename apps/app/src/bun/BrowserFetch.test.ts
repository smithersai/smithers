import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:https"
import type { Server } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { createPinnedHttpsFetch, handleBrowserFetch } from "./BrowserFetch"

let root: string
let server: Server
let origin: string
let ca: string
const seen: Array<{ host: string | undefined; cookie: string | undefined; sni: string | false | null }> = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-browser-tls-"))
  const child = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=browser-fetch.test", "-addext", "subjectAltName=DNS:browser-fetch.test"], { stdout: "ignore", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" })
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`TLS fixture certificate failed: ${errors}`)
  ca = await readFile(join(root, "cert.pem"), "utf8")
  server = createServer({ cert: ca, key: await readFile(join(root, "key.pem")) }, (request, response) => {
    seen.push({ host: request.headers.host, cookie: request.headers.cookie, sni: (request.socket as import("node:tls").TLSSocket).servername })
    if (request.url === "/stall") { response.writeHead(200); response.write("waiting"); return }
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
    response.end(gzipSync("<p>read through checked address</p>"))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing TLS server port")
  origin = `https://browser-fetch.test:${address.port}`
}, 10000)

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

test("pinned HTTPS dials the checked IP while verifying the URL host and decoding content", async () => {
  const response = await createPinnedHttpsFetch({ ca })(origin, { headers: { "user-agent": "smithers-browser" } }, "127.0.0.1")
  expect(await response.text()).toBe("<p>read through checked address</p>")
  expect(response.headers.get("content-encoding")).toBeNull()
  expect(seen[0]).toEqual({ host: new URL(origin).host, cookie: undefined, sni: "browser-fetch.test" })
  await expect(createPinnedHttpsFetch({ ca })(origin.replace("browser-fetch.test", "wrong-host.test"), {}, "127.0.0.1")).rejects.toThrow()
})

test("aborting a pinned response also stops a body that never finishes", async () => {
  const response = await createPinnedHttpsFetch({ ca })(`${origin}/stall`, { signal: AbortSignal.timeout(150) }, "127.0.0.1")
  await expect(response.text()).rejects.toThrow()
})

test("the native reader refuses private destinations before requesting anything", async () => {
  let requested = false
  const response = await handleBrowserFetch(new Request("http://local/api/tools/browser-fetch", { method: "POST", body: JSON.stringify({ url: "https://example.test" }) }), {
    resolveHost: async () => ["127.0.0.1"], fetchImpl: async () => { requested = true; return new Response("unexpected") }
  })
  expect(response.status).toBe(422)
  expect(requested).toBe(false)
})
