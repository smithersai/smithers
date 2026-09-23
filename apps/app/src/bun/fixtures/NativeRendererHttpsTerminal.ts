import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startNativeRendererServer } from "../NativeRendererServer"

const cert = Bun.env.SMITHERS_NATIVE_HTTPS_CERT!
const key = Bun.env.SMITHERS_NATIVE_HTTPS_KEY!
const dist = mkdtempSync(join(tmpdir(), "smithers-native-https-ui-"))
writeFileSync(join(dist, "index.html"), "<div>packaged UI</div>")
const backend = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch: async (request, server) => {
    if (request.headers.get("origin") !== `https://localhost:${server.port}`) return new Response("Invalid origin", { status: 403 })
    // A first TLS connection can still be handshaking while CEF emits one
    // WebSocket frame per key. Keep the real upgrade path pending here.
    await Bun.sleep(750)
    return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 })
  },
  websocket: { message(socket, frame) { socket.send(frame) } }
})
const relay = startNativeRendererServer(dist, `https://localhost:${backend.port}`)
try {
  const received = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${relay.origin.replace("http:", "ws:")}/api/terminal`, {
      headers: { origin: relay.origin }
    } as never)
    let output = ""
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Only ${output.length} input frames returned`)) }, 5_000)
    socket.addEventListener("open", () => {
      for (let index = 0; index < 64; index++) socket.send("x")
    })
    socket.addEventListener("message", (event) => {
      output += String(event.data)
      if (output.length === 64) { clearTimeout(timer); socket.close(); resolve(output) }
    })
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay socket errored")) })
    socket.addEventListener("close", (event) => {
      if (output.length !== 64) { clearTimeout(timer); reject(new Error(`Relay closed ${event.code}: ${event.reason}`)) }
    })
  })
  assert.equal(received, "x".repeat(64))
  console.log("HTTPS_TERMINAL_OK")
} finally {
  relay.stop()
  backend.stop(true)
  rmSync(dist, { recursive: true, force: true })
}
