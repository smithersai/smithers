import { build as esbuild } from "esbuild"
import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2"
import vibelang from "vibelang-unplugin/esbuild"
import { certificate, serve } from "../dev/https.ts"
import { siteAssets } from "../infra/SiteAssets.ts"
import { PAGE_HEADERS } from "../src/pwa.ts"

// Two builds of the app on one origin, as a device sees a deploy: the pages and modules of an older build (a directory
// of its built files, such as ~/Desktop/smithers-mvp/builds/7b96f878, mirrored from production), or this build from the
// dev server, while `/api/*` always reaches the dev server's ChatApi. One origin means one device: its OPFS store,
// IndexedDB outbox and Web Locks carry from the old build to the new, as they do when production deploys. It is the
// dev server's own HTTPS and HTTP/2 front (dev/https.ts), answering the old build's files itself.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
}

/** Sends the old build's file for `path`: an app route (no extension) gets its index.html, as Cloudflare serves it. */
const sendFile = async (root: string, path: string, response: Http2ServerResponse) => {
  const relative = normalize(path).replace(/^(\.\.(\/|$))+/, "")
  const file = extname(relative) === "" ? "index.html" : relative
  try {
    const body = await readFile(join(root, file))
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      ...(file === "index.html" ? PAGE_HEADERS : {}),
    })
    response.end(body)
  } catch {
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("Not in the build")
  }
}

/** Which build the origin serves. */
export type Build = "old" | "new"

/**
 * Serves `old`'s files, then `new`'s files or the dev server's pages (`use("new")`), at one HTTPS origin, with `/api/*` on the dev
 * server (`DEV_UPSTREAM`, default http://localhost:1337, the plain HTTP dev server `pnpm dev` runs). Close it when done.
 */
export const serveBuilds = async (options: { readonly old: string; readonly new?: string; readonly beforeNewWorker?: Promise<void> }) => {
  let build: Build = "old"
  const front = await serve({
    port: 0,
    upstream: new URL(process.env.DEV_UPSTREAM ?? "http://localhost:1337"),
    certificate: await certificate(join(import.meta.dirname, "..", "node_modules", ".dev-https")),
    answer: (request, response) => {
      const path = new URL(request.url, "https://localhost").pathname
      if (path.startsWith("/api/") || (build === "new" && !options.new)) return false
      const root = build === "new" ? options.new! : options.old
      if (build === "new" && path === "/sw.js" && options.beforeNewWorker !== undefined) {
        void options.beforeNewWorker.then(() => sendFile(root, path, response))
      } else void sendFile(root, path, response)
      return true
    },
  })
  return {
    url: front.url,
    use: (next: Build) => {
      build = next
    },
    close: front.close,
  }
}

const SKIP_REQUEST_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "http2-settings", "host"])
const SKIP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "http2-settings", "content-encoding", "content-length"])

const requestHeaders = (incoming: Http2ServerRequest["headers"]): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || name.startsWith(":") || SKIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return headers
}

const dispatchSite = async (worker: Miniflare, origin: string, request: Http2ServerRequest, response: Http2ServerResponse) => {
  try {
    const method = request.method ?? "GET"
    const reply = await worker.dispatchFetch(new URL(request.url ?? "/", origin), {
      method,
      headers: requestHeaders(request.headers),
      redirect: "manual",
    })
    const body = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await reply.arrayBuffer())
    const out: Record<string, string> = {}
    reply.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value
    })
    if (method !== "HEAD") out["content-length"] = String(body.byteLength)
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(reply.status, out)
      if (method === "HEAD") response.end()
      else response.end(body)
    }
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502, { "content-type": "text/plain" })
      response.end("Site worker unavailable")
    }
  }
}

/**
 * Serves two built releases through real Miniflare instances running `worker/index.ts`, `infra/SiteAssets.ts`, and each
 * build's emitted `_headers`, while forwarding `/api/*` to the dev server's ChatApi.
 */
export const serveSiteBuilds = async (options: {
  readonly old: string
  readonly new: string
  readonly beforeNewWorker?: Promise<void>
}) => {
  const root = join(import.meta.dirname, "..")
  const bundle = await esbuild({
    entryPoints: [join(root, "worker/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    conditions: ["workerd"],
    plugins: [vibelang()],
  })
  const script = bundle.outputFiles[0]!.text
  const makeWorker = (directory: string) =>
    new Miniflare({
      workers: [{
        config: {
          name: "site",
          compatibilityDate: "2026-10-19",
          manifest: {
            mainModule: "index.js",
            modulesRoot: directory,
            modules: { "index.js": { type: "esm", contents: script } },
          },
          env: { ASSETS: { type: "assets" } },
          assets: { directory, hasUserWorker: true, ...siteAssets },
        },
      }],
    })
  const workers: Record<Build, Miniflare> = {
    old: makeWorker(options.old),
    new: makeWorker(options.new),
  }
  let build: Build = "old"
  let origin = "https://localhost"
  let front: Awaited<ReturnType<typeof serve>> | undefined
  try {
    front = await serve({
      port: 0,
      upstream: new URL(process.env.DEV_UPSTREAM ?? "http://localhost:1337"),
      certificate: await certificate(join(root, "node_modules", ".dev-https")),
      answer: (request, response) => {
        const path = new URL(request.url, origin).pathname
        if (path.startsWith("/api/")) return false
        const active = workers[build]
        if (build === "new" && path === "/sw.js" && options.beforeNewWorker !== undefined) {
          void options.beforeNewWorker.then(() => dispatchSite(active, origin, request, response))
        } else {
          void dispatchSite(active, origin, request, response)
        }
        return true
      },
    })
    origin = front.url.origin
  } catch (error) {
    await Promise.allSettled([workers.old.dispose(), workers.new.dispose()])
    throw error
  }
  return {
    url: front.url,
    use: (next: Build) => {
      build = next
    },
    close: async () => {
      await front!.close()
      await Promise.allSettled([workers.old.dispose(), workers.new.dispose()])
    },
  }
}
