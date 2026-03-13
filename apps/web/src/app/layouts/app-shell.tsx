import type { LucideIcon } from "lucide-react"
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  InboxIcon,
  LayoutDashboardIcon,
  PlayIcon,
  Settings2Icon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"

import burnsAvatar from "@/assets/burns.png"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useDeleteWorkflow } from "@/features/workflows/hooks/use-delete-workflow"
import { useCancelRun } from "@/features/runs/hooks/use-cancel-run"
import { useResumeRun } from "@/features/runs/hooks/use-resume-run"
import { useOpenWorkflowFolder } from "@/features/workflows/hooks/use-open-workflow-folder"
import { useCopyWorkflowCdCommand } from "@/features/workflows/hooks/use-copy-workflow-cd-command"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { useRuntimeContext } from "@/features/system/hooks/use-runtime-context"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

type SidebarItem = {
  label: string
  to: string
  icon: LucideIcon
  exact?: boolean
}

const globalItems: SidebarItem[] = [
  { label: "Inbox", to: "/inbox", icon: InboxIcon, exact: true },
]

const settingsItem: SidebarItem = {
  label: "Settings",
  to: "/settings",
  icon: SettingsIcon,
  exact: true,
}

function toTitleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function buildBreadcrumbs(
  pathname: string,
  options?: {
    workspaceName?: string
    workflowName?: string
  }
) {
  const workspaceName = options?.workspaceName
  const workflowName = options?.workflowName
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment))

  if (segments.length === 0) {
    return ["Home"]
  }

  if (segments[0] === "workflows") {
    const workflowCrumbs = ["Workflow"]

    if (segments[1] === "new") {
      workflowCrumbs.push("New")
      return workflowCrumbs
    }

    if (segments[1]) {
      workflowCrumbs.push(segments[1])
    }

    if (segments[2]) {
      workflowCrumbs.push(toTitleCase(segments[2]))
    }

    return workflowCrumbs
  }

  if (segments[0] === "workspaces" && segments[1] === "new") {
    return ["Workspace", "New"]
  }

  if (segments[0] === "onboarding") {
    return ["Onboarding"]
  }

  if (segments[0] === "settings") {
    return ["Settings"]
  }

  if (segments[0] === "inbox") {
    return ["Inbox"]
  }

  if (segments[0] === "w") {
    const workspaceCrumbs = [workspaceName ?? "Workspace"]

    if (segments[2]) {
      workspaceCrumbs.push(toTitleCase(segments[2]))
    }

    if (segments[2] === "workflows" && segments[3]) {
      if (segments[3] === "new") {
        workspaceCrumbs.push("New")
      } else {
        workspaceCrumbs.push(workflowName ?? segments[3])
      }
    }

    if (segments[2] === "runs" && segments[3]) {
      workspaceCrumbs.push(segments[3])
    }

    return workspaceCrumbs
  }

  return segments.map((segment) => toTitleCase(segment))
}

