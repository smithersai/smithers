import type { ServerWebSocket } from "bun"
import { existsSync, statSync } from "node:fs"
import { join, normalize, resolve } from "node:path"

type Tunnel = {
  target: string
  headers: Record<string, string>
  upstream?: WebSocket
  pending: Array<string | Buffer>
  opened: boolean
}

/** The packaged native UI always serves locally and relays only API paths. */
export const startNativeRendererServer = (distDirectory: string, apiOrigin: string): {
  readonly origin: string
  readonly stop: () => void
  readonly setTarget: (apiOrigin: string) => void
} => {
  const dist = resolve(distDirectory)
  const index = join(dist, "index.html")
  if (!existsSync(index)) throw new Error(`The packaged UI is missing ${index}.`)
  const parseTarget = (value: string): URL => {
    let target: URL
    try { target = new URL(value) }
    catch { throw new Error("Native API origin must be a credential-free HTTP(S) origin.") }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) {
      throw new Error("Native API origin must be a credential-free HTTP(S) origin.")
    }
    return target
  }
  let remote = parseTarget(apiOrigin)
  let origin = ""
  const tunnels = new Set<ServerWebSocket<Tunnel>>()
  const server = Bun.serve<Tunnel>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (request.headers.get("origin") !== origin) return new Response("Invalid origin", { status: 403 })
          const target = new URL(url.pathname + url.search, remote)
          target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
          const headers: Record<string, string> = { origin: remote.origin }
          for (const name of ["cookie", "authorization"]) {
            const value = request.headers.get(name)
            if (value !== null) headers[name] = value
          }
          return server.upgrade(request, { data: { target: target.toString(), headers, pending: [], opened: false } })
            ? undefined : new Response("Upgrade required", { status: 426 })
        }
        const headers = new Headers(request.headers)
        headers.delete("host")
        headers.delete("origin")
        const target = new URL(url.pathname + url.search, remote)
        const response = await fetch(new Request(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual"
        }))
        // fetch has already decoded the body; the original encoding and
        // length would make the renderer decode it a second time.
        const relayed = new Headers(response.headers)
        relayed.delete("content-encoding")
        relayed.delete("content-length")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayed })
      }
      let decoded: string
      try { decoded = decodeURIComponent(url.pathname) }
      catch { return new Response("Invalid path", { status: 400 }) }
      const relative = normalize(decoded).replace(/^\/+/, "")
      const file = resolve(dist, relative)
      if (relative !== "" && file.startsWith(dist + "/") && statSync(file, { throwIfNoEntry: false })?.isFile()) {
        return new Response(Bun.file(file), { headers: { "cache-control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable" : "no-store" } })
      }
      return new Response(Bun.file(index), { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" } })
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        tunnels.add(socket)
        const tunnel = socket.data
        const upstream = new WebSocket(tunnel.target, { headers: tunnel.headers } as never)
        tunnel.upstream = upstream
        upstream.binaryType = "arraybuffer"
        upstream.addEventListener("open", () => {
          tunnel.opened = true
          for (const frame of tunnel.pending) upstream.send(frame)
          tunnel.pending.length = 0
        })
        upstream.addEventListener("message", (event) => socket.send(event.data as string | ArrayBuffer))
        upstream.addEventListener("close", (event) => {
          tunnels.delete(socket)
          if (event.code === 1005 || event.code === 1006 || event.code === 1001) socket.terminate()
          else socket.close(event.code, event.reason)
        })
        upstream.addEventListener("error", () => {
          tunnels.delete(socket)
          socket.terminate()
        })
      },
      message(socket, frame) {
        const tunnel = socket.data
        if (tunnel.upstream?.readyState === WebSocket.OPEN) {
          if (tunnel.upstream.bufferedAmount > 1024 * 1024) socket.close(1009, "Terminal input outran backend")
          else tunnel.upstream.send(frame)
        } else if (tunnel.pending.length < 32) tunnel.pending.push(frame)
        else socket.close(1011, "Backend socket did not open")
      },
      close(socket) {
        tunnels.delete(socket)
        try { socket.data.upstream?.close() }
        catch { /* The backend socket may have failed before its handshake completed. */ }
      }
    }
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    origin,
    stop: () => {
      for (const socket of tunnels) socket.terminate()
      server.stop(true)
    },
    setTarget: (apiOrigin) => { remote = parseTarget(apiOrigin) }
  }
}
