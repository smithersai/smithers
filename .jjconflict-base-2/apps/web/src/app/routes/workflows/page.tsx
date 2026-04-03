import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { formatTimestamp } from "@/features/workspace/lib/format"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function WorkflowsPage() {
  const navigate = useNavigate()
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: workflows = [], isLoading } = useWorkflows(workspace?.id)
  const workflowsBasePath = workspaceId ? `/w/${workspaceId}/workflows` : "/"

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
      <div className="grid min-h-0 flex-1 gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace workflows</CardTitle>
            <CardDescription>Select a workflow to open its file and preview source.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading workflows…</p>
            ) : workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workflows found for this workspace.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {workflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    onClick={() => navigate(`${workflowsBasePath}/${workflow.id}`)}
                    className="rounded-xl border p-4 text-left transition-colors hover:bg-muted"
                  >
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <p className="font-medium">{workflow.name}</p>
                      <Badge variant="outline">{workflow.status}</Badge>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">{workflow.relativePath}</p>
                      <p className="text-xs text-muted-foreground">
                        Updated {formatTimestamp(workflow.updatedAt)}
                      </p>
                    </div>
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
