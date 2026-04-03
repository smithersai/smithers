import type { RunStatus, StartRunInput } from "@burns/shared"

import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useStartRun } from "@/features/runs/hooks/use-start-run"
import { useRuns } from "@/features/runs/hooks/use-runs"
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

export function WorkspaceRunsPage() {
  const navigate = useNavigate()
  const { workspaceId } = useActiveWorkspace()
  const { data: workflows = [] } = useWorkflows(workspaceId)
  const { data: runs = [], isLoading } = useRuns(workspaceId)
  const startRun = useStartRun(workspaceId)

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("")
  const [inferredInputValues, setInferredInputValues] = useState<Record<string, string>>({})
  const [runInputRaw, setRunInputRaw] = useState<string>("{}")
  const [runFilter, setRunFilter] = useState<RunFilter>("all")

  const selectedWorkflow = useMemo(() => {
    if (selectedWorkflowId) {
      return workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null
    }

    return workflows[0] ?? null
  }, [selectedWorkflowId, workflows])

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

  const runInputState = useMemo(() => safeParseRunInput(runInputRaw), [runInputRaw])

  const filteredRuns = useMemo(() => {
    if (runFilter === "all") {
      return runs
    }

    return runs.filter((run) => run.status === runFilter)
  }, [runFilter, runs])

  const runCountsByStatus = {
    running: runs.filter((run) => run.status === "running").length,
    waitingApproval: runs.filter((run) => run.status === "waiting-approval").length,
    finished: runs.filter((run) => run.status === "finished").length,
    failed: runs.filter((run) => run.status === "failed").length,
  }

  const launchRun = () => {
    if (!selectedWorkflow || launchFieldsQuery.isLoading) {
      return
    }

    const inputPayload: Record<string, unknown> = isInferredMode
      ? Object.fromEntries(
          inferredFields.map((field) => [field.key, inferredInputValues[field.key] ?? ""])
        )
      : runInputState.payload

    if (!isInferredMode && runInputState.error) {
      return
    }

    const input: StartRunInput = {
      workflowId: selectedWorkflow.id,
      input: inputPayload,
    }

    startRun.mutate(input, {
      onSuccess: (run) => {
        navigate(`/w/${workspaceId}/runs/${run.id}`)
      },
    })
  }

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6">
        <div className="grid gap-4 xl:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle>Running</CardTitle>
              <CardDescription>{runCountsByStatus.running}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Waiting approval</CardTitle>
              <CardDescription>{runCountsByStatus.waitingApproval}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Finished</CardTitle>
              <CardDescription>{runCountsByStatus.finished}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Failed</CardTitle>
              <CardDescription>{runCountsByStatus.failed}</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Launch run</CardTitle>
              <CardDescription>Start a run with inferred inputs when available.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflows available for this workspace.</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground">Workflow</p>
                    <Select
                      value={selectedWorkflow?.id ?? ""}
                      onValueChange={(value) => setSelectedWorkflowId(value ?? "")}
                    >
                      <SelectTrigger className="w-full">
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
                  {selectedWorkflow ? (
                    <p className="text-xs text-muted-foreground">{selectedWorkflow.relativePath}</p>
                  ) : null}
                </div>

                {launchFieldsQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">Detecting launch inputs...</p>
                ) : isInferredMode ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">Inferred launch inputs</p>
                    {inferredFields.map((field) => (
                      <div key={field.key} className="flex flex-col gap-1">
                        <p className="text-xs text-muted-foreground">{field.label}</p>
                        <Input
                          value={inferredInputValues[field.key] ?? ""}
                          onChange={(event) => {
                            const nextValue = event.target.value
                            setInferredInputValues((current) => ({
                              ...current,
                              [field.key]: nextValue,
                            }))
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                      {fallbackNotice ?? "Unable to determine inputs automatically."}
                    </p>
                    <div className="flex flex-col gap-1">
                      <p className="text-xs text-muted-foreground">Run input JSON object</p>
                      <Textarea
                        value={runInputRaw}
                        className="min-h-40 font-mono text-xs"
                        onChange={(event) => setRunInputRaw(event.target.value)}
                      />
                      {runInputState.error ? (
                        <p className="text-sm text-destructive">{runInputState.error}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Input is valid JSON object.</p>
                      )}
                    </div>
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

          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Filter by status and open run details.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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

              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading runs...</p>
              ) : filteredRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs found for selected filter.</p>
              ) : (
                filteredRuns.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className="flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted"
                    onClick={() => navigate(`/w/${workspaceId}/runs/${run.id}`)}
                  >
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">
                        {run.id} - {run.workflowName}
                      </p>
                      <p className="text-sm text-muted-foreground">started {formatTimestamp(run.startedAt)}</p>
                    </div>
                    <Badge variant={getStatusBadgeVariant(run.status)}>{run.status}</Badge>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
