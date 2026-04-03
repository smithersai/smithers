import { type ReactNode, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { CheckCircle2, Clock3, LoaderCircle } from "lucide-react"

import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint"
import { MessageResponse } from "@/components/ai-elements/message"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ApprovalDecisionCard } from "@/features/approvals/components/approval-decision-card"
import { useApprovals } from "@/features/approvals/hooks/use-approvals"
import { getRunApprovals } from "@/features/approvals/lib/approval-ui"
import { useRun } from "@/features/runs/hooks/use-run"
import { useRunEvents } from "@/features/runs/hooks/use-run-events"
import { type NodeRunTimelineItem, buildNodeRunTimeline } from "@/features/runs/lib/run-timeline"
import { sortNodeTimelineForRunPage } from "@/features/runs/lib/run-page-order"
import {
  extractStructuredOutputProseText,
  parseInlineCodeSegments,
  parseStructuredOutputCards,
  parseStructuredOutputJsonObjects,
} from "@/features/runs/lib/structured-output"
import { formatRelativeMinutes } from "@/features/workspace/lib/format"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

function formatTimestamp(value?: string | null) {
  if (!value) {
    return "—"
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return value
  }

  if (date.getTime() === 0) {
    return "—"
  }

  return date.toLocaleString()
}

function formatNodeStatus(status: "running" | "completed" | "failed") {
  if (status === "completed") {
    return "Completed"
  }

  if (status === "failed") {
    return "Failed"
  }

  return "Running"
}

function getNodeDisplayStatus(nodeRun: NodeRunTimelineItem, approvalStatus?: "pending" | "approved" | "denied") {
  if (approvalStatus === "pending") {
    return "Awaiting approval"
  }

  if (approvalStatus === "approved") {
    return "Approved"
  }

  if (approvalStatus === "denied") {
    return "Denied"
  }

  return formatNodeStatus(nodeRun.status)
}

