import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startNativeRendererServer } from "./NativeRendererServer"

const close: Array<() => void> = []
afterEach(() => { for (const stop of close.splice(0)) stop() })

test("packaged Plue window serves its UI and forwards authenticated product API calls", async () => {
  const dist = mkdtempSync(join(tmpdir(), "smithers-native-plue-ui-"))
  close.push(() => rmSync(dist, { recursive: true, force: true }))
  mkdirSync(join(dist, "assets"))
  writeFileSync(join(dist, "index.html"), "<html><body>packaged UI</body></html>")
  writeFileSync(join(dist, "assets", "main.js"), "window.packaged = true")
  const seen: Array<{ path: string; auth: string | null; body: string }> = []
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body: await request.text() })
    return Response.json({ buildSha: "remote" })
  } })
  close.push(() => remote.stop(true))
  const native = startNativeRendererServer(dist, `http://127.0.0.1:${remote.port}`)
  close.push(native.stop)

  expect(await (await fetch(`${native.origin}/owner/repo`)).text()).toContain("packaged UI")
  expect(await (await fetch(`${native.origin}/assets/main.js`)).text()).toBe("window.packaged = true")
  const response = await fetch(`${native.origin}/api/bootstrap`, { headers: { authorization: "Bearer owner-token" } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ buildSha: "remote" })
  const mutation = await fetch(`${native.origin}/api/issues`, { method: "POST", headers: {
    authorization: "Bearer owner-token", "content-type": "application/json"
  }, body: JSON.stringify({ title: "Native issue" }) })
  expect(mutation.status).toBe(200)
  expect(seen).toEqual([
    { path: "/api/bootstrap", auth: "Bearer owner-token", body: "" },
    { path: "/api/issues", auth: "Bearer owner-token", body: '{"title":"Native issue"}' }
  ])
  expect(() => startNativeRendererServer(dist, "file:///private/backend")).toThrow("Native API origin")
})

test("native UI stays available when the selected backend has no bootstrap", async () => {
  const dist = mkdtempSync(join(tmpdir(), "smithers-native-missing-bootstrap-"))
  close.push(() => rmSync(dist, { recursive: true, force: true }))
  writeFileSync(join(dist, "index.html"), "<div id='root'>packaged UI</div>")
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("404", { status: 404 }) })
  close.push(() => remote.stop(true))
  const native = startNativeRendererServer(dist, `http://127.0.0.1:${remote.port}`)
  close.push(native.stop)
  expect(await (await fetch(`${native.origin}/`)).text()).toContain("packaged UI")
  expect((await fetch(`${native.origin}/api/bootstrap`)).status).toBe(404)
  const ready = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ apiVersion: 1 }) })
  close.push(() => ready.stop(true))
  native.setTarget(`http://127.0.0.1:${ready.port}`)
  expect(await (await fetch(`${native.origin}/api/bootstrap`)).json()).toEqual({ apiVersion: 1 })
  expect(() => native.setTarget("file:///private/backend")).toThrow("Native API origin")
  expect(await (await fetch(`${native.origin}/api/bootstrap`)).json()).toEqual({ apiVersion: 1 })
})

test("packaged Plue window relays a compressed backend response as readable JSON", async () => {
  const dist = mkdtempSync(join(tmpdir(), "smithers-native-compressed-"))
  close.push(() => rmSync(dist, { recursive: true, force: true }))
  writeFileSync(join(dist, "index.html"), "<div id='root'>packaged UI</div>")
  // A CDN in front of Plue gzips API responses; fetch decodes the body, so the
  // relay must not keep advertising the original encoding.
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.gzipSync(JSON.stringify({ buildSha: "compressed" })), {
    headers: { "content-type": "application/json", "content-encoding": "gzip" }
  }) })
  close.push(() => remote.stop(true))
  const native = startNativeRendererServer(dist, `http://127.0.0.1:${remote.port}`)
  close.push(native.stop)
  const response = await fetch(`${native.origin}/api/bootstrap`, { headers: { "accept-encoding": "gzip" } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ buildSha: "compressed" })
})

test("packaged terminal WebSocket reaches the selected backend with its owner session", async () => {
  const dist = mkdtempSync(join(tmpdir(), "smithers-native-terminal-"))
  close.push(() => rmSync(dist, { recursive: true, force: true }))
  writeFileSync(join(dist, "index.html"), "<div>packaged UI</div>")
  const seen: Array<{ path: string; origin: string | null; cookie: string | null }> = []
  const remote = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      seen.push({ path: url.pathname + url.search, origin: request.headers.get("origin"), cookie: request.headers.get("cookie") })
      if (request.headers.get("origin") !== `http://127.0.0.1:${server.port}` ||
        request.headers.get("cookie") !== "smithers_session=owner") return new Response("Forbidden", { status: 403 })
      return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 })
    },
    websocket: { message(socket, message) { socket.send(message) } }
  })
  close.push(() => remote.stop(true))
  const native = startNativeRendererServer(dist, `http://127.0.0.1:${remote.port}`)
  close.push(native.stop)

  const response = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${native.origin.replace("http:", "ws:")}/api/repos/owner/repo/workspace/sessions/session/terminal?ticket=owner`, {
      headers: { origin: native.origin, cookie: "smithers_session=owner" }
    } as never)
    socket.addEventListener("open", () => socket.send("native terminal"))
    socket.addEventListener("message", (event) => { resolve(String(event.data)); socket.close() })
    socket.addEventListener("error", () => reject(new Error("terminal WebSocket failed")))
    socket.addEventListener("close", () => reject(new Error("terminal WebSocket closed before output")))
  })
  expect(response).toBe("native terminal")
  expect(seen).toEqual([{ path: "/api/repos/owner/repo/workspace/sessions/session/terminal?ticket=owner",
    origin: `http://127.0.0.1:${remote.port}`, cookie: "smithers_session=owner" }])
})
