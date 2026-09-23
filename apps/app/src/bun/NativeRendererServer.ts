import { existsSync, statSync } from "node:fs"
import { join, normalize, resolve } from "node:path"

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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/api/")) {
        const headers = new Headers(request.headers)
        headers.delete("host")
        headers.delete("origin")
        const target = new URL(url.pathname + url.search, remote)
        return fetch(new Request(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual"
        }))
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
    }
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setTarget: (apiOrigin) => { remote = parseTarget(apiOrigin) }
  }
}
