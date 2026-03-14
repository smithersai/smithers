import type { ReactNode } from "react"
import type { Workspace } from "@burns/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useDaemonHealth } from "@/features/workspace/hooks/use-daemon-health"
import {
  useWorkspaceServerActions,
  useWorkspaceServerStatus,
} from "@/features/workspace/hooks/use-workspace-server"
import { formatTimestamp } from "@/features/workspace/lib/format"

function getHealthBadgeVariant(status: Workspace["healthStatus"]) {
  if (status === "healthy") {
    return "secondary"
  }

  if (status === "degraded") {
    return "outline"
  }

  if (status === "disconnected") {
    return "destructive"
  }

  return "outline"
}

function getHealthBadgeClassName(status: Workspace["healthStatus"]) {
  if (status === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700"
  }

  if (status === "degraded") {
    return "border-amber-200 bg-amber-50 text-amber-700"
  }

  if (status === "disconnected") {
    return "border-red-200 bg-red-50 text-red-700"
  }

  return "border-slate-200 bg-slate-50 text-slate-700"
}

function getDaemonBadgeClassName(isOnline: boolean) {
  return isOnline
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-red-200 bg-red-50 text-red-700"
}

type ServerHealthCardProps = {
  workspace: Workspace | null
  workspaceId?: string
  title?: string
  description?: string
  showControls?: boolean
}

type HealthListItemProps = {
  label: string
  children: ReactNode
}

function HealthListItem({ label, children }: HealthListItemProps) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-2">
      <dt className="shrink-0 text-sm font-medium text-foreground">{label}:</dt>
      <dd className="min-w-0 text-sm text-muted-foreground">{children}</dd>
    </div>
  )
}

export function ServerHealthCard({
  workspace,
  workspaceId,
  title = "Server health",
  description = "Workspace runtime and daemon health status.",
  showControls = false,
}: ServerHealthCardProps) {
  const resolvedWorkspaceId = workspaceId ?? workspace?.id
  const daemonHealth = useDaemonHealth()
  const workspaceServerStatus = useWorkspaceServerStatus(resolvedWorkspaceId)
  const workspaceServerActions = useWorkspaceServerActions(resolvedWorkspaceId)
  const daemonOnline = Boolean(daemonHealth.data?.ok) && !daemonHealth.isError
  const serverStatus = workspaceServerStatus.data
  const workspaceHealthStatus = workspace?.healthStatus ?? "unknown"
  const runtimeMode = serverStatus?.runtimeMode ?? workspace?.runtimeMode ?? "burns-managed"
  const isSelfManaged = runtimeMode === "self-managed"
  const actionDisabled =
    !resolvedWorkspaceId ||
    isSelfManaged ||
    workspaceServerActions.start.isPending ||
    workspaceServerActions.restart.isPending ||
    workspaceServerActions.stop.isPending

  const serverActionError =
    workspaceServerActions.start.error ??
    workspaceServerActions.restart.error ??
    workspaceServerActions.stop.error

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Badge
              variant={getHealthBadgeVariant(workspaceHealthStatus)}
              className={getHealthBadgeClassName(workspaceHealthStatus)}
            >
              {workspaceHealthStatus}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <dl className="divide-y">
          <HealthListItem label="Daemon status">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={daemonOnline ? "secondary" : "destructive"}
                className={getDaemonBadgeClassName(daemonOnline)}
              >
                {daemonOnline ? "online" : "unreachable"}
              </Badge>
              <span>{daemonHealth.data?.service ?? "burns daemon"}</span>
            </div>
          </HealthListItem>

          <HealthListItem label="Runtime mode">
            <Badge
              variant="outline"
              className={
                isSelfManaged
                  ? "border-violet-200 bg-violet-50 text-violet-700"
                  : "border-sky-200 bg-sky-50 text-sky-700"
              }
            >
              {runtimeMode}
            </Badge>
          </HealthListItem>

          <HealthListItem label="Last heartbeat">
            <span className="font-medium text-foreground">{formatTimestamp(serverStatus?.lastHeartbeatAt)}</span>
          </HealthListItem>

          <HealthListItem label="Restart / crash count">
            <span className="font-medium text-foreground">
              {(serverStatus?.restartCount ?? 0).toString()} / {(serverStatus?.crashCount ?? 0).toString()}
            </span>
          </HealthListItem>

          <HealthListItem label="Smithers endpoint">
            <span className="block truncate font-medium text-foreground">
              {serverStatus?.baseUrl ?? workspace?.smithersBaseUrl ?? "workspace-managed"}
            </span>
          </HealthListItem>

          {showControls ? (
            <HealthListItem label="Server controls">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => workspaceServerActions.start.mutate()}
                >
                  Start
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => workspaceServerActions.restart.mutate()}
                >
                  Restart
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => workspaceServerActions.stop.mutate()}
                >
                  Stop
                </Button>
              </div>
              {isSelfManaged ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Controls are disabled for self-managed workspaces.
                </p>
              ) : null}
              {serverActionError ? (
                <p className="mt-2 text-sm text-destructive">{serverActionError.message}</p>
              ) : null}
            </HealthListItem>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  )
}
