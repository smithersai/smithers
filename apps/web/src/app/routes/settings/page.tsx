import { useEffect, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SettingsMutationResult } from "@burns/shared"
import { useFactoryReset } from "@/features/settings/hooks/use-factory-reset"
import { useResetSettings } from "@/features/settings/hooks/use-reset-settings"
import { useSettings } from "@/features/settings/hooks/use-settings"
import { useUpdateSettings } from "@/features/settings/hooks/use-update-settings"
import {
  buildDefaultAgentOptions,
  buildUpdateSettingsInput,
  settingsToFormValues,
  validateSettingsForm,
  type SettingsFormValues,
} from "@/features/settings/lib/form"
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { setActiveWorkspaceId } from "@/features/workspaces/lib/active-workspace-store"
import { DaemonFolderPickerField } from "@/features/workspaces/add-workspace/components/folder-picker-field"
import { burnsClient, isLocalhostBurnsApiUrl } from "@/lib/api/client"

type FormRowProps = {
  label: string
  htmlFor?: string
  description?: ReactNode
  children: ReactNode
}

const booleanOptions = [
  { value: "false", label: "Disabled" },
  { value: "true", label: "Enabled" },
] as const

const rootDirOptions = [
  { value: "workspace-root", label: "Workspace root" },
  { value: "process-default", label: "Process default" },
] as const

const smithersAuthModeOptions = [
  { value: "bearer", label: "Authorization: Bearer" },
  { value: "x-smithers-key", label: "x-smithers-key" },
] as const