function isPathActive(pathname: string, item: SidebarItem) {
  if (item.exact) {
    return pathname === item.to
  }

  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

function getWorkspaceNavItems(workspaceId: string): SidebarItem[] {
  return [
    {
      label: "Overview",
      to: `/w/${workspaceId}/overview`,
      icon: LayoutDashboardIcon,
      exact: true,
    },
    {
      label: "Workflows",
      to: `/w/${workspaceId}/workflows`,
      icon: FolderIcon,
    },
    {
      label: "Runs",
      to: `/w/${workspaceId}/runs`,
      icon: PlayIcon,
    },
    {
      label: "Approvals",
      to: `/w/${workspaceId}/approvals`,
      icon: ShieldCheckIcon,
    },
    {
      label: "Settings",
      to: `/w/${workspaceId}/settings`,
      icon: Settings2Icon,
    },
  ]
}

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { workspace, workspaces, isLoading } = useActiveWorkspace()
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Record<string, boolean>>({})

  const routeWorkspaceId = useMemo(() => {
    const match = location.pathname.match(/^\/w\/([^/]+)/)
    return match?.[1] ?? null
  }, [location.pathname])
  const routeWorkflowId = useMemo(() => {
    const match = location.pathname.match(/^\/w\/[^/]+\/workflows\/([^/]+)/)
    if (!match?.[1] || match[1] === "new") {
      return null
    }

    return decodeURIComponent(match[1])
  }, [location.pathname])
  const routeRunId = useMemo(() => {
    const match = location.pathname.match(/^\/w\/[^/]+\/runs\/([^/]+)/)
    if (!match?.[1]) {
      return null
    }

    return decodeURIComponent(match[1])
  }, [location.pathname])
  const isWorkflowRoute = useMemo(
    () => /^\/w\/[^/]+\/workflows(?:\/.*)?$/.test(location.pathname),
    [location.pathname]
  )
  const isRunDetailRoute = useMemo(
    () => /^\/w\/[^/]+\/runs\/[^/]+$/.test(location.pathname),
    [location.pathname]
  )
  const isWorkflowsListRoute = useMemo(
    () => /^\/w\/[^/]+\/workflows$/.test(location.pathname),
    [location.pathname]
  )
  const workflowsBasePath = routeWorkspaceId ? `/w/${routeWorkspaceId}/workflows` : "/"
  const runsBasePath = routeWorkspaceId ? `/w/${routeWorkspaceId}/runs` : "/"
  const { data: runtimeContext } = useRuntimeContext()
  const canOpenFolder = runtimeContext?.capabilities.openNativeFolderPicker ?? false
  const canCopyWorkflowCdCommand = runtimeContext?.capabilities.openTerminal ?? false
  const { data: workflowBreadcrumbs = [] } = useWorkflows(routeWorkspaceId ?? undefined)
  const deleteWorkflow = useDeleteWorkflow(routeWorkspaceId ?? undefined)
  const openWorkflowFolder = useOpenWorkflowFolder(routeWorkspaceId, routeWorkflowId)
  const copyWorkflowCdCommand = useCopyWorkflowCdCommand(routeWorkspaceId, routeWorkflowId)
  const resumeRun = useResumeRun(routeWorkspaceId ?? undefined, routeRunId ?? undefined)
  const cancelRun = useCancelRun(routeWorkspaceId ?? undefined, routeRunId ?? undefined)
  const workflowName = useMemo(
    () => workflowBreadcrumbs.find((entry) => entry.id === routeWorkflowId)?.name,
    [routeWorkflowId, workflowBreadcrumbs]
  )
  const breadcrumbs = buildBreadcrumbs(location.pathname, {
    workspaceName: workspace?.name,
    workflowName,
  })

  useEffect(() => {
    if (!routeWorkspaceId) {
      return
    }

    setExpandedWorkspaceIds((current) => {
      if (current[routeWorkspaceId]) {
        return current
      }

      return {
        ...current,
        [routeWorkspaceId]: true,
      }
    })
  }, [routeWorkspaceId])

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Burns">
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border bg-background">
                  <img src={burnsAvatar} alt="Burns" className="h-full w-full object-cover object-top" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Burns</span>
                  <span className="truncate text-xs text-muted-foreground">Smither&apos;s Manager</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Global</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {globalItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      isActive={isPathActive(location.pathname, item)}
                      render={<NavLink to={item.to} />}
                      tooltip={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
            <SidebarGroupAction
              render={<NavLink to="/workspaces/new" />}
              title="Add workspace"
              aria-label="Add workspace"
            >
              <FolderPlusIcon />
            </SidebarGroupAction>
            <SidebarGroupContent className="space-y-2">
              {isLoading ? (
                <p className="px-2 text-xs text-sidebar-foreground/70">Loading workspaces…</p>
              ) : null}

              {!isLoading && workspaces.length === 0 ? (
                <div className="space-y-2 rounded-lg border border-dashed border-sidebar-border px-3 py-2 group-data-[collapsible=icon]:hidden">
                  <p className="text-xs text-sidebar-foreground/70">No workspaces yet.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    render={<NavLink to="/workspaces/new" />}
                  >
                    Add workspace
                  </Button>
                </div>
              ) : null}

              <SidebarMenu>
                {workspaces.map((entry) => {
                  const workspaceItems = getWorkspaceNavItems(entry.id)
                  const isWorkspaceActive = location.pathname.startsWith(`/w/${entry.id}`)
                  const isOpen = expandedWorkspaceIds[entry.id] ?? isWorkspaceActive

                  return (
                    <Collapsible
                      key={entry.id}
                      open={isOpen}
                      onOpenChange={(open) => {
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [entry.id]: open,
                        }))
                      }}
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger
                          render={
                            <SidebarMenuButton
                              isActive={isWorkspaceActive}
                              tooltip={entry.name}
                              className="justify-start"
                            />
                          }
                        >
                          <ChevronRightIcon
                            className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          <FolderIcon />
                          <span>{entry.name}</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {workspaceItems.map((item) => (
                              <SidebarMenuSubItem key={item.to}>
                                <SidebarMenuSubButton
                                  isActive={isPathActive(location.pathname, item)}
                                  render={<NavLink to={item.to} />}
                                >
                                  <item.icon />
                                  <span>{item.label}</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={isPathActive(location.pathname, settingsItem)}
                render={<NavLink to={settingsItem.to} />}
                tooltip={settingsItem.label}
              >
                <settingsItem.icon />
                <span>{settingsItem.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
        <header className="flex shrink-0 items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="-ml-1" />
            <div className="flex items-center gap-2 text-sm font-medium">
              {breadcrumbs.map((crumb, index) => (
                <div key={`${crumb}-${index}`} className="flex items-center gap-2">
                  {index > 0 ? <span className="text-muted-foreground">{">"}</span> : null}
                  <span>{crumb}</span>
                </div>
              ))}
            </div>
          </div>
          {isRunDetailRoute ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => navigate(runsBasePath)}>
                Back to runs
              </Button>
              <Button
                variant="outline"
                disabled={!routeRunId || resumeRun.isPending}
                onClick={() => {
                  if (!routeRunId) {
                    return
                  }

                  resumeRun.mutate({})
                }}
              >
                {resumeRun.isPending ? "Resuming…" : "Resume"}
              </Button>
              <Button
                variant="destructive"
                disabled={!routeRunId || cancelRun.isPending}
                onClick={() => {
                  if (!routeRunId) {
                    return
                  }

                  cancelRun.mutate({})
                }}
              >
                {cancelRun.isPending ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          ) : isWorkflowRoute ? (
            <div className="flex items-center gap-2">
              {isWorkflowsListRoute ? (
                <Button variant="outline" onClick={() => navigate(`${workflowsBasePath}/new`)}>
                  New workflow
                </Button>
              ) : null}
              {routeWorkflowId ? (
                <>
                  {canOpenFolder ? (
                    <Button
                      variant="outline"
                      disabled={openWorkflowFolder.isPending}
                      onClick={() => openWorkflowFolder.mutate()}
                    >
                      {openWorkflowFolder.isPending ? "Opening folder…" : "Open Folder"}
                    </Button>
                  ) : null}
                  {canCopyWorkflowCdCommand ? (
                    <Button
                      variant="outline"
                      disabled={copyWorkflowCdCommand.isPending}
                      onClick={() => copyWorkflowCdCommand.mutate()}
                    >
                      {copyWorkflowCdCommand.isPending ? "Copying cd command…" : "Copy cd Command"}
                    </Button>
                  ) : null}
                  <Button
                    variant="destructive"
                    disabled={deleteWorkflow.isPending}
                    onClick={() => {
                      const confirmed = window.confirm(
                        `Delete workflow "${workflowName ?? routeWorkflowId}"? This removes its workflow folder from disk.`
                      )
                      if (!confirmed) {
                        return
                      }

                      deleteWorkflow.mutate(routeWorkflowId, {
                        onSuccess: () => {
                          const remainingWorkflows = workflowBreadcrumbs.filter(
                            (workflow) => workflow.id !== routeWorkflowId
                          )
                          const nextWorkflow = remainingWorkflows[0]
                          if (!nextWorkflow) {
                            navigate(workflowsBasePath)
                            return
                          }

                          navigate(`${workflowsBasePath}/${nextWorkflow.id}`)
                        },
                      })
                    }}
                  >
                    {deleteWorkflow.isPending ? "Deleting…" : "Delete workflow"}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
