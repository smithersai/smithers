import { updateSettingsInputSchema } from "@burns/shared"

import {
  completeOnboarding,
  factoryResetAppState,
  getOnboardingStatus,
  getSettings,
  getSettingsWithSensitiveValues,
  haveDaemonSettingsChanged,
  resetSettings,
  updateSettings,
} from "@/services/settings-service"
import { scheduleDaemonRestart } from "@/services/daemon-runtime-control-service"
import { reconcileManagedWorkspaceRuntimeAfterSettingsChange } from "@/services/smithers-instance-service"
import { toErrorResponse } from "@/utils/http-error"

export async function handleSettingsRoutes(request: Request, pathname: string) {
  try {
    if (pathname === "/api/settings" && request.method === "GET") {
      return Response.json(getSettings())
    }

    if (pathname === "/api/settings" && request.method === "PUT") {
      const previousSettings = getSettingsWithSensitiveValues().settings
      const requestBody = await request.json().catch(() => null)
      const input = updateSettingsInputSchema.parse(requestBody)
      const settings = updateSettings(input)
      const reconcileSummary = await reconcileManagedWorkspaceRuntimeAfterSettingsChange(
        previousSettings,
        settings
      )
      const daemonSettingsChanged = haveDaemonSettingsChanged(previousSettings, settings)
      const daemonRestartScheduled = daemonSettingsChanged ? scheduleDaemonRestart() : false
      return Response.json({
        settings,
        reconcileSummary: {
          ...reconcileSummary,
          daemonSettingsChanged,
          daemonRestartScheduled,
        },
      })
    }

    if (pathname === "/api/settings/reset" && request.method === "POST") {
      const previousSettings = getSettingsWithSensitiveValues().settings
      const settings = resetSettings()
      const reconcileSummary = await reconcileManagedWorkspaceRuntimeAfterSettingsChange(
        previousSettings,
        settings
      )
      const daemonSettingsChanged = haveDaemonSettingsChanged(previousSettings, settings)
      const daemonRestartScheduled = daemonSettingsChanged ? scheduleDaemonRestart() : false
      return Response.json({
        settings,
        reconcileSummary: {
          ...reconcileSummary,
          daemonSettingsChanged,
          daemonRestartScheduled,
        },
      })
    }

    if (pathname === "/api/settings/factory-reset" && request.method === "POST") {
      return Response.json(await factoryResetAppState())
    }

    if (pathname === "/api/onboarding-status" && request.method === "GET") {
      return Response.json(getOnboardingStatus())
    }

    if (pathname === "/api/onboarding-status/complete" && request.method === "POST") {
      return Response.json(completeOnboarding())
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
