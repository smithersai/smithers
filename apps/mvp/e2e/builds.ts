import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import type { Http2ServerResponse } from "node:http2"
import { certificate, serve } from "../dev/https"
import { PAGE_HEADERS } from "../src/pwa"

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
export const serveBuilds = async (options: { readonly old: string; readonly new?: string }) => {
  let build: Build = "old"
  const front = await serve({
    port: 0,
    upstream: new URL(process.env.DEV_UPSTREAM ?? "http://localhost:1337"),
    certificate: await certificate(join(import.meta.dirname, "..", "node_modules", ".dev-https")),
    answer: (request, response) => {
      const path = new URL(request.url, "https://localhost").pathname
      if (path.startsWith("/api/") || (build === "new" && !options.new)) return false
      void sendFile(build === "new" ? options.new! : options.old, path, response)
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
