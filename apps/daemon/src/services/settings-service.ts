import { mkdirSync } from "node:fs"
import path from "node:path"

import {
  factoryResetResultSchema,
  diagnosticsLogLevelSchema,
  onboardingStatusSchema,
  rootDirPolicySchema,
  settingsSchema,
  smithersAuthModeSchema,
  type Settings,
  type UpdateSettingsInput,
} from "@burns/shared"

import { getDefaultSmithersAuthToken, getSettingsDefaults } from "@/config/settings-defaults"
import {
  clearSettingsRow,
  findSettingsRow,
  upsertSettingsRow,
} from "@/db/repositories/settings-repository"
import { factoryResetWorkspaces } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

function validateWorkspaceRoot(workspaceRoot: string) {
  const trimmedWorkspaceRoot = workspaceRoot.trim()
  if (!path.isAbsolute(trimmedWorkspaceRoot)) {
    throw new HttpError(400, "Workspace root must be an absolute path")
  }

  const resolvedRoot = path.resolve(trimmedWorkspaceRoot)
  mkdirSync(resolvedRoot, { recursive: true })
  return resolvedRoot
}

function validateSmithersBaseUrl(baseUrl: string) {
  const trimmedBaseUrl = baseUrl.trim()

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedBaseUrl)
  } catch {
    throw new HttpError(400, "Smithers base URL must be a valid absolute URL")
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new HttpError(400, "Smithers base URL must use http or https")
  }

  return parsedUrl.toString().replace(/\/$/, "")
}

function mapStoredSettingsToResponse(row: ReturnType<typeof findSettingsRow>, defaults: Settings): Settings {
  if (!row) {
    return defaults
  }

  return settingsSchema.parse({
    workspaceRoot: row.workspace_root,
    defaultAgent: row.default_agent,
    smithersBaseUrl: row.smithers_base_url,
    allowNetwork: Boolean(row.allow_network),
    smithersManagedPerWorkspace: Boolean(row.smithers_managed_per_workspace),
    smithersAuthMode: row.smithers_auth_mode ?? defaults.smithersAuthMode,
    hasSmithersAuthToken: Boolean(row.smithers_auth_token),
    rootDirPolicy: row.root_dir_policy,
    diagnosticsLogLevel: row.diagnostics_log_level,
    diagnosticsPrettyLogs: Boolean(row.diagnostics_pretty_logs),
  })
}

function persistSettings(params: {
  settings: Settings
  onboardingCompleted: boolean
  smithersAuthToken: string | null
}) {
  upsertSettingsRow({
    workspace_root: params.settings.workspaceRoot,
    default_agent: params.settings.defaultAgent,
    smithers_base_url: params.settings.smithersBaseUrl,
    allow_network: params.settings.allowNetwork ? 1 : 0,
    smithers_managed_per_workspace: params.settings.smithersManagedPerWorkspace ? 1 : 0,
    smithers_auth_mode: params.settings.smithersAuthMode,
    smithers_auth_token: params.smithersAuthToken,
    root_dir_policy: params.settings.rootDirPolicy,
    diagnostics_log_level: params.settings.diagnosticsLogLevel,
    diagnostics_pretty_logs: params.settings.diagnosticsPrettyLogs ? 1 : 0,
    onboarding_completed: params.onboardingCompleted ? 1 : 0,
    updated_at: new Date().toISOString(),
  })
}

export function getSettings() {
  const defaults = getSettingsDefaults()
  return mapStoredSettingsToResponse(findSettingsRow(), defaults)
}

export function getSettingsWithSensitiveValues() {
  const row = findSettingsRow()
  return {
    settings: getSettings(),
    smithersAuthToken: row?.smithers_auth_token ?? getDefaultSmithersAuthToken(),
  }
}

export function haveDaemonSettingsChanged(previous: Settings, next: Settings) {
  return (
    previous.diagnosticsLogLevel !== next.diagnosticsLogLevel ||
    previous.diagnosticsPrettyLogs !== next.diagnosticsPrettyLogs
  )
}

export function updateSettings(input: UpdateSettingsInput) {
  const currentRow = findSettingsRow()
  const currentSettings = getSettings()
  const nextSettings = settingsSchema.parse({
    workspaceRoot: validateWorkspaceRoot(input.workspaceRoot),
    defaultAgent: input.defaultAgent.trim(),
    smithersBaseUrl: validateSmithersBaseUrl(input.smithersBaseUrl),
    allowNetwork: input.allowNetwork,
    smithersManagedPerWorkspace: input.smithersManagedPerWorkspace,
    smithersAuthMode: smithersAuthModeSchema.parse(input.smithersAuthMode),
    hasSmithersAuthToken:
      input.clearSmithersAuthToken ? false : input.smithersAuthToken?.trim() ? true : currentSettings.hasSmithersAuthToken,
    rootDirPolicy: rootDirPolicySchema.parse(input.rootDirPolicy),
    diagnosticsLogLevel: diagnosticsLogLevelSchema.parse(input.diagnosticsLogLevel),
    diagnosticsPrettyLogs: input.diagnosticsPrettyLogs,
  })

  const nextToken = input.clearSmithersAuthToken
    ? null
    : input.smithersAuthToken?.trim()
      ? input.smithersAuthToken.trim()
      : currentRow?.smithers_auth_token ?? null

  persistSettings({
    settings: nextSettings,
    onboardingCompleted: Boolean(currentRow?.onboarding_completed),
    smithersAuthToken: nextToken,
  })

  return getSettings()
}

export function resetSettings() {
  const currentRow = findSettingsRow()
  const defaults = getSettingsDefaults()

  persistSettings({
    settings: defaults,
    onboardingCompleted: Boolean(currentRow?.onboarding_completed),
    smithersAuthToken: null,
  })

  return getSettings()
}

export function getOnboardingStatus() {
  return onboardingStatusSchema.parse({
    completed: Boolean(findSettingsRow()?.onboarding_completed),
  })
}

export function completeOnboarding() {
  const currentRow = findSettingsRow()
  const nextSettings = currentRow ? getSettings() : getSettingsDefaults()

  persistSettings({
    settings: nextSettings,
    onboardingCompleted: true,
    smithersAuthToken: currentRow?.smithers_auth_token ?? null,
  })

  return getOnboardingStatus()
}

export function clearSettingsForTests() {
  clearSettingsRow()
}

export async function factoryResetAppState() {
  const deletedWorkspaceCount = await factoryResetWorkspaces()
  clearSettingsRow()

  return factoryResetResultSchema.parse({
    ok: true,
    deletedWorkspaceCount,
  })
}
