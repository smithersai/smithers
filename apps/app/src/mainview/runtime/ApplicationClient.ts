import type { ApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"

export type ApplicationClientErrorCode =
  | "cancelled"
  | "auth-missing"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "api"
  | "transport"
  | "invalid-target"
  | "invalid-response"

export class ApplicationClientError extends Error {
  readonly name = "ApplicationClientError"

  constructor(
    readonly code: ApplicationClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly apiCode: string | null = null,
    readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export interface ApplicationClientOptions {
  readonly fetchImpl?: FetchLike
  /** Tokens stay in the host auth adapter; runtime target documents contain no secrets. */
  readonly token?: () => string | undefined | Promise<string | undefined>
}

export interface ApplicationRequestOptions extends RequestInit {
  readonly expect?: "json" | "empty"
}

export interface ApplicationClient {
  readonly target: ApplicationTarget
  readonly baseUrl: string
  readonly fetch: FetchLike
  readonly request: <T = unknown>(path: string, init?: ApplicationRequestOptions) => Promise<T>
  /** Authenticated streaming request; the caller owns and cancels the response body. */
  readonly stream: (path: string, init?: RequestInit) => Promise<Response>
}

const isAbort = (error: unknown, signal: AbortSignal | null | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError")

const retryAfter = (response: Response): number | null => {
  const raw = response.headers.get("retry-after")?.trim()
  if (raw === undefined || raw === "") return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

const apiFailure = async (response: Response): Promise<ApplicationClientError> => {
  const body = await response.json().catch(() => null) as { code?: unknown; message?: unknown; error?: unknown } | null
  const message = typeof body?.message === "string" && body.message !== ""
    ? body.message
    : typeof body?.error === "string" && body.error !== ""
    ? body.error
    : `Request failed (${response.status}).`
  const apiCode = typeof body?.code === "string" && body.code !== "" ? body.code : null
  const code: ApplicationClientErrorCode = response.status === 401
    ? "unauthenticated"
    : response.status === 403
    ? "forbidden"
    : response.status === 429
    ? "rate-limited"
    : "api"
  return new ApplicationClientError(code, message, response.status, apiCode, retryAfter(response))
}

const targetUrl = (baseUrl: string, input: string | URL | Request): string | URL | Request => {
  if (baseUrl === "") return input
  if (input instanceof Request) return new Request(new URL(input.url, baseUrl), input)
  if (input instanceof URL) return new URL(input.toString(), baseUrl)
  return new URL(input, `${baseUrl}/`).toString()
}

const assertTargetOrigin = (
  baseUrl: string,
  input: string | URL | Request
): void => {
  const selectedOrigin = baseUrl !== ""
    ? baseUrl
    : typeof globalThis.location === "undefined"
    ? null
    : globalThis.location.origin
  if (selectedOrigin === null) return
  const raw = input instanceof Request ? input.url : input.toString()
  let requested: URL
  try {
    requested = new URL(raw, `${selectedOrigin}/`)
  } catch (error) {
    throw new ApplicationClientError("invalid-target", "Request URL is invalid.", null, null, null, { cause: error })
  }
  if (requested.origin !== selectedOrigin) {
    throw new ApplicationClientError(
      "invalid-target",
      "Application credentials cannot be sent outside the selected backend origin."
    )
  }
}

/** One auth, URL, cancellation, and error boundary for every application mode. */
export const createApplicationClient = (
  target: ApplicationTarget,
  options: ApplicationClientOptions = {}
): ApplicationClient => {
  const raw = options.fetchImpl ?? fetch.bind(globalThis)
  const authenticatedFetch: FetchLike = async (input, init) => {
    assertTargetOrigin(target.baseUrl, input)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const next: RequestInit = { ...init, headers }
    if (target.auth.kind === "session") {
      next.credentials = "include"
    } else {
      const token = (await options.token?.())?.trim()
      if (token === undefined || token === "") {
        throw new ApplicationClientError("auth-missing", `No ${target.auth.kind} token is available for this backend.`)
      }
      headers.set("authorization", `${target.auth.kind === "bearer" ? "Bearer" : "token"} ${token}`)
      next.credentials = "omit"
    }
    return raw(targetUrl(target.baseUrl, input), next)
  }

  const stream = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      const response = await authenticatedFetch(path, init)
      if (!response.ok) throw await apiFailure(response)
      return response
    } catch (error) {
      if (error instanceof ApplicationClientError) throw error
      if (isAbort(error, init?.signal)) {
        throw new ApplicationClientError("cancelled", "Request cancelled.", null, null, null, { cause: error })
      }
      throw new ApplicationClientError(
        "transport",
        error instanceof Error ? error.message : String(error),
        null,
        null,
        null,
        { cause: error }
      )
    }
  }

  const request = async <T = unknown>(path: string, init: ApplicationRequestOptions = {}): Promise<T> => {
    const { expect = "json", ...requestInit } = init
    const response = await stream(path, requestInit)
    if (expect === "empty" || response.status === 204) return undefined as T
    try {
      return await response.json() as T
    } catch (error) {
      throw new ApplicationClientError(
        "invalid-response",
        "Backend returned invalid JSON.",
        response.status,
        null,
        null,
        { cause: error }
      )
    }
  }

  return { target, baseUrl: target.baseUrl, fetch: authenticatedFetch, request, stream }
}
