import { existsSync, statSync } from "node:fs"
import { join, normalize, resolve } from "node:path"

/** The packaged Plue window serves its own UI and relays the same API paths. */
export const startNativePlueServer = (distDirectory: string, apiOrigin: string): { readonly origin: string; readonly stop: () => void } => {
  const dist = resolve(distDirectory)
  const index = join(dist, "index.html")
  if (!existsSync(index)) throw new Error(`The packaged UI is missing ${index}.`)
  const remote = new URL(apiOrigin)
  if (!/^https?:$/.test(remote.protocol) || remote.username || remote.password ||
    remote.pathname !== "/" || remote.search || remote.hash) {
    throw new Error("Plue API origin must be a credential-free HTTP(S) origin.")
  }
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
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
