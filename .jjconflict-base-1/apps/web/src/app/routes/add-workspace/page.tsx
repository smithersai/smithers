import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"

import type { Combobox11Option } from "@/components/shadcn-studio/combobox/combobox-11"
import { Combobox11 } from "@/components/shadcn-studio/combobox/combobox-11"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useSettings } from "@/features/settings/hooks/use-settings"
import { ChoiceCardScreen } from "@/features/workspaces/add-workspace/components/choice-card-screen"
import {
  BrowserFolderPickerField,
  DaemonFolderPickerField,
} from "@/features/workspaces/add-workspace/components/folder-picker-field"
import {
  type ManagedWorkspaceSourceChoice,
  managedSourceChoiceOptions,
  type WizardStep,
  type WorkspaceRuntimeChoice,
  runtimeChoiceOptions,
} from "@/features/workspaces/add-workspace/lib/models"
import {
  slugifyWorkspaceName,
  validateLocalPath,
  validateRepositoryUrl,
  validateSmithersUrl,
  validateTargetFolder,
  validateWorkspaceName,
} from "@/features/workspaces/add-workspace/lib/validation"
import { useCreateWorkspace } from "@/features/workspaces/hooks/use-create-workspace"
import { useDiscoverLocalWorkflows } from "@/features/workspaces/hooks/use-discover-local-workflows"
import { burnsClient, isLocalhostBurnsApiUrl } from "@/lib/api/client"

const workflowTemplateOptions = [
  { value: "issue-to-pr", label: "Issue to PR" },
  { value: "pr-feedback", label: "PR feedback" },
  { value: "approval-gate", label: "Approval gate" },
] satisfies Combobox11Option[]

type FormRowProps = {
  label: string
  htmlFor?: string
  description?: ReactNode
  children: ReactNode
}

