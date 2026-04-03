import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  useWorkspaceActivity,
  type WorkspaceActivityItem,
} from "@/features/workspace/hooks/use-workspace-activity"
import { formatTimestamp } from "@/features/workspace/lib/format"

type ActivityFeedCardProps = {
  workspaceId?: string
  title?: string
  description?: string
  emptyMessage?: string
  limit?: number
}

function getEventTone(eventType: string) {
  const normalized = eventType.toLowerCase()

  if (normalized.includes("error") || normalized.includes("failed") || normalized.includes("denied")) {
    return "destructive" as const
  }

  if (normalized.includes("approval") || normalized.includes("wait")) {
    return "outline" as const
  }

  return "secondary" as const
}

function ActivityFeedRow({ item, workspaceId }: { item: WorkspaceActivityItem; workspaceId?: string }) {
  const navigate = useNavigate()

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{item.workflowName}</p>
          <p className="text-xs text-muted-foreground">{item.runId}</p>
        </div>
        <Badge variant={getEventTone(item.type)}>{item.type}</Badge>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</p>
      {item.message ? <p className="mt-1 text-sm">{item.message}</p> : null}
      {item.nodeId ? <p className="text-xs text-muted-foreground">node {item.nodeId}</p> : null}

      {workspaceId ? (
        <div className="mt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/w/${workspaceId}/runs/${item.runId}`)}
          >
            Open run
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function ActivityFeedCard({
  workspaceId,
  title = "Recent activity",
  description = "Latest events from recent workspace runs.",
  emptyMessage = "No recent run activity.",
  limit = 10,
}: ActivityFeedCardProps) {
  const activityQuery = useWorkspaceActivity(workspaceId, limit)
  const items = activityQuery.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex max-h-[30rem] flex-col gap-2 overflow-auto">
        {activityQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading activity...</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          items.map((item) => (
            <ActivityFeedRow key={item.id} item={item} workspaceId={workspaceId} />
          ))
        )}
      </CardContent>
    </Card>
  )
}
