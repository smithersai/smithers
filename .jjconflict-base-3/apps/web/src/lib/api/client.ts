import { BurnsClient } from "@burns/client"
import { resolveBurnsApiUrlFromBrowserRuntime } from "@/lib/api/resolve-burns-api-url"

const resolvedApiUrl = resolveBurnsApiUrlFromBrowserRuntime()

export const BURNS_API_URL = resolvedApiUrl.apiUrl
export const BURNS_API_URL_SOURCE = resolvedApiUrl.source

export const burnsClient = new BurnsClient(BURNS_API_URL)

export function isLocalhostBurnsApiUrl() {
  try {
    const parsedUrl = new URL(BURNS_API_URL)
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "::1"
    )
  } catch {
    return false
  }
}
