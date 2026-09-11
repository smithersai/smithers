/*
 * A tiny HTTP router for the local server. Lanes register their routes on
 * the shared instance (`server.router.add(...)`); a path pattern may carry
 * `:param` segments. Errors follow LOCAL-APP.md:
 * `{ error: { code, message } }` with a 4xx/5xx status.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

export interface RouteContext {
  readonly request: Request
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>

interface Route {
  readonly method: HttpMethod
  readonly pattern: string
  readonly segments: ReadonlyArray<string>
  readonly handler: RouteHandler
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }
  })

export const jsonError = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

export const notImplemented = (what: string): Response =>
  jsonError(501, "not_implemented", `${what} is not implemented in this build.`)

/** A path whose percent-encoding is not valid UTF-8 is the client's error, never a 500. */
export const invalidPath = (): Response =>
  jsonError(400, "invalid_path", "Request path is not valid percent-encoded UTF-8.")

/** The decoded path or segment, or undefined when its percent-encoding is malformed. */
export const decodePath = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/*
 * The body text under `maxBytes`, or undefined once the cap is passed. The
 * stream is read chunk by chunk and dropped at the cap, so a chunked body —
 * which carries no Content-Length to refuse up front — is never buffered
 * whole.
 */
const readTextBounded = async (request: Request, maxBytes: number): Promise<string | undefined> => {
  const body = request.body
  if (body === null) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let received = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maxBytes) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return text + decoder.decode()
}

/**
 * Body as JSON, or a typed content/parse error the caller returns as-is.
 * `maxBytes` bounds what is read: a body past the cap answers 413 whether it
 * declares its length or arrives chunked.
 */
export const readJson = async (
  request: Request,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<{ readonly body: unknown } | { readonly error: Response }> => {
  const bodyTooLarge = (): { readonly error: Response } => ({
    error: jsonError(413, "body_too_large", "Request body is too large.")
  })
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > maxBytes) return bodyTooLarge()
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return { error: jsonError(415, "unsupported_media_type", "Request body must use application/json.") }
  }
  const text = await readTextBounded(request, maxBytes)
  if (text === undefined) return bodyTooLarge()
  if (text.trim() === "") return { body: undefined }
  try {
    return { body: JSON.parse(text) as unknown }
  } catch {
    return { error: jsonError(400, "invalid_json", "Request body must be valid JSON.") }
  }
}

const split = (path: string): ReadonlyArray<string> => path.split("/").filter((segment) => segment !== "")

export class Router {
  private readonly routes: Array<Route> = []

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    const existing = this.routes.findIndex((route) => route.method === method && route.pattern === pattern)
    const route: Route = { method, pattern, segments: split(pattern), handler }
    // A later registration for the same method and pattern replaces the
    // placeholder a lane's real handler supersedes.
    if (existing >= 0) this.routes[existing] = route
    else this.routes.push(route)
    return this
  }

  match(method: string, pathname: string): { readonly handler: RouteHandler; readonly params: Record<string, string> } | undefined {
    const parts = split(pathname)
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      let undecodable = false
      for (let index = 0; index < parts.length; index += 1) {
        const expected = route.segments[index] ?? ""
        const actual = parts[index] ?? ""
        if (expected.startsWith(":")) {
          const decoded = decodePath(actual)
          // The route still claims the path; its refusal is the handler.
          if (decoded === undefined) undecodable = true
          else params[expected.slice(1)] = decoded
        } else if (expected !== actual) {
          matched = false
          break
        }
      }
      if (matched) return undecodable ? { handler: invalidPath, params: {} } : { handler: route.handler, params }
    }
    return undefined
  }

  /** True when some route, of any method, claims the path. */
  knows(pathname: string): boolean {
    const parts = split(pathname)
    return this.routes.some((route) =>
      route.segments.length === parts.length &&
      route.segments.every((segment, index) => segment.startsWith(":") || segment === parts[index])
    )
  }
}
