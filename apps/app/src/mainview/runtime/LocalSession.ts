import {
  isLocalSessionToken,
  localSessionProtocol,
  LOCAL_SESSION_HEADER,
  LOCAL_SESSION_META
} from "@smthrs/rpc/LocalSession"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"

/** The local Bun host injects this meta value; cloud/static builds have none. */
export const readLocalSessionToken = (
  source: Pick<Document, "querySelector"> | undefined = globalThis.document
): string | undefined => {
  const value = source?.querySelector<HTMLMetaElement>(`meta[name="${LOCAL_SESSION_META}"]`)?.content
  return isLocalSessionToken(value) ? value : undefined
}

const requestUrl = (input: string | URL | Request, base: string): URL | undefined => {
  try {
    if (input instanceof Request) return new URL(input.url, base)
    return new URL(input.toString(), base)
  } catch {
    return undefined
  }
}

/** Add the local capability only to same-origin `/api/` requests. */
export const createAppFetch = (options: {
  readonly fetchImpl?: FetchLike
  readonly token?: string
  readonly location?: Pick<Location, "href" | "origin">
} = {}): FetchLike => {
  const raw = options.fetchImpl ?? fetch.bind(globalThis)
  const token = options.token ?? readLocalSessionToken()
  const location = options.location ?? globalThis.location
  return (input, init) => {
    if (token === undefined || location === undefined) return raw(input, init)
    const url = requestUrl(input, location.href)
    if (url === undefined || url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      return raw(input, init)
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    headers.set(LOCAL_SESSION_HEADER, token)
    return raw(input, { ...init, headers })
  }
}

export const localSocketProtocols = (
  token: string | undefined = readLocalSessionToken()
): ReadonlyArray<string> => token === undefined ? [] : [localSessionProtocol(token)]
