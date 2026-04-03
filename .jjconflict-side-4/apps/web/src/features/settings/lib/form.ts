import type { Settings, UpdateSettingsInput } from "@burns/shared"

import {
  isAbsolutePath,
  validateSmithersUrl,
} from "@/features/workspaces/add-workspace/lib/validation"

export type SettingsFormValues = {
  workspaceRoot: string
  defaultAgent: string
  smithersBaseUrl: string
  allowNetwork: "true" | "false"
  maxConcurrency: string
  maxBodyBytes: string
  smithersManagedPerWorkspace: "true" | "false"
  smithersAuthMode: Settings["smithersAuthMode"]
  smithersAuthToken: string
  rootDirPolicy: Settings["rootDirPolicy"]
  diagnosticsLogLevel: Settings["diagnosticsLogLevel"]
  diagnosticsPrettyLogs: "true" | "false"
}

export type SettingsFormErrors = Partial<Record<keyof SettingsFormValues, string>>

export function settingsToFormValues(settings: Settings): SettingsFormValues {
  return {
    workspaceRoot: settings.workspaceRoot,
    defaultAgent: settings.defaultAgent,
    smithersBaseUrl: settings.smithersBaseUrl,
    allowNetwork: String(settings.allowNetwork) as "true" | "false",
    maxConcurrency: String(settings.maxConcurrency),
    maxBodyBytes: String(settings.maxBodyBytes),
    smithersManagedPerWorkspace: String(settings.smithersManagedPerWorkspace) as "true" | "false",
    smithersAuthMode: settings.smithersAuthMode,
    smithersAuthToken: "",
    rootDirPolicy: settings.rootDirPolicy,
    diagnosticsLogLevel: settings.diagnosticsLogLevel,
    diagnosticsPrettyLogs: String(settings.diagnosticsPrettyLogs) as "true" | "false",
  }
}

export function validateSettingsForm(values: SettingsFormValues): SettingsFormErrors {
  const errors: SettingsFormErrors = {}

  if (!values.workspaceRoot.trim()) {
    errors.workspaceRoot = "Workspace root is required."
  } else if (!isAbsolutePath(values.workspaceRoot.trim())) {
    errors.workspaceRoot = "Workspace root must be an absolute path."
  }

  if (!values.defaultAgent.trim()) {
    errors.defaultAgent = "Default agent is required."
  }

  const smithersUrlError = validateSmithersUrl(values.smithersBaseUrl)
  if (smithersUrlError) {
    errors.smithersBaseUrl = smithersUrlError
  }

  const maxConcurrency = Number(values.maxConcurrency)
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
    errors.maxConcurrency = "Max concurrency must be a positive integer."
  }

  const maxBodyBytes = Number(values.maxBodyBytes)
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    errors.maxBodyBytes = "Max body bytes must be a positive integer."
  }

  return errors
}

export function buildUpdateSettingsInput(
  values: SettingsFormValues,
  options: { clearSmithersAuthToken?: boolean } = {}
): UpdateSettingsInput {
  return {
    workspaceRoot: values.workspaceRoot.trim(),
    defaultAgent: values.defaultAgent.trim(),
    smithersBaseUrl: values.smithersBaseUrl.trim(),
    allowNetwork: values.allowNetwork === "true",
    maxConcurrency: Number(values.maxConcurrency),
    maxBodyBytes: Number(values.maxBodyBytes),
    smithersManagedPerWorkspace: values.smithersManagedPerWorkspace === "true",
    smithersAuthMode: values.smithersAuthMode,
    smithersAuthToken: values.smithersAuthToken.trim() || undefined,
    clearSmithersAuthToken: options.clearSmithersAuthToken ?? false,
    rootDirPolicy: values.rootDirPolicy,
    diagnosticsLogLevel: values.diagnosticsLogLevel,
    diagnosticsPrettyLogs: values.diagnosticsPrettyLogs === "true",
  }
}

export function shouldShowOnboarding(options: {
  workspacesCount: number
  onboardingCompleted: boolean
}) {
  return options.workspacesCount === 0 && !options.onboardingCompleted
}

export function buildDefaultAgentOptions(
  agentClis: ReadonlyArray<{ name: string }>,
  currentValue: string
) {
  const installedOptions = agentClis.map((agent) => ({
    value: agent.name,
    label: agent.name,
  }))

  if (!currentValue.trim()) {
    return installedOptions
  }

  if (installedOptions.some((option) => option.value === currentValue)) {
    return installedOptions
  }

  return [
    { value: currentValue, label: `${currentValue} (current)` },
    ...installedOptions,
  ]
}
