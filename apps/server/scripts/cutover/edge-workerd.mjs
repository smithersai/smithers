import assert from "node:assert/strict"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const wrangler = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"))
let script = ""
for await (const chunk of process.stdin) script += chunk
const runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [
      { name: "edge", modules: true, script: script, compatibilityDate: "2026-08-01",
        bindings: { SMITHERS_BACKEND_ORIGIN: "https://backend.test" }, outboundService: "backend",
        serviceBindings: { ASSETS: "assets" } },
      { name: "assets", modules: true, script: 'export default { fetch() { return new Response("missing", { status: 404 }) } }' },
      { name: "backend", modules: true, script: `export default { fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") return new Response("upgrade required", { status: 426 });
        const pair = new WebSocketPair(); pair[1].accept();
        pair[1].addEventListener("message", event => pair[1].send("shared:" + event.data));
        pair[1].addEventListener("close", () => pair[1].close(1000, "done"));
        return new Response(null, { status: 101, webSocket: pair[0] });
      } }` }
    ]
  }))
try {
    const response = await runtime.dispatchFetch("https://canary.smithers.sh/api/repos/a/b/terminal", { headers: { Upgrade: "websocket" } })
    assert.equal(response.status, 101)
    const socket = response.webSocket
    assert.ok(socket)
    socket.accept()
    const received = new Promise(resolve => socket.addEventListener("message", event => resolve(event.data), { once: true }))
    socket.send("input")
    assert.equal(await received, "shared:input")
    socket.close(1000, "done")
    console.log("websocket round-trip passed")
  } finally { await runtime.dispose() }

