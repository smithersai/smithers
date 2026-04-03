import { access, stat } from "node:fs/promises"
import path from "node:path"

import { resolveWebDistPath } from "./paths"

export const DEFAULT_WEB_HOST = "127.0.0.1"
export const DEFAULT_WEB_PORT = 4173

type StartWebServerOptions = {
  host: string
  port: number
}

function mapOpenHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1"
  }

  return host
}

export function getWebUrl(host: string, port: number) {
  return `http://${mapOpenHost(host)}:${port}`
}

function getContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
      return "application/javascript; charset=utf-8"
    case ".mjs":
      return "application/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".ico":
      return "image/x-icon"
    default:
      return "application/octet-stream"
  }
}

async function fileExists(filePath: string) {
  try {
    const fileStats = await stat(filePath)
    return fileStats.isFile()
  } catch {
    return false
  }
}

function resolveAssetPath(distRoot: string, pathname: string) {
  const decodedPath = decodeURIComponent(pathname)
  const normalizedPath = decodedPath === "/" ? "/index.html" : decodedPath
  const relativeAssetPath = normalizedPath.replace(/^\/+/, "")
  const candidatePath = path.resolve(distRoot, relativeAssetPath)

  const distRootWithSeparator = `${distRoot}${path.sep}`
  if (candidatePath !== distRoot && !candidatePath.startsWith(distRootWithSeparator)) {
    return null
  }

  return candidatePath
}

export async function hasBuiltWebApp() {
  const indexPath = path.join(resolveWebDistPath(), "index.html")

  try {
    await access(indexPath)
    return true
  } catch {
    return false
  }
}

export function getMissingWebBuildGuidance() {
  return [
    `Built web assets were not found at ${resolveWebDistPath()}.`,
    "Build the web app first from repository root:",
    "  bun run build:web",
  ].join("\n")
}

export function startWebServer(options: StartWebServerOptions) {
  const distRoot = resolveWebDistPath()

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request: Request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 })
      }

      const requestPath = new URL(request.url).pathname
      const candidatePath = resolveAssetPath(distRoot, requestPath)

      if (!candidatePath) {
        return new Response("Not found", { status: 404 })
      }

      const filePath = (await fileExists(candidatePath)) ? candidatePath : path.join(distRoot, "index.html")
      if (!(await fileExists(filePath))) {
        return new Response("Not found", { status: 404 })
      }

      return new Response(Bun.file(filePath), {
        headers: {
          "content-type": getContentType(filePath),
        },
      })
    },
  })

  return {
    server,
    url: getWebUrl(options.host, options.port),
    stop() {
      server.stop(true)
    },
  }
}
