// A separate process keeps the deliberately poisoned global dispatcher out of
// other tests. Every byte stays on loopback; trust only this ephemeral CA.
import { createSecureServer } from "node:http2"
import { createServer, connect } from "node:net"
import { setDefaultCACertificates } from "node:tls"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { providerFetch } from "../../src/EgressHttpClient.ts"

const directory = mkdtempSync(join(tmpdir(), "provider-fatal-tls-"))
const scope = Effect.runSync(Scope.make())
const sockets = new Set()
let origin, proxy, warm
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", join(directory, "key"), "-out", join(directory, "cert")], { stdio: "ignore" })
  const cert = readFileSync(join(directory, "cert"))
  setDefaultCACertificates([cert.toString()])
  origin = createSecureServer({ key: readFileSync(join(directory, "key")), cert, allowHTTP1: true })
  origin.on("sessionError", () => {})
  origin.on("stream", stream => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200 }); stream.end("ok")
  })
  origin.on("request", (request, response) => { if (request.httpVersionMajor === 1) response.end("ok") })
  await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve))
  let corrupt = false
  proxy = createServer(client => {
    const upstream = connect(origin.address().port, "127.0.0.1")
    sockets.add(client); sockets.add(upstream)
    client.on("error", () => {}); upstream.on("error", () => {})
    client.on("close", () => { sockets.delete(client); upstream.destroy() })
    upstream.on("close", () => { sockets.delete(upstream); client.destroy() })
    client.pipe(upstream)
    upstream.on("data", bytes => {
      if (corrupt) { corrupt = false; bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 1 }
      client.write(bytes)
    })
  })
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve))
  const fetch = process.argv[2] === "native" ? globalThis.fetch : await Effect.runPromise(
    Scope.provide(scope)(providerFetch({ HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "" }, { connect: { ca: cert } }))
  )
  if (process.argv[2] === "provider-lifecycle") {
    const active = new Set()
    let finishBody
    warm = createSecureServer({ key: readFileSync(join(directory, "key")), cert, allowHTTP1: true },
      (request, response) => {
        if (request.url === "/held") {
          response.writeHead(200)
          response.write("partial")
          finishBody = () => response.end(" drained")
        } else response.end("warm")
      })
    warm.keepAliveTimeout = 100
    warm.on("secureConnection", socket => {
      active.add(socket)
      socket.on("close", () => active.delete(socket))
    })
    await new Promise(resolve => warm.listen(0, "127.0.0.1", resolve))
    const warmUrl = `https://127.0.0.1:${warm.address().port}`
    const corruptUrl = `https://127.0.0.1:${proxy.address().port}`
    const counts = []
    for (let attempt = 0; attempt < 4; attempt++) {
      await (await fetch(warmUrl)).text()
      const held = await fetch(`${warmUrl}/held`)
      await (await fetch(corruptUrl)).text()
      corrupt = true
      const repaired = await (await fetch(corruptUrl)).text()
      // Retirement must leave this other origin's active response readable.
      finishBody()
      await Promise.all([...active].map(socket => new Promise(resolve => socket.once("close", resolve))))
      // Network completion must not cancel a response the caller reads later.
      await new Promise(resolve => setImmediate(resolve))
      const drained = await held.text()
      const state = scope.state
      const finalizers = state._tag === "Open"
        ? (state.finalizer === undefined ? 0 : 1) + (state.finalizers?.size ?? 0)
        : 0
      counts.push({ repaired, drained, active: active.size, finalizers })
    }
    // An abandoned body on a retired pool still belongs to the host scope.
    await (await fetch(warmUrl)).text()
    const abandoned = await fetch(`${warmUrl}/held`)
    await (await fetch(corruptUrl)).text()
    corrupt = true
    await (await fetch(corruptUrl)).text()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    let aborted = false
    try { await abandoned.text() } catch { aborted = true }
    process.stdout.write(JSON.stringify({ counts, aborted }) + "\n")
  } else {
  const codes = []
  for (let i = 0; i < 6; i++) {
    if (i === 1) corrupt = true
    try { codes.push(await (await fetch(`https://127.0.0.1:${proxy.address().port}`, { signal: AbortSignal.timeout(2000) })).text()) }
    catch (error) { codes.push(error.cause?.code ?? error.name) }
  }
  process.stdout.write(JSON.stringify({ undici: process.versions.undici, codes }) + "\n")
  }
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const socket of sockets) socket.destroy()
  if (warm) await new Promise(resolve => warm.close(resolve))
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  if (origin) await new Promise(resolve => origin.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
