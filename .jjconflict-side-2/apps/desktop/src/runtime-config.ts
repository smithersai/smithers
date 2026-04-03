import {
  type BurnsRuntimeConfig,
  burnsRuntimeConfigSchema,
  DEFAULT_BURNS_API_URL,
} from "@burns/shared"

export type { BurnsRuntimeConfig }

type ResolveRuntimeConfigOptions = {
  daemonApiUrl: string
}

export const defaultRuntimeConfig: BurnsRuntimeConfig = {
  burnsApiUrl: DEFAULT_BURNS_API_URL,
  runtimeMode: "desktop",
}

function parseDesktopApiUrl(candidate: string | undefined): string | null {
  const parsed = burnsRuntimeConfigSchema.safeParse({
    burnsApiUrl: candidate,
    runtimeMode: "desktop",
  })

  if (!parsed.success) {
    return null
  }

  return parsed.data.burnsApiUrl
}

export function resolveRuntimeConfig(options: ResolveRuntimeConfigOptions): BurnsRuntimeConfig {
  const forceApiUrl = parseDesktopApiUrl(process.env.BURNS_DESKTOP_FORCE_API_URL)
  if (forceApiUrl) {
    return {
      burnsApiUrl: forceApiUrl,
      runtimeMode: "desktop",
    }
  }

  const daemonApiUrl = parseDesktopApiUrl(options.daemonApiUrl)
  if (daemonApiUrl) {
    return {
      burnsApiUrl: daemonApiUrl,
      runtimeMode: "desktop",
    }
  }

  return defaultRuntimeConfig
}

export function buildRuntimeConfigInitScript(config: BurnsRuntimeConfig): string {
  const payload = JSON.stringify(config)
  return `window.__BURNS_RUNTIME_CONFIG__ = Object.freeze(${payload});`
}
