import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { NavLink } from "react-router-dom"
import { ArrowUpRightIcon } from "lucide-react"

import { burnsClient } from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { buildPendingApprovalInboxItems } from "@/features/approvals/lib/approval-ui"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function InboxPage() {
  const { workspaces, isLoading: isWorkspaceLoading } = useActiveWorkspace()
  const approvalQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ["approvals", workspace.id],
      queryFn: () => burnsClient.listApprovals(workspace.id),
      enabled: Boolean(workspace.id),
    })),
  })

  const approvalsByWorkspaceId = useMemo(
    () =>
      Object.fromEntries(workspaces.map((workspace, index) => [workspace.id, approvalQueries[index]?.data ?? []])),
    [approvalQueries, workspaces]
  )
  const inboxItems = useMemo(
    () => buildPendingApprovalInboxItems(workspaces, approvalsByWorkspaceId),
    [approvalsByWorkspaceId, workspaces]
  )
  const isLoading = isWorkspaceLoading || approvalQueries.some((query) => query.isLoading)
  const error = approvalQueries.find((query) => query.error)?.error

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Inbox</CardTitle>
            <CardDescription>Global approval notes that need operator action across all workspaces.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading inbox items...</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : inboxItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending approvals are waiting in the global inbox.</p>
            ) : (
              inboxItems.map((item) => (
                <Card
                  key={item.id}
                  className="transition-colors hover:bg-muted/50"
                >
                  <CardContent className="flex items-start justify-between gap-3 p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{item.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.workspaceName} • run {item.runId} • node {item.nodeId}
                      </p>
                      <p className="text-xs text-muted-foreground">waiting {item.waitMinutes === 0 ? "just now" : `${item.waitMinutes} min`}</p>
                      {item.note ? <p className="text-sm text-muted-foreground">{item.note}</p> : null}
                    </div>
                    <Button size="sm" variant="outline" render={<NavLink to={item.runHref} />}>
                      Open run
                      <ArrowUpRightIcon className="size-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
