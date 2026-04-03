import { NavLink, useLocation, useNavigate } from "react-router-dom"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function WorkspaceSelector() {
  const location = useLocation()
  const navigate = useNavigate()
  const { workspace, workspaceId, workspaces, isLoading, setWorkspaceId } = useActiveWorkspace()

  if (isLoading) {
    return <div className="rounded-xl border bg-card p-3 text-sm text-muted-foreground">Loading workspace…</div>
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Workspace</p>
        <p className="text-xs text-muted-foreground">Switch the active repo context.</p>
      </div>
      <Select
        value={workspaceId}
        onValueChange={(value) => {
          setWorkspaceId(value)

          if (location.pathname.startsWith("/workflows")) {
            return
          }

          navigate(`/w/${value}/overview`)
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select a workspace" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {workspaces.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {workspace ? (
        <div className="flex flex-col gap-1 rounded-lg">
          <NavLink
            to={`/w/${workspace.id}/overview`}
            className={({ isActive }) =>
              isActive
                ? "rounded-md px-2 py-1.5 text-sm font-medium text-foreground"
                : "rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            Overview
          </NavLink>
          <NavLink
            to={`/w/${workspace.id}/runs`}
            className={({ isActive }) =>
              isActive
                ? "rounded-md px-2 py-1.5 text-sm font-medium text-foreground"
                : "rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            Runs
          </NavLink>
        </div>
      ) : null}
    </div>
  )
}
