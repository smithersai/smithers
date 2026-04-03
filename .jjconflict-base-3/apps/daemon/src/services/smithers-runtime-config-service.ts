import type {
  Settings,
  Workspace,
  WorkspaceSmithersRuntimeConfig,
} from "@burns/shared"

import { getSettingsWithSensitiveValues } from "@/services/settings-service"

export function getBurnsSmithersRuntimeDefaults() {
  const { settings } = getSettingsWithSensitiveValues()

  return {
    smithersManagedPerWorkspace: settings.smithersManagedPerWorkspace,
    smithersBaseUrl: settings.smithersBaseUrl,
    allowNetwork: settings.allowNetwork,
    maxConcurrency: settings.maxConcurrency,
    maxBodyBytes: settings.maxBodyBytes,
    rootDirPolicy: settings.rootDirPolicy,
  }
}

export function haveManagedRuntimeSettingsChanged(previous: Settings, next: Settings) {
  return (
    previous.smithersManagedPerWorkspace !== next.smithersManagedPerWorkspace ||
    previous.allowNetwork !== next.allowNetwork ||
    previous.maxBodyBytes !== next.maxBodyBytes ||
    previous.rootDirPolicy !== next.rootDirPolicy
  )
}

export function buildSmithersAuthHeaders() {
  const { settings, smithersAuthToken } = getSettingsWithSensitiveValues()

  if (!settings.hasSmithersAuthToken || !smithersAuthToken) {
    return {}
  }

  if (settings.smithersAuthMode === "x-smithers-key") {
    return { "x-smithers-key": smithersAuthToken }
  }

  return { authorization: `Bearer ${smithersAuthToken}` }
}

export function resolveWorkspaceSmithersRuntimeConfig(
  workspace: Workspace,
  options: {
    managedBaseUrl?: string | null
  } = {}
): WorkspaceSmithersRuntimeConfig {
  const { settings } = getSettingsWithSensitiveValues()

  if (workspace.runtimeMode === "self-managed") {
    return {
      workspaceId: workspace.id,
      workspaceRuntimeMode: workspace.runtimeMode,
      managementMode: "self-managed",
      baseUrl: workspace.smithersBaseUrl ?? null,
      baseUrlSource: "workspace",
      allowNetwork: settings.allowNetwork,
      rootDirPolicy: settings.rootDirPolicy,
      smithersAuthMode: settings.smithersAuthMode,
      hasSmithersAuthToken: settings.hasSmithersAuthToken,
      canAutoRestart: false,
    }
  }

  if (!settings.smithersManagedPerWorkspace) {
    return {
      workspaceId: workspace.id,
      workspaceRuntimeMode: workspace.runtimeMode,
      managementMode: "disabled",
      baseUrl: settings.smithersBaseUrl,
      baseUrlSource: "global-setting",
      allowNetwork: settings.allowNetwork,
      rootDirPolicy: settings.rootDirPolicy,
      smithersAuthMode: settings.smithersAuthMode,
      hasSmithersAuthToken: settings.hasSmithersAuthToken,
      canAutoRestart: false,
    }
  }

  return {
    workspaceId: workspace.id,
    workspaceRuntimeMode: workspace.runtimeMode,
    managementMode: "burns-managed",
    baseUrl: options.managedBaseUrl ?? null,
    baseUrlSource: options.managedBaseUrl ? "managed-instance" : "pending-managed-instance",
    allowNetwork: settings.allowNetwork,
    rootDirPolicy: settings.rootDirPolicy,
    smithersAuthMode: settings.smithersAuthMode,
    hasSmithersAuthToken: settings.hasSmithersAuthToken,
    canAutoRestart: true,
  }
}
