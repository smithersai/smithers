import { createWorkspaceInputSchema, deleteWorkspaceInputSchema } from "@burns/shared"

import {
  getWorkspaceSmithersRuntimeConfig,
  getWorkspaceSmithersServerStatus,
  restartWorkspaceSmithersServer,
  startWorkspaceSmithersServer,
  stopWorkspaceSmithersServer,
} from "@/services/smithers-instance-service"
import { getWorkspaceHealth } from "@/services/supervisor-service"
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
} from "@/services/workspace-service"
import { HttpError, toErrorResponse } from "@/utils/http-error"

export async function handleWorkspaceRoutes(request: Request, pathname: string) {
  try {
    if (pathname === "/api/workspaces" && request.method === "GET") {
      return Response.json(listWorkspaces())
    }

    if (pathname === "/api/workspaces" && request.method === "POST") {
      const input = createWorkspaceInputSchema.parse(await request.json())
      const workspace = createWorkspace(input)
      return Response.json(workspace, { status: 201 })
    }

    const healthMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/health$/)
    if (healthMatch && request.method === "GET") {
      return Response.json(getWorkspaceHealth(healthMatch[1]))
    }

    const workspaceServerStatusMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/server\/status$/
    )
    if (workspaceServerStatusMatch && request.method === "GET") {
      return Response.json(await getWorkspaceSmithersServerStatus(workspaceServerStatusMatch[1]))
    }

    const workspaceRuntimeConfigMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runtime-config$/)
    if (workspaceRuntimeConfigMatch && request.method === "GET") {
      return Response.json(getWorkspaceSmithersRuntimeConfig(workspaceRuntimeConfigMatch[1]))
    }

    const workspaceServerActionMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/server\/(start|restart|stop)$/
    )
    if (workspaceServerActionMatch && request.method === "POST") {
      const workspaceId = workspaceServerActionMatch[1]
      const action = workspaceServerActionMatch[2]

      if (action === "start") {
        return Response.json(await startWorkspaceSmithersServer(workspaceId))
      }

      if (action === "restart") {
        return Response.json(await restartWorkspaceSmithersServer(workspaceId))
      }

      return Response.json(await stopWorkspaceSmithersServer(workspaceId))
    }

    const workspaceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (workspaceMatch && request.method === "DELETE") {
      const input = deleteWorkspaceInputSchema.parse(await request.json())
      return Response.json(await deleteWorkspace(workspaceMatch[1], input))
    }

    if (workspaceMatch && request.method === "GET") {
      const workspace = getWorkspace(workspaceMatch[1])

      if (!workspace) {
        throw new HttpError(404, `Workspace not found: ${workspaceMatch[1]}`)
      }

      return Response.json(workspace)
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
