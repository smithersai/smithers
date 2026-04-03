import type { DaemonRuntimeHandle } from "../../daemon/src/bootstrap/daemon-lifecycle"

import { resolveDesktopDataRoot } from "./desktop-data-root"

export const DEFAULT_DESKTOP_DAEMON_URL = "http://localhost:7332"
export const DAEMON_HEALTH_PATH = "/api/health"
const DEFAULT_ALLOW_ATTACH_TO_EXISTING = false

export type DesktopDaemonRuntimeHandle = {
  source: "spawned" | "existing"
  url: string
  stop: () => Promise<void>
}

export class DesktopDaemonAlreadyRunningError extends Error {
  readonly daemonUrl: string

  constructor(daemonUrl: string) {
    super(`Burns is already running at ${daemonUrl}. Close the existing Burns instance and retry.`)
    this.name = "DesktopDaemonAlreadyRunningError"
    this.daemonUrl = daemonUrl
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ResolveDesktopDaemonRuntimeOptions = {
  daemonUrlEnv?: string
  fetchImpl?: FetchLike
  start?: () => Promise<DaemonRuntimeHandle>
  allowAttachToExisting?: boolean
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }

  return null
}

async function loadStartDaemon() {
  process.env.BURNS_RUNTIME_MODE = "desktop"
  process.env.BURNS_DATA_ROOT = resolveDesktopDataRoot()

  const module = await import("../../daemon/src/bootstrap/daemon-lifecycle")
  return module.startDaemon
}

function parseDaemonUrl(candidate: string | undefined): string | null {
  const rawValue = candidate?.trim()
  if (!rawValue) {
    return null
  }

  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return rawValue
    }
  } catch {
    // Ignore invalid values.
  }

  return null
}

function buildDaemonUrlCandidates(rawDaemonUrl: string | undefined): string[] {
  const parsedDaemonUrl = parseDaemonUrl(rawDaemonUrl)
  if (!parsedDaemonUrl || parsedDaemonUrl === DEFAULT_DESKTOP_DAEMON_URL) {
    return [DEFAULT_DESKTOP_DAEMON_URL]
  }

  return [parsedDaemonUrl, DEFAULT_DESKTOP_DAEMON_URL]
}

function toHealthUrl(baseUrl: string): string {
  return new URL(DAEMON_HEALTH_PATH, baseUrl).toString()
}

async function isDaemonHealthy(baseUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(toHealthUrl(baseUrl), {
      method: "GET",
      headers: {
        "cache-control": "no-cache",
      },
    })

    return response.ok
  } catch {
    return false
  }
}

async function findReachableDaemonUrl(
  candidates: string[],
  fetchImpl: FetchLike,
  options: { attempts?: number; retryDelayMs?: number } = {}
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts ?? 1)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const candidate of candidates) {
      if (await isDaemonHealthy(candidate, fetchImpl)) {
        return candidate
      }
    }

    if (attempt + 1 < attempts && retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs)
      })
    }
  }

  return null
}

function isAddressInUseError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return /EADDRINUSE|port\s+\d+\s+in use/i.test(error.message)
}

function buildExternalDaemonRuntime(url: string): DesktopDaemonRuntimeHandle {
  return {
    source: "existing",
    url,
    stop: async () => {},
  }
}

function resolveAllowAttachToExisting(rawValue: boolean | undefined): boolean {
  if (typeof rawValue === "boolean") {
    return rawValue
  }

  return parseBooleanEnv(process.env.BURNS_DESKTOP_ALLOW_ATTACH_EXISTING) ??
    DEFAULT_ALLOW_ATTACH_TO_EXISTING
}

export async function resolveDesktopDaemonRuntime(
  options: ResolveDesktopDaemonRuntimeOptions = {}
): Promise<DesktopDaemonRuntimeHandle> {
  const fetchImpl = options.fetchImpl ?? fetch
  const allowAttachToExisting = resolveAllowAttachToExisting(options.allowAttachToExisting)
  const candidates = buildDaemonUrlCandidates(
    options.daemonUrlEnv ?? process.env.BURNS_DESKTOP_DAEMON_URL
  )

  const existingDaemonUrl = await findReachableDaemonUrl(candidates, fetchImpl)
  if (existingDaemonUrl) {
    if (!allowAttachToExisting) {
      throw new DesktopDaemonAlreadyRunningError(existingDaemonUrl)
    }
    return buildExternalDaemonRuntime(existingDaemonUrl)
  }

  try {
    const start = options.start ?? (await loadStartDaemon())
    const runtime = await start()
    return {
      source: "spawned",
      url: runtime.url,
      stop: runtime.stop,
    }
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error
    }

    const daemonUrlAfterPortConflict = await findReachableDaemonUrl(candidates, fetchImpl, {
      attempts: 5,
      retryDelayMs: 250,
    })
    if (daemonUrlAfterPortConflict) {
      if (!allowAttachToExisting) {
        throw new DesktopDaemonAlreadyRunningError(daemonUrlAfterPortConflict)
      }
      return buildExternalDaemonRuntime(daemonUrlAfterPortConflict)
    }

    throw error
  }
}