const diagnosticsLogLevelOptions = [
  { value: "trace", label: "Trace" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
  { value: "silent", label: "Silent" },
] as const

function FormRow({ label, htmlFor, description, children }: FormRowProps) {
  return (
    <div className="grid gap-3 border-b py-4 md:grid-cols-[14rem_minmax(0,1fr)] md:items-start md:gap-6">
      <div className="space-y-1">
        <FieldLabel htmlFor={htmlFor} className="text-sm md:pt-2">
          {label}
        </FieldLabel>
      </div>
      <div className="space-y-1.5">
        {children}
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}

function SettingsSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
}) {
  return (
    <Select value={value} onValueChange={(nextValue) => onChange(nextValue ?? "")}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function formatSettingsSaveMessage(action: "saved" | "reset", result: SettingsMutationResult) {
  const baseMessage = action === "saved" ? "Settings saved." : "Defaults restored."
  const { reconcileSummary } = result
  const daemonRestartMessage = reconcileSummary.daemonRestartScheduled
    ? " Burns daemon restart scheduled to apply logging changes."
    : reconcileSummary.daemonSettingsChanged
      ? " Restart Burns daemon to apply logging changes."
      : ""

  if (!reconcileSummary.managedRuntimeSettingsChanged) {
    return `${baseMessage}${daemonRestartMessage}`
  }

  if (reconcileSummary.stoppedManagedWorkspaces > 0) {
    const suffix = reconcileSummary.stoppedManagedWorkspaces === 1 ? "" : "s"
    return `${baseMessage} Stopped ${reconcileSummary.stoppedManagedWorkspaces} managed Smithers runtime${suffix}.${daemonRestartMessage}`
  }

  if (reconcileSummary.restartedManagedWorkspaces > 0) {
    const suffix = reconcileSummary.restartedManagedWorkspaces === 1 ? "" : "s"
    return `${baseMessage} Restarted ${reconcileSummary.restartedManagedWorkspaces} managed Smithers runtime${suffix}.${daemonRestartMessage}`
  }

  return `${baseMessage} Managed Smithers runtime settings changed, but no running managed runtimes needed reconciliation.${daemonRestartMessage}`
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { data: settings, isLoading } = useSettings()
  const { data: agentClis = [], isLoading: isLoadingAgentClis } = useAgentClis()
  const updateSettings = useUpdateSettings()
  const resetSettings = useResetSettings()
  const factoryReset = useFactoryReset()
  const [formValues, setFormValues] = useState<SettingsFormValues | null>(null)
  const [clearSmithersAuthToken, setClearSmithersAuthToken] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const isLocalDaemonUrl = isLocalhostBurnsApiUrl()

  useEffect(() => {
    if (!settings) {
      return
    }

    setFormValues(settingsToFormValues(settings))
    setClearSmithersAuthToken(false)
  }, [settings])

  if (isLoading || !formValues) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings…</div>
  }

  const currentFormValues = formValues
  const currentSettings = settings
  if (!currentSettings) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings…</div>
  }

  const errors = validateSettingsForm(currentFormValues)
  const defaultAgentOptions = buildDefaultAgentOptions(agentClis, currentFormValues.defaultAgent)

  function setField<TKey extends keyof SettingsFormValues>(field: TKey, value: SettingsFormValues[TKey]) {
    setFormValues((current) => (current ? { ...current, [field]: value } : current))
    setSaveMessage(null)
  }

  async function handlePickWorkspaceRoot() {
    return burnsClient.openNativeFolderPicker()
  }

  async function handleSave() {
    const nextErrors = validateSettingsForm(currentFormValues)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    const updatedSettings = await updateSettings.mutateAsync(
      buildUpdateSettingsInput(currentFormValues, { clearSmithersAuthToken })
    )

    setFormValues(settingsToFormValues(updatedSettings.settings))
    setSaveMessage(formatSettingsSaveMessage("saved", updatedSettings))
    setClearSmithersAuthToken(false)
  }

  async function handleReset() {
    const resetResult = await resetSettings.mutateAsync()
    setFormValues(settingsToFormValues(resetResult.settings))
    setClearSmithersAuthToken(false)
    setSaveMessage(formatSettingsSaveMessage("reset", resetResult))
  }

  async function handleFactoryReset() {
    await factoryReset.mutateAsync()
    setActiveWorkspaceId(null)
    navigate("/onboarding", { replace: true })
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Default paths and runtime behavior for new Burns workspaces.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormRow
              label="Workspace root"
              htmlFor="settings-workspace-root"
              description="Used as the parent folder for managed create and clone flows."
            >
              {isLocalDaemonUrl ? (
                <DaemonFolderPickerField
                  id="settings-workspace-root"
                  value={currentFormValues.workspaceRoot}
                  onChange={(value) => setField("workspaceRoot", value)}
                  placeholder="/Users/you/Documents/Burns"
                  pickerLabel="Choose"
                  onPick={handlePickWorkspaceRoot}
                />
              ) : (
                <Input
                  id="settings-workspace-root"
                  value={currentFormValues.workspaceRoot}
                  onChange={(event) => setField("workspaceRoot", event.target.value)}
                  placeholder="/Users/you/Documents/Burns"
                />
              )}
              {errors.workspaceRoot ? <p className="text-xs text-destructive">{errors.workspaceRoot}</p> : null}
            </FormRow>

            <FormRow
              label="Default agent"
              htmlFor="settings-default-agent"
              description="Applied to new workspace records unless overridden. Options come from installed agent CLIs."
            >
              <SettingsSelect
                value={currentFormValues.defaultAgent}
                onChange={(value) => setField("defaultAgent", value)}
                options={defaultAgentOptions}
                placeholder={isLoadingAgentClis ? "Detecting installed agents..." : "Select agent"}
              />
              {agentClis.length === 0 && !isLoadingAgentClis ? (
                <p className="text-xs text-muted-foreground">
                  No supported agent CLIs detected on `PATH`. Keeping the current default value.
                </p>
              ) : null}
              {errors.defaultAgent ? <p className="text-xs text-destructive">{errors.defaultAgent}</p> : null}
            </FormRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <CardDescription>Defaults Burns uses when it launches or connects to Smithers.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormRow
              label="Default Smithers URL"
              htmlFor="settings-smithers-base-url"
              description="Used as the default base URL when you create self-managed workspaces."
            >
              <Input
                id="settings-smithers-base-url"
                value={currentFormValues.smithersBaseUrl}
                onChange={(event) => setField("smithersBaseUrl", event.target.value)}
                placeholder="http://localhost:7331"
              />
              {errors.smithersBaseUrl ? <p className="text-xs text-destructive">{errors.smithersBaseUrl}</p> : null}
            </FormRow>

            <FormRow
              label="Managed Smithers"
              description="When enabled, Burns supervises one Smithers HTTP server per managed workspace and reconciles running managed runtimes automatically when needed."
            >
              <SettingsSelect
                value={currentFormValues.smithersManagedPerWorkspace}
                onChange={(value) =>
                  setField("smithersManagedPerWorkspace", value as SettingsFormValues["smithersManagedPerWorkspace"])
                }
                options={booleanOptions}
              />
            </FormRow>

            <FormRow
              label="Allow network"
              description="Applied to Burns-managed Smithers instances. Saving restarts running managed runtimes when this changes."
            >
              <SettingsSelect
                value={currentFormValues.allowNetwork}
                onChange={(value) => setField("allowNetwork", value as SettingsFormValues["allowNetwork"])}
                options={booleanOptions}
              />
            </FormRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Advanced</CardTitle>
            <CardDescription>Security, execution scope, and diagnostics preferences.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormRow
              label="Smithers auth header"
              description="Used when Burns talks to Smithers and an auth token is configured."
            >
              <SettingsSelect
                value={currentFormValues.smithersAuthMode}
                onChange={(value) => setField("smithersAuthMode", value as SettingsFormValues["smithersAuthMode"])}
                options={smithersAuthModeOptions}
              />
            </FormRow>

            <FormRow
              label="Smithers auth token"
              htmlFor="settings-smithers-auth-token"
              description={
                currentSettings.hasSmithersAuthToken
                  ? "A token is already stored. Enter a new value to replace it, or clear it below."
                  : "Optional secret. Burns never shows the saved token value back in the UI."
              }
            >
              <Input
                id="settings-smithers-auth-token"
                type="password"
                value={currentFormValues.smithersAuthToken}
                onChange={(event) => {
                  setField("smithersAuthToken", event.target.value)
                  setClearSmithersAuthToken(false)
                }}
                placeholder={currentSettings.hasSmithersAuthToken ? "Stored token present" : "Paste token"}
              />
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  Stored token: {currentSettings.hasSmithersAuthToken && !clearSmithersAuthToken ? "present" : "none"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setField("smithersAuthToken", "")
                    setClearSmithersAuthToken(true)
                    setSaveMessage(null)
                  }}
                >
                  Clear saved token
                </Button>
              </div>
            </FormRow>

            <FormRow
              label="rootDir policy"
              description="`Workspace root` keeps Burns-managed Smithers scoped to the current workspace. Saving restarts running managed runtimes when this changes."
            >
              <SettingsSelect
                value={currentFormValues.rootDirPolicy}
                onChange={(value) => setField("rootDirPolicy", value as SettingsFormValues["rootDirPolicy"])}
                options={rootDirOptions}
              />
            </FormRow>

            <FormRow
              label="Diagnostics log level"
              description="Applied on daemon startup. Restart the daemon after changing logging preferences."
            >
              <SettingsSelect
                value={currentFormValues.diagnosticsLogLevel}
                onChange={(value) =>
                  setField("diagnosticsLogLevel", value as SettingsFormValues["diagnosticsLogLevel"])
                }
                options={diagnosticsLogLevelOptions}
              />
            </FormRow>

            <FormRow
              label="Pretty logs"
              description="Enable human-readable daemon logs instead of structured JSON."
            >
              <SettingsSelect
                value={currentFormValues.diagnosticsPrettyLogs}
                onChange={(value) =>
                  setField("diagnosticsPrettyLogs", value as SettingsFormValues["diagnosticsPrettyLogs"])
                }
                options={booleanOptions}
              />
            </FormRow>
          </CardContent>
          <CardFooter className="justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {updateSettings.error?.message ??
                factoryReset.error?.message ??
                resetSettings.error?.message ??
                saveMessage ??
                "Reset restores defaults. Factory Reset forgets all Burns workspaces and returns to onboarding without deleting repo folders."}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void handleReset()} disabled={resetSettings.isPending}>
                {resetSettings.isPending ? "Resetting..." : "Reset to defaults"}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleFactoryReset()}
                disabled={factoryReset.isPending}
              >
                {factoryReset.isPending ? "Resetting..." : "Factory Reset"}
              </Button>
              <Button onClick={() => void handleSave()} disabled={updateSettings.isPending}>
                {updateSettings.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
