import {
  type AgentCli,
  agentCliSchema,
  type Approval,
  type ApprovalDecisionInput,
  approvalSchema,
  type CancelRunInput,
  type CreateWorkspaceInput,
  type DeleteWorkspaceInput,
  type DeleteWorkspaceResult,
  deleteWorkspaceResultSchema,
  type EditWorkflowInput,
  type GenerateWorkflowInput,
  type Run,
  type RunEvent,
  runEventSchema,
  runSchema,
  type ResumeRunInput,
  type Settings,
  type SettingsMutationResult,
  type StartRunInput,
  settingsSchema,
  settingsMutationResultSchema,
  type UpdateSettingsInput,
  updateSettingsInputSchema,
  type OnboardingStatus,
  onboardingStatusSchema,
  type FactoryResetResult,
  factoryResetResultSchema,
  type UpdateWorkflowInput,
  type Workflow,
  type WorkflowFileDocument,
  type WorkflowFileList,
  type WorkflowAuthoringStreamEvent,
  type WorkflowDocument,
  type WorkflowLaunchFieldsResponse,
  workflowAuthoringStreamEventSchema,
  workflowFileDocumentSchema,
  workflowFileListSchema,
  workflowDocumentSchema,
  workflowLaunchFieldsResponseSchema,
  workflowSchema,
  burnsRuntimeContextSchema,
  type Workspace,
  type WorkspaceSmithersRuntimeConfig,
  type WorkspaceServerStatus,
  workspaceSmithersRuntimeConfigSchema,
  workspaceServerStatusSchema,
  workspaceSchema,
} from "@burns/shared"
import { z } from "zod"

const workspaceListSchema = z.array(workspaceSchema)
const workspaceServerStatusDtoSchema = workspaceServerStatusSchema
const deleteWorkspaceResultDtoSchema = deleteWorkspaceResultSchema
const workflowListSchema = z.array(workflowSchema)
const workflowDocumentListSchema = workflowDocumentSchema
const workflowFileListDtoSchema = workflowFileListSchema
const workflowFileDocumentDtoSchema = workflowFileDocumentSchema
const workflowLaunchFieldsDtoSchema = workflowLaunchFieldsResponseSchema
const agentCliListSchema = z.array(agentCliSchema)
const runListSchema = z.array(runSchema)
const runEventListSchema = z.array(runEventSchema)
const approvalListSchema = z.array(approvalSchema)
const runtimeContextSchema = burnsRuntimeContextSchema
const workflowCdCommandDtoSchema = z.object({
  command: z.string(),
})
const nativeFolderPickerResponseSchema = z.object({
  path: z.string().nullable(),
})
const validateSmithersUrlResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  message: z.string(),
})

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const objectPayload = payload as Record<string, unknown>
  const directError = objectPayload.error
  if (typeof directError === "string" && directError.trim()) {
    return directError
  }

  if (directError && typeof directError === "object") {
    const nestedMessage = (directError as Record<string, unknown>).message
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage
    }
  }

  const directMessage = objectPayload.message
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage
  }

  return null
}

export type WorkflowAuthoringStreamOptions = {
  onEvent?: (event: WorkflowAuthoringStreamEvent) => void
  signal?: AbortSignal
}

