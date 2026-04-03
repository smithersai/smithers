import type { RunStatus } from "@burns/shared"

import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useRuns } from "@/features/runs/hooks/use-runs"
import { useStartRun } from "@/features/runs/hooks/use-start-run"
import { formatTimestamp } from "@/features/workspace/lib/format"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { useWorkflowLaunchFields } from "@/features/workflows/hooks/use-workflow-launch-fields"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"

type RunFilter = "all" | RunStatus

const runFilterOptions: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting-approval", label: "Waiting approval" },
  { value: "finished", label: "Finished" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
]

function getStatusBadgeVariant(status: RunStatus) {
  if (status === "failed") {
    return "destructive"
  }

  if (status === "waiting-approval") {
    return "outline"
  }

  return "secondary"
}

function safeParseRunInput(rawValue: string) {
  const trimmed = rawValue.trim()
  const fallbackPayload: Record<string, unknown> = {}

  if (!trimmed) {
    return {
      payload: fallbackPayload,
      error: null,
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        payload: fallbackPayload,
        error: "Run input must be a JSON object.",
      }
    }

    return {
      payload: parsed as Record<string, unknown>,
      error: null,
    }
  } catch {
    return {
      payload: fallbackPayload,
      error: "Run input is not valid JSON.",
    }
  }
}

function getWorkflowPathRelativeToWorkflowsFolder(relativePath: string) {
  const normalizedPath = relativePath.replaceAll("\\", "/")
  const workflowsMarker = "/workflows/"

  if (normalizedPath.startsWith("workflows/")) {
    return normalizedPath.slice("workflows/".length)
  }

  const workflowsIndex = normalizedPath.lastIndexOf(workflowsMarker)
  if (workflowsIndex === -1) {
    return normalizedPath
  }

  return normalizedPath.slice(workflowsIndex + workflowsMarker.length)
}

export function WorkspaceOverviewPage() {
  const navigate = useNavigate()
  const { workspaceId } = useActiveWorkspace()
  const { data: workflows = [] } = useWorkflows(workspaceId)
  const { data: runs = [], isLoading: isRunsLoading } = useRuns(workspaceId)
  const startRun = useStartRun(workspaceId)

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("")
  const [inferredInputValues, setInferredInputValues] = useState<Record<string, string>>({})
  const [runInputRaw, setRunInputRaw] = useState<string>("{}")
  const [runFilter, setRunFilter] = useState<RunFilter>("all")

  const selectedWorkflow = selectedWorkflowId
    ? workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null
    : workflows[0] ?? null
  const launchFieldsQuery = useWorkflowLaunchFields(workspaceId, selectedWorkflow?.id)
  const inferredFields =
    launchFieldsQuery.data?.mode === "inferred" ? launchFieldsQuery.data.fields : []
  const isInferredMode = inferredFields.length > 0
  const fallbackNotice =
    launchFieldsQuery.data?.mode === "fallback"
      ? (launchFieldsQuery.data.message ?? "Unable to determine inputs automatically.")
      : launchFieldsQuery.isError
        ? "Unable to determine inputs automatically."
        : null
  const runInputState = safeParseRunInput(runInputRaw)
  const filteredRuns =
    runFilter === "all" ? runs : runs.filter((run) => run.status === runFilter)

  const launchRun = () => {
    if (!selectedWorkflow || launchFieldsQuery.isLoading) {
      return
    }

    const input = isInferredMode
      ? Object.fromEntries(
          inferredFields.map((field) => [field.key, inferredInputValues[field.key] ?? ""])
        )
      : runInputState.payload

    if (!isInferredMode && runInputState.error) {
      return
    }

    startRun.mutate(
      {
        workflowId: selectedWorkflow.id,
        input,
      },
      {
        onSuccess: (run) => navigate(`/w/${workspaceId}/runs/${run.id}`),
      }
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
      <div className="grid min-h-0 flex-1 gap-4 p-6 lg:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-4">
          <Card size="sm" className="shrink-0">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <CardTitle>Launch run</CardTitle>
                {fallbackNotice && !launchFieldsQuery.isLoading && !isInferredMode ? (
                  <p className="max-w-64 text-right text-xs text-muted-foreground">{fallbackNotice}</p>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflows available for this workspace.</p>
              ) : (
                <>
                  <Select
                    value={selectedWorkflow?.id ?? ""}
                    onValueChange={(value) => setSelectedWorkflowId(value ?? "")}
                  >
                    <SelectTrigger className="w-full" aria-label="Workflow">
                      <SelectValue placeholder="Select workflow" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {workflows.map((workflow) => (
                          <SelectItem key={workflow.id} value={workflow.id}>
                            {workflow.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>

                  {launchFieldsQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">Detecting launch inputs...</p>
                  ) : isInferredMode ? (
                    <div className="flex flex-col gap-2">
                      {inferredFields.map((field) => (
                        <Input
                          key={field.key}
                          aria-label={field.label}
                          placeholder={field.label}
                          value={inferredInputValues[field.key] ?? ""}
                          onChange={(event) => {
                            const nextValue = event.target.value
                            setInferredInputValues((current) => ({
                              ...current,
                              [field.key]: nextValue,
                            }))
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        aria-label="Run input JSON object"
                        className="min-h-24 font-mono text-xs"
                        placeholder='{"key":"value"}'
                        value={runInputRaw}
                        onChange={(event) => setRunInputRaw(event.target.value)}
                      />
                      {runInputState.error ? (
                        <p className="text-sm text-destructive">{runInputState.error}</p>
                      ) : null}
                    </div>
                  )}

                  <Button
                    disabled={
                      startRun.isPending ||
                      !selectedWorkflow ||
                      launchFieldsQuery.isLoading ||
                      (!isInferredMode && Boolean(runInputState.error))
                    }
                    onClick={launchRun}
                  >
                    {startRun.isPending ? "Starting run..." : "Start run"}
                  </Button>
                </>
              )}

              {startRun.error ? (
                <p className="text-sm text-destructive">{startRun.error.message}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="min-h-0 flex-1 overflow-hidden">
            <CardHeader>
              <CardTitle>Workflows</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 overflow-y-auto pr-1">
              {workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflows found for this workspace.</p>
              ) : (
                <div className="grid gap-2">
                  {workflows.map((workflow) => (
                    <button
                      key={workflow.id}
                      type="button"
                      onClick={() => navigate(`/w/${workspaceId}/workflows/${workflow.id}`)}
                      className="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-medium">{workflow.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {getWorkflowPathRelativeToWorkflowsFolder(workflow.relativePath)}
                        </p>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">Updated {formatTimestamp(workflow.updatedAt)}</p>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-0 lg:h-full">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {runFilterOptions.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={runFilter === option.value ? "default" : "outline"}
                  onClick={() => setRunFilter(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            {isRunsLoading ? (
              <p className="text-sm text-muted-foreground">Loading runs...</p>
            ) : filteredRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs found for selected filter.</p>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                {filteredRuns.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className="flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted"
                    onClick={() => navigate(`/w/${workspaceId}/runs/${run.id}`)}
                  >
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">
                        {run.workflowName} - {run.id}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        started {formatTimestamp(run.startedAt)}
                      </p>
                    </div>
                    <Badge variant={getStatusBadgeVariant(run.status)}>{run.status}</Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
