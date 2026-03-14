import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ServerHealthCard } from "@/features/workspace/components/server-health-card"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { useDeleteWorkspace } from "@/features/workspaces/hooks/use-delete-workspace"
import { setActiveWorkspaceId } from "@/features/workspaces/lib/active-workspace-store"

export function WorkspaceSettingsPage() {
  const navigate = useNavigate()
  const { workspace, workspaces } = useActiveWorkspace()
  const deleteWorkspace = useDeleteWorkspace()
  const [deleteConfirmation, setDeleteConfirmation] = useState("")

  const nextWorkspaceId = useMemo(() => {
    if (!workspace) {
      return null
    }

    return workspaces.find((entry) => entry.id !== workspace.id)?.id ?? null
  }, [workspace, workspaces])

  function navigateAfterDelete() {
    if (nextWorkspaceId) {
      setActiveWorkspaceId(nextWorkspaceId)
      navigate(`/w/${nextWorkspaceId}/overview`, { replace: true })
      return
    }

    setActiveWorkspaceId(null)
    navigate("/workspaces/new", { replace: true })
  }

  if (!workspace) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace not found</CardTitle>
            <CardDescription>Select another workspace from the sidebar.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid gap-4 p-6">
        <ServerHealthCard
          workspace={workspace}
          workspaceId={workspace.id}
          title="Workspace health"
          description="Runtime health, daemon connectivity, and Smithers controls."
          showControls
        />

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
            <CardDescription>Workspace removal actions are irreversible for file deletion.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-semibold">Unlink Workspace</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Removes this workspace from Burns and keeps files at <code>{workspace.path}</code>.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                disabled={deleteWorkspace.isPending}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Unlink workspace \"${workspace.name}\" from Burns? Files will be kept.`
                  )
                  if (!confirmed) {
                    return
                  }

                  deleteWorkspace.mutate(
                    {
                      workspaceId: workspace.id,
                      input: { mode: "unlink" },
                    },
                    {
                      onSuccess: () => {
                        navigateAfterDelete()
                      },
                    }
                  )
                }}
              >
                {deleteWorkspace.isPending ? "Unlinking..." : "Unlink Workspace"}
              </Button>
            </div>

            <div className="rounded-lg border border-destructive/40 p-4">
              <h3 className="text-sm font-semibold text-destructive">Delete Workspace</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Removes this workspace from Burns and deletes all files at <code>{workspace.path}</code>.
              </p>
              <div className="mt-3 grid gap-2">
                <label className="text-xs text-muted-foreground" htmlFor="workspace-delete-confirmation">
                  Type <strong>{workspace.name}</strong> to confirm.
                </label>
                <Input
                  id="workspace-delete-confirmation"
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  placeholder={workspace.name}
                />
              </div>
              <Button
                className="mt-3"
                variant="destructive"
                disabled={deleteWorkspace.isPending || deleteConfirmation !== workspace.name}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Delete workspace \"${workspace.name}\" and all files at\n${workspace.path}\n?`
                  )
                  if (!confirmed) {
                    return
                  }

                  deleteWorkspace.mutate(
                    {
                      workspaceId: workspace.id,
                      input: { mode: "delete" },
                    },
                    {
                      onSuccess: () => {
                        setDeleteConfirmation("")
                        navigateAfterDelete()
                      },
                    }
                  )
                }}
              >
                {deleteWorkspace.isPending ? "Deleting..." : "Delete Workspace"}
              </Button>
            </div>

            {deleteWorkspace.error ? (
              <p className="text-sm text-destructive">{deleteWorkspace.error.message}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