function formatRunStatus(status: string) {
  return status
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

function renderInlineCodeText(value: string): ReactNode[] {
  return parseInlineCodeSegments(value).map((segment, index) =>
    segment.kind === "code" ? (
      <code
        key={`inline-code-${index}`}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
      >
        {segment.text}
      </code>
    ) : (
      <span key={`inline-text-${index}`}>{segment.text}</span>
    )
  )
}

type NodeCheckpointItem = {
  id: string
  label: string
  detail: string
}

function buildNodeCheckpointItems(
  nodeRun: NodeRunTimelineItem,
  options?: {
    startTimestamp?: string
    approvalStatus?: "pending" | "approved" | "denied"
    approvalWaitMinutes?: number
    approvalDecidedAt?: string
  }
) {
  const startItem: NodeCheckpointItem = {
    id: `${nodeRun.id}-start`,
    label: `Starting ${nodeRun.nodeId}`,
    detail: formatTimestamp(options?.startTimestamp ?? nodeRun.startedAt ?? nodeRun.finishedAt),
  }

  if (options?.approvalStatus === "pending") {
    return {
      start: startItem,
      end: {
        id: `${nodeRun.id}-approval`,
        label: `Awaiting approval for ${nodeRun.nodeId}`,
        detail: `waiting ${formatRelativeMinutes(options.approvalWaitMinutes ?? 0)}`,
      },
    }
  }

  if (options?.approvalStatus === "approved") {
    return {
      start: startItem,
      end: {
        id: `${nodeRun.id}-approved`,
        label: `Approved ${nodeRun.nodeId}`,
        detail: formatTimestamp(options.approvalDecidedAt ?? nodeRun.finishedAt),
      },
    }
  }

  if (options?.approvalStatus === "denied") {
    return {
      start: startItem,
      end: {
        id: `${nodeRun.id}-denied`,
        label: `Denied ${nodeRun.nodeId}`,
        detail: formatTimestamp(options.approvalDecidedAt ?? nodeRun.finishedAt),
      },
    }
  }

  if (nodeRun.status === "completed") {
    return {
      start: startItem,
      end: {
        id: `${nodeRun.id}-finish`,
        label: `Finished ${nodeRun.nodeId}`,
        detail: formatTimestamp(nodeRun.finishedAt),
      },
    }
  } else if (nodeRun.status === "failed") {
    return {
      start: startItem,
      end: {
        id: `${nodeRun.id}-failed`,
        label: `Failed ${nodeRun.nodeId}`,
        detail: formatTimestamp(nodeRun.finishedAt),
      },
    }
  }

  return {
    start: startItem,
    end: undefined,
  }
}

function renderCheckpoint(checkpoint: NodeCheckpointItem) {
  return (
    <div key={checkpoint.id} className="space-y-1">
      <Checkpoint>
        <CheckpointIcon />
        <CheckpointTrigger
          className="pointer-events-none h-auto px-0 text-xs font-medium text-muted-foreground hover:bg-transparent"
          tabIndex={-1}
        >
          {checkpoint.label}
        </CheckpointTrigger>
      </Checkpoint>
      <p className="pl-6 text-xs text-muted-foreground">{checkpoint.detail}</p>
    </div>
  )
}

function getNodeDisplayEndTimestamp(
  nodeRun: NodeRunTimelineItem,
  approvalDecidedAt?: string
) {
  return approvalDecidedAt ?? nodeRun.finishedAt ?? nodeRun.startedAt
}

function renderNodeOutputContent(nodeRun: NodeRunTimelineItem, outputMode: "parsed" | "raw") {
  const structuredOutputCards = parseStructuredOutputCards(nodeRun.outputText)
  const parsedObjects = parseStructuredOutputJsonObjects(nodeRun.outputText)
  const proseText = extractStructuredOutputProseText(nodeRun.outputText)
  const rawJsonOutput =
    parsedObjects.length === 0
      ? null
      : parsedObjects.length === 1
        ? JSON.stringify(parsedObjects[0], null, 2)
        : JSON.stringify(parsedObjects, null, 2)

  if (outputMode === "raw") {
    return (
      <div className="rounded-lg border bg-card px-3 py-2">
        <pre className="whitespace-pre-wrap break-words text-xs">
          {(rawJsonOutput ?? nodeRun.outputText) || "No NodeOutput text captured for this node."}
        </pre>
      </div>
    )
  }

  if (structuredOutputCards.length === 0) {
    const fallbackText = proseText || nodeRun.outputText

    if (!fallbackText) {
      return (
        <div className="rounded-lg border bg-card px-3 py-2">
          <p className="text-xs text-muted-foreground">No node output was captured for this node.</p>
        </div>
      )
    }

    return (
      <div className="rounded-lg border bg-card px-3 py-2">
        <MessageResponse className="text-sm leading-6">{fallbackText}</MessageResponse>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card px-3 py-2">
      {proseText ? <MessageResponse className="text-sm leading-6">{proseText}</MessageResponse> : null}

      <div className="rounded-lg border bg-muted/20">
        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent">
            <span>Structured data</span>
            <span className="text-xs text-muted-foreground">
              {structuredOutputCards.length} message{structuredOutputCards.length === 1 ? "" : "s"}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 border-t p-3">
            {structuredOutputCards.map((card, cardIndex) => (
              <div key={card.id} className="space-y-3">
                {structuredOutputCards.length > 1 ? (
                  <p className="text-xs font-medium text-muted-foreground">Message {cardIndex + 1}</p>
                ) : null}
                {card.sections.map((section, sectionIndex) => {
                  if (section.kind === "paragraph") {
                    return (
                      <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {section.title}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {renderInlineCodeText(section.text)}
                        </p>
                      </div>
                    )
                  }

                  if (section.kind === "bullets") {
                    return (
                      <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {section.title}
                        </p>
                        <ul className="list-disc space-y-1 pl-4 text-sm">
                          {section.items.map((item, itemIndex) => (
                            <li key={`${card.id}-${section.title}-${itemIndex}`} className="break-words">
                              {renderInlineCodeText(item)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  }

                  return (
                    <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {section.title}
                      </p>
                      <Collapsible>
                        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border px-2 py-1 text-left text-sm hover:bg-accent">
                          <span>Show files</span>
                          <span className="text-xs text-muted-foreground">{section.files.length} entries</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-2">
                          <Table className="text-xs">
                            <TableHeader>
                              <TableRow>
                                <TableHead>Path</TableHead>
                                <TableHead>Extension</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {section.files.map((file, fileIndex) => (
                                <TableRow key={`${card.id}-${section.title}-file-${fileIndex}`}>
                                  <TableCell className="whitespace-normal break-all">{file.path}</TableCell>
                                  <TableCell>{file.extension}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  )
                })}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}

export function WorkspaceRunDetailPage() {
  const { runId } = useParams()
  const { workspaceId } = useActiveWorkspace()
  const { data: run, isLoading, error } = useRun(workspaceId, runId)
  const { data: approvals = [] } = useApprovals(workspaceId)
  const isTimelineStreaming = run
    ? run.status === "running" || run.status === "waiting-approval"
    : true
  const runEventsQuery = useRunEvents(workspaceId, runId, {
    enableStream: isTimelineStreaming,
    refetchIntervalMs: isTimelineStreaming ? 5000 : false,
  })
  const events = runEventsQuery.data
  const runApprovals = useMemo(() => getRunApprovals(approvals, runId), [approvals, runId])
  const pendingRunApprovals = useMemo(
    () => runApprovals.filter((approval) => approval.status === "pending"),
    [runApprovals]
  )
  const pendingNodeIds = useMemo(
    () => pendingRunApprovals.map((approval) => approval.nodeId),
    [pendingRunApprovals]
  )
  const decidedAtByNodeId = useMemo(
    () => new Map(runApprovals.map((approval) => [approval.nodeId, approval.decidedAt])),
    [runApprovals]
  )
  const nodeTimeline = useMemo(
    () =>
      sortNodeTimelineForRunPage(buildNodeRunTimeline(events ?? []), {
        pendingNodeIds,
        decidedAtByNodeId,
      }),
    [decidedAtByNodeId, events, pendingNodeIds]
  )
  const approvalsByNodeId = useMemo(
    () => new Map(runApprovals.map((approval) => [approval.nodeId, approval])),
    [runApprovals]
  )
  const displayRunStartedAt = useMemo(() => {
    const runStartedDate = run?.startedAt ? new Date(run.startedAt) : null
    const hasValidRunStartedAt =
      runStartedDate !== null &&
      !Number.isNaN(runStartedDate.valueOf()) &&
      runStartedDate.getTime() > 0

    if (hasValidRunStartedAt) {
      return run!.startedAt
    }

    return events?.[0]?.timestamp ?? null
  }, [events, run])
  const [outputMode, setOutputMode] = useState<"parsed" | "raw">("parsed")

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div className="shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Event timeline</h2>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading run…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : run ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                  {formatRunStatus(run.status)}
                </Badge>
                {pendingRunApprovals.length > 0 ? (
                  <Badge variant="outline">
                    {pendingRunApprovals.length} approval{pendingRunApprovals.length === 1 ? "" : "s"} pending
                  </Badge>
                ) : null}
                <span>|</span>
                <span>{formatTimestamp(displayRunStartedAt)}</span>
                <span>|</span>
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3.5" />
                  {run.summary.pending}
                </span>
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3.5" />
                  {run.summary.inProgress}
                </span>
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="size-3.5" />
                  {run.summary.finished}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Run not found.</p>
            )}
          </div>
        </div>

        {pendingRunApprovals.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            <p className="font-medium">Run is paused for approval.</p>
            <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
              {pendingRunApprovals[0]?.note ??
                `Node ${pendingRunApprovals[0]?.nodeId ?? "unknown"} is waiting for an operator decision.`}
            </p>
          </div>
        ) : null}

        {runEventsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading events…</p>
        ) : nodeTimeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events received yet.</p>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col rounded-lg border">
              <div className="border-b px-3 py-2">
                <p className="font-medium">Nodes</p>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="flex flex-col gap-2">
                  {nodeTimeline.map((nodeRun) => {
                    const nodeApproval = approvalsByNodeId.get(nodeRun.nodeId)

                    return (
                      <button
                        key={nodeRun.id}
                        type="button"
                        className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => {
                          document.getElementById(`node-output-${nodeRun.id}`)?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          })
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium">{nodeRun.nodeId}</p>
                          <Badge variant={nodeApproval?.status === "pending" ? "outline" : nodeRun.status === "failed" ? "destructive" : "secondary"}>
                            {getNodeDisplayStatus(nodeRun, nodeApproval?.status)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestamp(nodeRun.startedAt ?? nodeRun.finishedAt)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          iteration {nodeRun.iteration} • attempt {nodeRun.attempt}
                        </p>
                        {nodeApproval?.status === "pending" ? (
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            waiting {formatRelativeMinutes(nodeApproval.waitMinutes)}
                          </p>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col rounded-lg border">
              <div className="border-b px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">Outputs</p>
                    <p className="text-xs text-muted-foreground">Oldest first. Pending nodes stay at the end.</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant={outputMode === "parsed" ? "secondary" : "outline"}
                      onClick={() => setOutputMode("parsed")}
                    >
                      Parsed
                    </Button>
                    <Button
                      size="xs"
                      variant={outputMode === "raw" ? "secondary" : "outline"}
                      onClick={() => setOutputMode("raw")}
                    >
                      Raw
                    </Button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <div className="space-y-6">
                  {nodeTimeline.map((nodeRun, nodeIndex) => {
                    const nodeApproval = approvalsByNodeId.get(nodeRun.nodeId)
                    const previousNodeRun = nodeIndex > 0 ? nodeTimeline[nodeIndex - 1] : undefined
                    const previousNodeApproval = previousNodeRun
                      ? approvalsByNodeId.get(previousNodeRun.nodeId)
                      : undefined
                    const displayStartTimestamp =
                      nodeApproval && previousNodeRun
                        ? getNodeDisplayEndTimestamp(previousNodeRun, previousNodeApproval?.decidedAt)
                        : nodeRun.startedAt ?? nodeRun.finishedAt
                    const checkpoints = buildNodeCheckpointItems(nodeRun, {
                      startTimestamp: displayStartTimestamp,
                      approvalStatus: nodeApproval?.status,
                      approvalWaitMinutes: nodeApproval?.waitMinutes,
                      approvalDecidedAt: nodeApproval?.decidedAt,
                    })

                    return (
                      <section
                        key={nodeRun.id}
                        id={`node-output-${nodeRun.id}`}
                        className="space-y-4"
                      >
                        {renderCheckpoint(checkpoints.start)}

                        {nodeApproval ? <ApprovalDecisionCard approval={nodeApproval} /> : null}

                        {renderNodeOutputContent(nodeRun, outputMode)}

                        {checkpoints.end ? renderCheckpoint(checkpoints.end) : null}
                      </section>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
