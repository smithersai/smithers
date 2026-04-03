import { mkdirSync } from "node:fs"
import path from "node:path"

import {
  type Settings,
  type SmithersAuthMode,
  type RootDirPolicy,
  type DiagnosticsLogLevel,
} from "@burns/shared"

import {
  DEFAULT_AGENT,
  DEFAULT_SMITHERS_BASE_URL,
  DEFAULT_SMITHERS_MAX_BODY_BYTES,
  DEFAULT_SMITHERS_MAX_CONCURRENCY,
} from "@/config/app-config"
import { DEFAULT_WORKSPACES_ROOT } from "@/config/paths"

function parseBooleanEnv(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }

  return undefined
}

function parseLogLevelEnv(value: string | undefined): DiagnosticsLogLevel | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (["trace", "debug", "info", "warn", "error", "silent"].includes(normalized)) {
    return normalized as DiagnosticsLogLevel
  }

  return undefined
}

function parsePositiveIntEnv(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined
  }

  return parsed
}

function resolveDefaultSmithersBaseUrl() {
  return process.env.BURNS_SMITHERS_BASE_URL?.trim() || DEFAULT_SMITHERS_BASE_URL
}

export function getDefaultSmithersAuthToken() {
  const configuredToken = process.env.BURNS_SMITHERS_AUTH_TOKEN?.trim()
  return configuredToken && configuredToken.length > 0 ? configuredToken : null
}

export function getDefaultSmithersManagedPerWorkspace() {
  return process.env.BURNS_SMITHERS_MANAGED_MODE !== "0" && process.env.NODE_ENV !== "test"
}

export function getDefaultWorkspaceRoot() {
  const configuredWorkspaceRoot = process.env.BURNS_WORKSPACES_ROOT?.trim()
  const workspaceRoot =
    configuredWorkspaceRoot && configuredWorkspaceRoot.length > 0
      ? path.resolve(configuredWorkspaceRoot)
      : DEFAULT_WORKSPACES_ROOT

  mkdirSync(workspaceRoot, { recursive: true })
  return workspaceRoot
}

export function getSettingsDefaults(): Settings {
  return {
    workspaceRoot: getDefaultWorkspaceRoot(),
    defaultAgent: process.env.BURNS_DEFAULT_AGENT?.trim() || DEFAULT_AGENT,
    smithersBaseUrl: resolveDefaultSmithersBaseUrl(),
    allowNetwork: parseBooleanEnv(process.env.BURNS_SMITHERS_ALLOW_NETWORK) ?? false,
    maxConcurrency: parsePositiveIntEnv(process.env.BURNS_SMITHERS_MAX_CONCURRENCY) ?? DEFAULT_SMITHERS_MAX_CONCURRENCY,
    maxBodyBytes: parsePositiveIntEnv(process.env.BURNS_SMITHERS_MAX_BODY_BYTES) ?? DEFAULT_SMITHERS_MAX_BODY_BYTES,
    smithersManagedPerWorkspace: getDefaultSmithersManagedPerWorkspace(),
    smithersAuthMode:
      (process.env.BURNS_SMITHERS_AUTH_MODE?.trim() as SmithersAuthMode | undefined) ?? "bearer",
    hasSmithersAuthToken: Boolean(getDefaultSmithersAuthToken()),
    rootDirPolicy:
      (process.env.BURNS_SMITHERS_ROOT_DIR_POLICY?.trim() as RootDirPolicy | undefined) ??
      "workspace-root",
    diagnosticsLogLevel: parseLogLevelEnv(process.env.BURNS_LOG_LEVEL) ?? "info",
    diagnosticsPrettyLogs: parseBooleanEnv(process.env.BURNS_LOG_PRETTY) ?? false,
  }
}
