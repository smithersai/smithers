import {
  burnsRuntimeConfigSchema,
  type BurnsResolvedApiUrl,
  DEFAULT_BURNS_API_URL,
} from "@burns/shared"

type BurnsRuntimeConfigInput = {
  burnsApiUrl?: unknown
  runtimeMode?: unknown
}

type ResolveBurnsApiUrlInput = {
  runtimeConfig?: BurnsRuntimeConfigInput | null
  envBurnsApiUrl?: unknown
}

function parseBurnsApiUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }

  try {
    const parsedUrl = new URL(trimmedValue)
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null
    }

    return trimmedValue
  } catch {
    return null
  }
}

function readRuntimeConfigApiUrl(
  runtimeConfig: BurnsRuntimeConfigInput | null | undefined
): string | null {
  const parsedRuntime = burnsRuntimeConfigSchema.safeParse(runtimeConfig)
  if (parsedRuntime.success) {
    return parsedRuntime.data.burnsApiUrl
  }

  return parseBurnsApiUrl(runtimeConfig?.burnsApiUrl)
}

export function resolveBurnsApiUrl(input: ResolveBurnsApiUrlInput): BurnsResolvedApiUrl {
  const runtimeConfigUrl = readRuntimeConfigApiUrl(input.runtimeConfig)
  if (runtimeConfigUrl) {
    return { apiUrl: runtimeConfigUrl, source: "runtime-config" }
  }

  const envUrl = parseBurnsApiUrl(input.envBurnsApiUrl)
  if (envUrl) {
    return { apiUrl: envUrl, source: "vite-env" }
  }

  return { apiUrl: DEFAULT_BURNS_API_URL, source: "fallback" }
}

export function resolveBurnsApiUrlFromBrowserRuntime(): BurnsResolvedApiUrl {
  const runtimeConfig =
    typeof window === "undefined" ? undefined : window.__BURNS_RUNTIME_CONFIG__

  return resolveBurnsApiUrl({
    runtimeConfig,
    envBurnsApiUrl: import.meta.env.VITE_BURNS_API_URL,
  })
}
