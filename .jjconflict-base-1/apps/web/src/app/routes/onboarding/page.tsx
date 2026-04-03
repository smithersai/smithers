import { type ReactNode, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"

import type { Settings } from "@burns/shared"
import burnsAvatar from "@/assets/burns.png"
import { Button } from "@/components/ui/button"
import { Onboarding01 } from "@/components/onboarding-01"
import {
  Card,
  CardContent,
  CardDescription,
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
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { useCompleteOnboarding } from "@/features/settings/hooks/use-complete-onboarding"
import { useOnboardingStatus } from "@/features/settings/hooks/use-onboarding-status"
import { useSettings } from "@/features/settings/hooks/use-settings"
import { useUpdateSettings } from "@/features/settings/hooks/use-update-settings"
import {
  buildDefaultAgentOptions,
  buildUpdateSettingsInput,
  settingsToFormValues,
  validateSettingsForm,
  type SettingsFormValues,
} from "@/features/settings/lib/form"
import { DaemonFolderPickerField } from "@/features/workspaces/add-workspace/components/folder-picker-field"
import { useWorkspaces } from "@/features/workspaces/hooks/use-workspaces"
import { burnsClient, isLocalhostBurnsApiUrl } from "@/lib/api/client"

const allowNetworkOptions = [
  { value: "false", label: "Off" },
  { value: "true", label: "On" },
] as const

type OnboardingStep = "workspace" | "agents" | "smithers"

export function OnboardingPage() {
  const navigate = useNavigate()
  const { data: workspaces = [], isLoading: isLoadingWorkspaces } = useWorkspaces()
  const { data: onboardingStatus, isLoading: isLoadingStatus } = useOnboardingStatus()
  const { data: settings, isLoading: isLoadingSettings } = useSettings()
  const { data: agentClis = [], isLoading: isLoadingAgentClis } = useAgentClis()

  if (isLoadingWorkspaces || isLoadingStatus || isLoadingSettings || !settings) {
    return <div className="p-6 text-sm text-muted-foreground">Loading onboarding…</div>
  }

  if (workspaces[0]) {
    return <Navigate to={`/w/${workspaces[0].id}/overview`} replace />
  }

  if (onboardingStatus?.completed) {
    return <Navigate to="/workspaces/new" replace />
  }

  return (
    <LoadedOnboardingPage
      key={JSON.stringify(settings)}
      settings={settings}
      agentClis={agentClis}
      isLoadingAgentClis={isLoadingAgentClis}
      navigate={navigate}
    />
  )
}

function LoadedOnboardingPage({
  settings,
  agentClis,
  isLoadingAgentClis,
  navigate,
}: {
  settings: Settings
  agentClis: ReadonlyArray<{ name: string }>
  isLoadingAgentClis: boolean
  navigate: ReturnType<typeof useNavigate>
}) {
  const updateSettings = useUpdateSettings()
  const completeOnboarding = useCompleteOnboarding()
  const [hasStarted, setHasStarted] = useState(false)
  const [step, setStep] = useState<OnboardingStep>("workspace")
  const [formValues, setFormValues] = useState<SettingsFormValues>(() => settingsToFormValues(settings))

  const isLocalDaemonUrl = isLocalhostBurnsApiUrl()
  const canUseNativeFolderPicker =
    isLocalDaemonUrl &&
    typeof navigator !== "undefined" &&
    /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform)

  const currentFormValues = formValues
  const errors = validateSettingsForm(currentFormValues)
  const defaultAgentOptions = buildDefaultAgentOptions(agentClis, currentFormValues.defaultAgent)

  function setField<TKey extends keyof SettingsFormValues>(field: TKey, value: SettingsFormValues[TKey]) {
    setFormValues((current) => (current ? { ...current, [field]: value } : current))
  }

  async function handleSaveAndContinue() {
    await updateSettings.mutateAsync(buildUpdateSettingsInput(currentFormValues))
    await completeOnboarding.mutateAsync()
    navigate("/workspaces/new", { replace: true })
  }

  async function handlePickWorkspaceRoot() {
    return burnsClient.openNativeFolderPicker()
  }

  const steps = [
    {
      id: "workspace",
      title: "Workspace",
      description: "Choose where Burns should create and manage workspace folders on this machine.",
      completed: step !== "workspace",
      content: (
        <div className="flex flex-col gap-4">
          <FieldBlock
            label="Choose workspace"
            description={
              canUseNativeFolderPicker
                ? "Choose opens the native picker and stores the full absolute path."
                : "Enter the absolute folder path Burns should use for managed workspaces."
            }
            error={errors.workspaceRoot}
          >
            {canUseNativeFolderPicker ? (
              <DaemonFolderPickerField
                id="onboarding-workspace-root"
                value={currentFormValues.workspaceRoot}
                onChange={(value) => setField("workspaceRoot", value)}
                placeholder="/Users/you/Documents/Burns"
                pickerLabel="Choose"
                onPick={handlePickWorkspaceRoot}
              />
            ) : (
              <Input
                id="onboarding-workspace-root"
                value={currentFormValues.workspaceRoot}
                onChange={(event) => setField("workspaceRoot", event.target.value)}
                placeholder="/Users/you/Documents/Burns"
                aria-invalid={Boolean(errors.workspaceRoot)}
              />
            )}
          </FieldBlock>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setHasStarted(false)}>
              Back
            </Button>
            <Button onClick={() => setStep("agents")} disabled={Boolean(errors.workspaceRoot)}>
              Continue
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "agents",
      title: "Agents",
      description: "Pick the CLI Burns should use by default when it generates or edits workflows.",
      completed: step === "smithers",
      content: (
        <div className="flex flex-col gap-4">
          <FieldBlock
            label="Choose default agent"
            description="Burns only lists supported agent CLIs that are already installed."
            error={errors.defaultAgent}
          >
            <SettingsSelect
              value={currentFormValues.defaultAgent}
              onChange={(value) => setField("defaultAgent", value)}
              options={defaultAgentOptions}
              placeholder={isLoadingAgentClis ? "Detecting installed agents..." : "Select agent"}
            />
            {agentClis.length === 0 && !isLoadingAgentClis ? (
              <p className="text-xs text-muted-foreground">
                No supported agent CLIs were detected on `PATH`. Keeping the current default.
              </p>
            ) : null}
          </FieldBlock>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep("workspace")}>
              Back
            </Button>
            <Button onClick={() => setStep("smithers")} disabled={Boolean(errors.defaultAgent)}>
              Continue
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "smithers",
      title: "Smithers Settings",
      description: "Set the default Smithers access Burns should use for Burns-managed workspaces.",
      completed: false,
      content: (
        <div className="flex flex-col gap-4">
          <FieldBlock
            label="Allow network"
            description="This lets Smithers reach the internet. Leave it off unless your workflows truly need websites or external APIs."
          >
            <SettingsSelect
              value={currentFormValues.allowNetwork}
              onChange={(value) => setField("allowNetwork", value as SettingsFormValues["allowNetwork"])}
              options={allowNetworkOptions}
            />
          </FieldBlock>

          <FieldBlock
            label="Max concurrency"
            description="How many workflow tasks Smithers may run in parallel. `4` is a good default for most local workspaces."
            error={errors.maxConcurrency}
          >
            <Input
              id="onboarding-max-concurrency"
              type="number"
              min="1"
              step="1"
              value={currentFormValues.maxConcurrency}
              onChange={(event) => setField("maxConcurrency", event.target.value)}
              aria-invalid={Boolean(errors.maxConcurrency)}
            />
          </FieldBlock>

          <div className="text-sm text-muted-foreground">
            {updateSettings.error?.message ??
              completeOnboarding.error?.message ??
              "You can change any of these later from Settings."}
          </div>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep("agents")}>
              Back
            </Button>
            <Button
              onClick={() => void handleSaveAndContinue()}
              disabled={
                updateSettings.isPending ||
                completeOnboarding.isPending ||
                Boolean(errors.maxConcurrency)
              }
            >
              {updateSettings.isPending || completeOnboarding.isPending ? "Saving..." : "Save and continue"}
            </Button>
          </div>
        </div>
      ),
    },
  ] as const

  if (!hasStarted) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-xl bg-card shadow-none ring-0">
          <CardHeader className="items-center gap-6 text-center">
            <div className="mx-auto size-60 overflow-hidden rounded-3xl bg-background">
              <img src={burnsAvatar} alt="Burns" className="h-full w-full object-cover object-top" />
            </div>
            <div className="flex flex-col gap-1">
              <CardTitle className="text-3xl">Welcome to Burns</CardTitle>
              <CardDescription className="text-base">A Smithers Manager</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6 text-center">
            <Button size="lg" onClick={() => setHasStarted(true)}>
              Setup Burns
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <Onboarding01
      title="Set up Burns"
      subtitle=""
      steps={steps}
      openStepId={step}
      onOpenStepChange={(nextStepId) => setStep(nextStepId as OnboardingStep)}
    />
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

function FieldBlock({
  label,
  description,
  error,
  children,
}: {
  label: string
  description?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
