import type { RunEvent } from "@burns/shared"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useRuns } from "@/features/runs/hooks/use-runs"
import { burnsClient } from "@/lib/api/client"

export type WorkspaceActivityItem = {
  id: string
  runId: string
  workflowName: string
  type: string
  timestamp: string
  nodeId?: string
  message?: string
  seq?: number
}

function toTimestampValue(timestamp: string) {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export function useWorkspaceActivity(workspaceId?: string, limit = 12) {
  const runsQuery = useRuns(workspaceId)

  const recentRuns = useMemo(() => {
    const runs = runsQuery.data ?? []

    return [...runs]
      .sort((left, right) => {
        return toTimestampValue(right.startedAt) - toTimestampValue(left.startedAt)
      })
      .slice(0, 8)
  }, [runsQuery.data])

  const activityQuery = useQuery({
    queryKey: ["workspace-activity", workspaceId, recentRuns.map((run) => run.id).join(","), limit],
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    queryFn: async (): Promise<WorkspaceActivityItem[]> => {
      if (!workspaceId || recentRuns.length === 0) {
        return []
      }

      const eventsByRun = await Promise.all(
        recentRuns.map(async (run) => {
          try {
            const events = await burnsClient.listRunEvents(workspaceId, run.id)
            return { run, events }
          } catch {
            return { run, events: [] as RunEvent[] }
          }
        })
      )

      const items: WorkspaceActivityItem[] = eventsByRun.flatMap(({ run, events }) => {
        if (events.length === 0) {
          const fallbackItem: WorkspaceActivityItem = {
            id: `${run.id}-started`,
            runId: run.id,
            workflowName: run.workflowName,
            type: "run.started",
            timestamp: run.startedAt,
            message: `Run ${run.id} started for ${run.workflowName}`,
          }

          return [fallbackItem]
        }

        return events.map((event) => {
          const activityItem: WorkspaceActivityItem = {
            id: `${run.id}-${event.seq}`,
            runId: run.id,
            workflowName: run.workflowName,
            type: event.type,
            timestamp: event.timestamp,
            nodeId: event.nodeId,
            message: event.message,
            seq: event.seq,
          }

          return activityItem
        })
      })

      return items
        .sort((left, right) => {
          const timestampDiff = toTimestampValue(right.timestamp) - toTimestampValue(left.timestamp)
          if (timestampDiff !== 0) {
            return timestampDiff
          }

          return (right.seq ?? 0) - (left.seq ?? 0)
        })
        .slice(0, limit)
    },
  })

  return {
    ...activityQuery,
    runsQuery,
  }
}
