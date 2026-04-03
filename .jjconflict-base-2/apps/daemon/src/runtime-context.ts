import {
  type RuntimeCapabilities,
  type RuntimeEnvironment,
  type RuntimeMode,
  type RuntimeOs,
  runtimeModeSchema,
} from "@burns/shared"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

export type RuntimeContextSource = "process-mode" | "request-host"

export type RuntimeContext = {
  runtimeMode: RuntimeMode
  environment: RuntimeEnvironment
  source: RuntimeContextSource
  os: RuntimeOs
  gitCommitShort: string | null
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

function detectRuntimeOs(platform: NodeJS.Platform): RuntimeOs {
  if (platform === "darwin") {
    return "darwin"
  }

  if (platform === "linux") {
    return "linux"
  }

  if (platform === "win32") {
    return "windows"
  }

  return "unknown"
}

function getGitCommitShort(cwd: string) {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    return null
  }

  const commit = result.stdout.toString().trim()
  return commit || null
}

export function buildRuntimeContext(input: {
  runtimeMode?: string
  requestHostname?: string
  platform?: NodeJS.Platform
  cwd?: string
}): RuntimeContext {
  const runtimeMode = parseRuntimeModeFromEnv(input.runtimeMode)
  const isLoopback = isLoopbackHost(input.requestHostname)
  const os = detectRuntimeOs(input.platform ?? process.platform)
  const gitCommitShort = getGitCommitShort(input.cwd ?? process.cwd())

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
    os,
    gitCommitShort,
    requestHostIsLoopback: isLoopback,
    capabilities,
  }
}