function FormRow({ label, htmlFor, description, children }: FormRowProps) {
  return (
    <div className="grid gap-3 border-b py-4 md:grid-cols-[12rem_minmax(0,1fr)] md:items-start md:gap-6">
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

export function AddWorkspacePage() {
  const navigate = useNavigate()
  const { data: settings } = useSettings()
  const createWorkspace = useCreateWorkspace()

  const isLocalDaemonUrl = isLocalhostBurnsApiUrl()

  const [step, setStep] = useState<WizardStep>("runtime-choice")
  const [runtimeChoice, setRuntimeChoice] = useState<WorkspaceRuntimeChoice | null>(null)
  const [managedSourceChoice, setManagedSourceChoice] = useState<ManagedWorkspaceSourceChoice | null>(null)

  const [name, setName] = useState("burns-web-app")
  const [repoUrl, setRepoUrl] = useState("")
  const [localPath, setLocalPath] = useState("")
  const [targetFolder, setTargetFolder] = useState("burns-web-app")
  const [smithersBaseUrl, setSmithersBaseUrl] = useState("http://localhost:7331")
  const [shouldAddTemplateWorkflows, setShouldAddTemplateWorkflows] = useState(false)
  const [selectedWorkflowTemplateIds, setSelectedWorkflowTemplateIds] = useState(
    workflowTemplateOptions.map((option) => option.value)
  )
  const [smithersValidationMessage, setSmithersValidationMessage] = useState<string | null>(null)
  const [isValidatingSmithersUrl, setIsValidatingSmithersUrl] = useState(false)

  useEffect(() => {
    if (!settings?.smithersBaseUrl) {
      return
    }

    setSmithersBaseUrl((currentValue) =>
      currentValue === "http://localhost:7331" ? settings.smithersBaseUrl : currentValue
    )
  }, [settings?.smithersBaseUrl])

  const sourceChoices = useMemo(
    () =>
      isLocalDaemonUrl
        ? managedSourceChoiceOptions
        : managedSourceChoiceOptions.filter((option) => option.value !== "local"),
    [isLocalDaemonUrl]
  )

  const isBurnsManaged = runtimeChoice === "burns-managed"
  const isSelfManaged = runtimeChoice === "self-managed"
  const selectedManagedSource = managedSourceChoice
  const deferredLocalPath = useDeferredValue(localPath.trim())

  const nameError = validateWorkspaceName(name)
  const repoUrlError = selectedManagedSource === "clone" ? validateRepositoryUrl(repoUrl) : null
  const localPathError = selectedManagedSource === "local" ? validateLocalPath(localPath) : null
  const targetFolderError =
    isBurnsManaged && selectedManagedSource !== "local" ? validateTargetFolder(targetFolder) : null
  const selfManagedUrlError = isSelfManaged ? validateSmithersUrl(smithersBaseUrl) : null

  const shouldDiscoverLocalWorkflows =
    isBurnsManaged &&
    selectedManagedSource === "local" &&
    !localPathError &&
    deferredLocalPath.length > 0
  const localWorkflowDiscovery = useDiscoverLocalWorkflows(
    shouldDiscoverLocalWorkflows ? deferredLocalPath : undefined,
    shouldDiscoverLocalWorkflows
  )
  const localWorkflowDiscoveryError =
    selectedManagedSource === "local" ? (localWorkflowDiscovery.error?.message ?? null) : null
  const finalFormError =
    nameError ||
    repoUrlError ||
    localPathError ||
    targetFolderError ||
    selfManagedUrlError ||
    localWorkflowDiscoveryError

  function getPrimaryButtonLabel() {
    if (step !== "final-config") {
      return "Confirm"
    }

    if (isValidatingSmithersUrl) {
      return "Validating..."
    }

    return createWorkspace.isPending ? "Confirming..." : "Confirm"
  }

  function canProceedCurrentStep() {
    if (step === "runtime-choice") {
      return runtimeChoice !== null
    }

    if (step === "source-choice") {
      return managedSourceChoice !== null
    }

    return (
      !finalFormError &&
      !createWorkspace.isPending &&
      !isValidatingSmithersUrl &&
      !(selectedManagedSource === "local" && localWorkflowDiscovery.isPending)
    )
  }

  function handleBack() {
    if (step === "source-choice") {
      setStep("runtime-choice")
      return
    }

    if (step === "final-config") {
      if (isBurnsManaged) {
        setStep("source-choice")
        return
      }

      setStep("runtime-choice")
    }
  }

  async function handlePickLocalRepoPath() {
    return burnsClient.openNativeFolderPicker()
  }

  async function handleFinalConfirm() {
    const trimmedName = name.trim()
    const trimmedRepoUrl = repoUrl.trim()
    const trimmedLocalPath = localPath.trim()
    const trimmedTargetFolder = targetFolder.trim()
    const trimmedSmithersBaseUrl = smithersBaseUrl.trim()
    const fallbackTargetFolder = slugifyWorkspaceName(trimmedName)

    if (!runtimeChoice) {
      return
    }

    if (runtimeChoice === "self-managed") {
      setSmithersValidationMessage(null)
      setIsValidatingSmithersUrl(true)

      try {
        const validation = await burnsClient.validateSmithersUrl(trimmedSmithersBaseUrl)
        setSmithersValidationMessage(validation.message)
        if (!validation.ok) {
          return
        }
      } finally {
        setIsValidatingSmithersUrl(false)
      }

      const workspace = await createWorkspace.mutateAsync({
        name: trimmedName,
        runtimeMode: "self-managed",
        sourceType: "create",
        smithersBaseUrl: trimmedSmithersBaseUrl,
        targetFolder: fallbackTargetFolder,
      })
      navigate(`/w/${workspace.id}/overview`)
      return
    }

    if (!selectedManagedSource) {
      return
    }

    const workspace = await createWorkspace.mutateAsync(
      selectedManagedSource === "local"
        ? {
            name: trimmedName,
            runtimeMode: "burns-managed",
            sourceType: "local",
            localPath: trimmedLocalPath,
            ...(shouldAddTemplateWorkflows
              ? { workflowTemplateIds: selectedWorkflowTemplateIds }
              : {}),
          }
        : selectedManagedSource === "clone"
          ? {
              name: trimmedName,
              runtimeMode: "burns-managed",
              sourceType: "clone",
              repoUrl: trimmedRepoUrl,
              targetFolder: trimmedTargetFolder || fallbackTargetFolder,
              ...(shouldAddTemplateWorkflows
                ? { workflowTemplateIds: selectedWorkflowTemplateIds }
                : {}),
            }
          : {
              name: trimmedName,
              runtimeMode: "burns-managed",
              sourceType: "create",
              targetFolder: trimmedTargetFolder || fallbackTargetFolder,
              ...(shouldAddTemplateWorkflows
                ? { workflowTemplateIds: selectedWorkflowTemplateIds }
                : {}),
            }
    )

    navigate(`/w/${workspace.id}/overview`)
  }

  async function handlePrimaryAction() {
    if (step === "runtime-choice") {
      if (runtimeChoice === "self-managed") {
        setManagedSourceChoice(null)
        setStep("final-config")
        return
      }

      setStep("source-choice")
      return
    }

    if (step === "source-choice") {
      setStep("final-config")
      return
    }

    await handleFinalConfirm()
  }

  return (
    <div className="flex flex-col p-6">
      <div className="mx-auto w-full max-w-4xl rounded-xl border bg-card">
        <div className="border-b px-6 py-5">
          <h1 className="text-xl font-semibold tracking-tight">
            {step === "runtime-choice"
              ? "Smithers Runtime"
              : step === "source-choice"
                ? "Repository Source"
                : "Final Configuration"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {step === "runtime-choice"
              ? "Choose who manages Smithers for this workspace."
              : step === "source-choice"
                ? "Choose how this workspace repository should be set up."
                : "Configure the workspace fields and confirm."}
          </p>
        </div>

        <div className="px-6">
          {step === "runtime-choice" ? (
            <div className="py-5">
              <ChoiceCardScreen
                value={runtimeChoice}
                onChange={(value) => {
                  setRuntimeChoice(value)
                  setSmithersValidationMessage(null)
                }}
                options={runtimeChoiceOptions}
              />
            </div>
          ) : null}

          {step === "source-choice" ? (
            <div className="py-5">
              <ChoiceCardScreen
                value={managedSourceChoice}
                onChange={setManagedSourceChoice}
                options={sourceChoices}
              />
            </div>
          ) : null}

          {step === "final-config" ? (
            <>
              <FormRow
                label="Title"
                htmlFor="workspace-name"
                description="Displayed in the workspace list."
              >
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Workspace title"
                />
                {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
              </FormRow>

              {isSelfManaged ? (
                <FormRow
                  label="Smithers URL"
                  htmlFor="smithers-base-url"
                  description="Burns will validate that the Smithers HTTP server is reachable."
                >
                  <Input
                    id="smithers-base-url"
                    value={smithersBaseUrl}
                    onChange={(event) => {
                      setSmithersBaseUrl(event.target.value)
                      setSmithersValidationMessage(null)
                    }}
                    placeholder="http://localhost:7331"
                  />
                  {selfManagedUrlError ? (
                    <p className="text-xs text-destructive">{selfManagedUrlError}</p>
                  ) : null}
                  {smithersValidationMessage && !selfManagedUrlError ? (
                    <p className="text-xs text-muted-foreground">{smithersValidationMessage}</p>
                  ) : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource === "clone" ? (
                <FormRow
                  label="Repository URL"
                  htmlFor="workspace-repo-url"
                  description="HTTPS, SSH, or git URL."
                >
                  <Input
                    id="workspace-repo-url"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/acme/burns-web-app.git"
                  />
                  {repoUrlError ? <p className="text-xs text-destructive">{repoUrlError}</p> : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource === "local" ? (
                <FormRow
                  label="Local repo path"
                  htmlFor="workspace-local-path"
                  description="Use native folder picker or paste an absolute path."
                >
                  <DaemonFolderPickerField
                    id="workspace-local-path"
                    value={localPath}
                    onChange={setLocalPath}
                    placeholder="/Users/you/code/my-repo"
                    pickerLabel="Choose"
                    onPick={handlePickLocalRepoPath}
                  />
                  {localPathError ? <p className="text-xs text-destructive">{localPathError}</p> : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource === "local" && deferredLocalPath && !localPathError ? (
                <FormRow
                  label="Existing workflows"
                  description="Burns checks .smithers/workflows in the selected repository before adding it."
                >
                  {localWorkflowDiscovery.isPending ? (
                    <p className="text-sm text-muted-foreground">Scanning repository workflows...</p>
                  ) : localWorkflowDiscovery.error ? (
                    <p className="text-sm text-destructive">{localWorkflowDiscovery.error.message}</p>
                  ) : localWorkflowDiscovery.data?.workflows.length ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">
                          {localWorkflowDiscovery.data.workflows.length} workflow
                          {localWorkflowDiscovery.data.workflows.length === 1 ? "" : "s"}
                        </Badge>
                      </div>
                      <div className="rounded-lg border">
                        {localWorkflowDiscovery.data.workflows.map((workflow) => (
                          <div
                            key={workflow.relativePath}
                            className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
                          >
                            <p className="text-sm font-medium">{workflow.name}</p>
                            <p className="text-xs text-muted-foreground">{workflow.relativePath}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No existing Burns workflows were found in this repository.
                    </p>
                  )}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource !== "local" ? (
                <FormRow
                  label="Target folder"
                  htmlFor="workspace-target-folder"
                  description={`Relative to workspace root: ${settings?.workspaceRoot ?? "Loading..."}`}
                >
                  <BrowserFolderPickerField
                    id="workspace-target-folder"
                    value={targetFolder}
                    onChange={setTargetFolder}
                    placeholder={slugifyWorkspaceName(name)}
                    pickerLabel="Choose"
                  />
                  {targetFolderError ? (
                    <p className="text-xs text-destructive">{targetFolderError}</p>
                  ) : null}
                </FormRow>
              ) : null}

              {isBurnsManaged ? (
                <FormRow
                  label="Template workflows"
                  description="Turn this on to add selected templates into .smithers/workflows."
                >
                  <label className="flex items-center gap-3 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={shouldAddTemplateWorkflows}
                      onChange={(event) => setShouldAddTemplateWorkflows(event.target.checked)}
                      className="size-4 rounded border border-input"
                    />
                    Add template workflows
                  </label>
                  {shouldAddTemplateWorkflows ? (
                    <Combobox11
                      className="max-w-full"
                      label=""
                      placeholder="Select workflow templates"
                      searchPlaceholder="Search workflow template..."
                      emptyLabel="No workflow template found."
                      options={workflowTemplateOptions}
                      selectedValues={selectedWorkflowTemplateIds}
                      onChange={setSelectedWorkflowTemplateIds}
                    />
                  ) : null}
                </FormRow>
              ) : null}
            </>
          ) : null}

          {createWorkspace.error ? (
            <div className="py-4">
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {createWorkspace.error.message}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 py-5">
            {step !== "runtime-choice" ? (
              <Button variant="outline" onClick={handleBack} disabled={createWorkspace.isPending}>
                Back
              </Button>
            ) : null}
            <Button onClick={() => void handlePrimaryAction()} disabled={!canProceedCurrentStep()}>
              {getPrimaryButtonLabel()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