export class BurnsClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  getBaseUrl() {
    return this.baseUrl
  }

  async getHealth() {
    return this.request<{ ok: true; service: string }>("/api/health")
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.request<unknown>("/api/workspaces")
    return workspaceListSchema.parse(data)
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}`)
    return workspaceSchema.parse(data)
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const data = await this.request<unknown>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    })

    return workspaceSchema.parse(data)
  }

  async deleteWorkspace(
    workspaceId: string,
    input: DeleteWorkspaceInput
  ): Promise<DeleteWorkspaceResult> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
      body: JSON.stringify(input),
    })

    return deleteWorkspaceResultDtoSchema.parse(data)
  }

  async getWorkspaceServerStatus(workspaceId: string): Promise<WorkspaceServerStatus> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/server/status`)
    return workspaceServerStatusDtoSchema.parse(data)
  }

  async getWorkspaceSmithersRuntimeConfig(
    workspaceId: string
  ): Promise<WorkspaceSmithersRuntimeConfig> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runtime-config`)
    return workspaceSmithersRuntimeConfigSchema.parse(data)
  }

  async startWorkspaceServer(workspaceId: string): Promise<WorkspaceServerStatus> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/server/start`, {
      method: "POST",
    })
    return workspaceServerStatusDtoSchema.parse(data)
  }

  async restartWorkspaceServer(workspaceId: string): Promise<WorkspaceServerStatus> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/server/restart`, {
      method: "POST",
    })
    return workspaceServerStatusDtoSchema.parse(data)
  }

  async stopWorkspaceServer(workspaceId: string): Promise<WorkspaceServerStatus> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/server/stop`, {
      method: "POST",
    })
    return workspaceServerStatusDtoSchema.parse(data)
  }

  async getSettings(): Promise<Settings> {
    const data = await this.request<unknown>("/api/settings")
    return settingsSchema.parse(data)
  }

  async updateSettings(input: UpdateSettingsInput): Promise<SettingsMutationResult> {
    const data = await this.request<unknown>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(updateSettingsInputSchema.parse(input)),
    })

    return settingsMutationResultSchema.parse(data)
  }

  async resetSettings(): Promise<SettingsMutationResult> {
    const data = await this.request<unknown>("/api/settings/reset", {
      method: "POST",
    })

    return settingsMutationResultSchema.parse(data)
  }

  async getOnboardingStatus(): Promise<OnboardingStatus> {
    const data = await this.request<unknown>("/api/onboarding-status")
    return onboardingStatusSchema.parse(data)
  }

  async completeOnboarding(): Promise<OnboardingStatus> {
    const data = await this.request<unknown>("/api/onboarding-status/complete", {
      method: "POST",
    })
    return onboardingStatusSchema.parse(data)
  }

  async factoryReset(): Promise<FactoryResetResult> {
    const data = await this.request<unknown>("/api/settings/factory-reset", {
      method: "POST",
    })
    return factoryResetResultSchema.parse(data)
  }

  async openNativeFolderPicker(): Promise<string | null> {
    const data = await this.request<unknown>("/api/system/folder-picker", {
      method: "POST",
    })

    return nativeFolderPickerResponseSchema.parse(data).path
  }

  async openWorkflowFolder(workspaceId: string, workflowId: string) {
    await this.request(`/api/workspaces/${workspaceId}/workflows/${workflowId}/open-folder`, {
      method: "POST",
    })
  }

  async getWorkflowCdCommand(workspaceId: string, workflowId: string): Promise<string> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/cd-command`,
      {
        method: "POST",
      }
    )

    return workflowCdCommandDtoSchema.parse(data).command
  }

  async getRuntimeContext() {
    const data = await this.request<unknown>("/api/system/runtime-context")
    return runtimeContextSchema.parse(data)
  }

  async validateSmithersUrl(baseUrl: string): Promise<{
    ok: boolean
    status: number | null
    message: string
  }> {
    const data = await this.request<unknown>("/api/system/validate-smithers-url", {
      method: "POST",
      body: JSON.stringify({ baseUrl }),
    })

    return validateSmithersUrlResponseSchema.parse(data)
  }

  async listAgentClis(): Promise<AgentCli[]> {
    const data = await this.request<unknown>("/api/agents/clis")
    return agentCliListSchema.parse(data)
  }

  async listWorkflows(workspaceId: string): Promise<Workflow[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows`)
    return workflowListSchema.parse(data)
  }

  async getWorkflow(workspaceId: string, workflowId: string): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/${workflowId}`)
    return workflowDocumentListSchema.parse(data)
  }

  async listWorkflowFiles(workspaceId: string, workflowId: string): Promise<WorkflowFileList> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/files`
    )
    return workflowFileListDtoSchema.parse(data)
  }

  async getWorkflowFile(
    workspaceId: string,
    workflowId: string,
    filePath: string
  ): Promise<WorkflowFileDocument> {
    const search = new URLSearchParams({ path: filePath })
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/files/content?${search.toString()}`
    )
    return workflowFileDocumentDtoSchema.parse(data)
  }

  async getWorkflowLaunchFields(
    workspaceId: string,
    workflowId: string
  ): Promise<WorkflowLaunchFieldsResponse> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/launch-fields`
    )
    return workflowLaunchFieldsDtoSchema.parse(data)
  }

  async saveWorkflow(
    workspaceId: string,
    workflowId: string,
    source: UpdateWorkflowInput["source"]
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify({ source }),
    })

    return workflowDocumentListSchema.parse(data)
  }

  async generateWorkflow(
    workspaceId: string,
    input: GenerateWorkflowInput
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/generate`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return workflowDocumentListSchema.parse(data)
  }

  async generateWorkflowStream(
    workspaceId: string,
    input: GenerateWorkflowInput,
    options: WorkflowAuthoringStreamOptions = {}
  ): Promise<WorkflowDocument> {
    return this.requestWorkflowAuthoringStream(
      `/api/workspaces/${workspaceId}/workflows/generate/stream`,
      input,
      options
    )
  }

  async editWorkflow(
    workspaceId: string,
    workflowId: string,
    input: EditWorkflowInput
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/edit`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return workflowDocumentListSchema.parse(data)
  }

  async editWorkflowStream(
    workspaceId: string,
    workflowId: string,
    input: EditWorkflowInput,
    options: WorkflowAuthoringStreamOptions = {}
  ): Promise<WorkflowDocument> {
    return this.requestWorkflowAuthoringStream(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/edit/stream`,
      input,
      options
    )
  }

  async deleteWorkflow(workspaceId: string, workflowId: string): Promise<void> {
    await this.request(`/api/workspaces/${workspaceId}/workflows/${workflowId}`, {
      method: "DELETE",
    })
  }

  async listRuns(workspaceId: string): Promise<Run[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs`)
    return runListSchema.parse(data)
  }

  async getRun(workspaceId: string, runId: string): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}`)
    return runSchema.parse(data)
  }

  async startRun(workspaceId: string, input: StartRunInput): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async resumeRun(
    workspaceId: string,
    runId: string,
    input: ResumeRunInput = {}
  ): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}/resume`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async cancelRun(
    workspaceId: string,
    runId: string,
    input: CancelRunInput = {}
  ): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async listRunEvents(workspaceId: string, runId: string, afterSeq?: number): Promise<RunEvent[]> {
    const search = new URLSearchParams()
    if (afterSeq !== undefined) {
      search.set("afterSeq", String(afterSeq))
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : ""
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/events${suffix}`
    )

    return runEventListSchema.parse(data)
  }

  getRunEventStreamUrl(workspaceId: string, runId: string, afterSeq?: number) {
    const url = new URL(`/api/workspaces/${workspaceId}/runs/${runId}/events/stream`, this.baseUrl)
    if (afterSeq !== undefined) {
      url.searchParams.set("afterSeq", String(afterSeq))
    }

    return url
  }

  async listApprovals(workspaceId: string): Promise<Approval[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/approvals`)
    return approvalListSchema.parse(data)
  }

  async approveNode(
    workspaceId: string,
    runId: string,
    nodeId: string,
    input: ApprovalDecisionInput
  ): Promise<Approval> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}/approve`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return approvalSchema.parse(data)
  }

  async denyNode(
    workspaceId: string,
    runId: string,
    nodeId: string,
    input: ApprovalDecisionInput
  ): Promise<Approval> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}/deny`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return approvalSchema.parse(data)
  }

  private async requestWorkflowAuthoringStream(
    pathname: string,
    input: GenerateWorkflowInput | EditWorkflowInput,
    options: WorkflowAuthoringStreamOptions
  ): Promise<WorkflowDocument> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify(input),
      signal: options.signal,
    })

    if (!response.ok) {
      let message = `Burns API request failed: ${response.status}`

      try {
        const errorBody = (await response.json()) as unknown
        const parsedMessage = extractErrorMessage(errorBody)
        if (parsedMessage) {
          message = parsedMessage
        }
      } catch {
        // Ignore invalid JSON error bodies.
      }

      throw new Error(message)
    }

    if (!response.body) {
      throw new Error("Workflow authoring stream did not include a response body")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let workflowResult: WorkflowDocument | null = null

    const consumeLine = (line: string) => {
      const trimmedLine = line.trim()
      if (!trimmedLine) {
        return
      }

      const parsedPayload = JSON.parse(trimmedLine)
      const event = workflowAuthoringStreamEventSchema.parse(parsedPayload)
      options.onEvent?.(event)

      if (event.type === "error") {
        throw new Error(event.message)
      }

      if (event.type === "result") {
        workflowResult = event.workflow
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? undefined, { stream: !done })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        consumeLine(line)
      }

      if (done) {
        break
      }
    }

    if (buffer.trim()) {
      consumeLine(buffer)
    }

    if (!workflowResult) {
      throw new Error("Workflow authoring stream finished without a generated workflow")
    }

    return workflowResult
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

    if (!response.ok) {
      let message = `Burns API request failed: ${response.status}`

      try {
        const errorBody = (await response.json()) as unknown
        const parsedMessage = extractErrorMessage(errorBody)
        if (parsedMessage) {
          message = parsedMessage
        }
      } catch {
        // Ignore invalid JSON error bodies.
      }

      throw new Error(message)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }
}
