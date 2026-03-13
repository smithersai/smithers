import {
  type RuntimeCapabilities,
  type RuntimeEnvironment,
  type RuntimeMode,
  runtimeModeSchema,
} from "@burns/shared"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

export type RuntimeContextSource = "process-mode" | "request-host"

export type RuntimeContext = {
  runtimeMode: RuntimeMode
  environment: RuntimeEnvironment
  source: RuntimeContextSource
  requestHostIsLoopback: boolean
  capabilities: RuntimeCapabilities
}

function parseRuntimeModeFromEnv(value: string | undefined): RuntimeMode {
  const trimmed = value?.trim()
  if (!trimmed) {
    return "dev"
  }

  const parsed = runtimeModeSchema.safeParse(trimmed)
  if (!parsed.success) {
    return "dev"
  }

  return parsed.data
}

export function isLoopbackHost(hostname: string | null | undefined): boolean {
  if (!hostname) {
    return false
  }

  return LOOPBACK_HOSTS.has(hostname)
}

export function buildRuntimeContext(input: {
  runtimeMode?: string
  requestHostname?: string
}): RuntimeContext {
  const runtimeMode = parseRuntimeModeFromEnv(input.runtimeMode)
  const isLoopback = isLoopbackHost(input.requestHostname)

  const source: RuntimeContextSource =
    runtimeMode === "dev" ? "request-host" : "process-mode"

  const environment = isLoopback
    ? (runtimeMode === "desktop" ? "desktop" : "local")
    : "remote"

  const canPerformLocalActions = isLoopback

  const capabilities: RuntimeCapabilities = {
    openNativeFolderPicker: canPerformLocalActions,
    openTerminal: canPerformLocalActions,
    openVscode: canPerformLocalActions,
  }

  return {
    runtimeMode,
    environment,
    source,
    requestHostIsLoopback: isLoopback,
    capabilities,
  }
}
