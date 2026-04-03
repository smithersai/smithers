import { createWorkspaceInputSchema, deleteWorkspaceInputSchema } from "@burns/shared"

import { buildRuntimeContext } from "@/runtime-context"
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
import { discoverLocalWorkflows } from "@/services/workflow-service"
import { openDirectoryFolder } from "@/services/workflow-open-service"
import { HttpError, toErrorResponse } from "@/utils/http-error"

type WorkspaceRouteOptions = {
  openWorkspaceFolder?: (directoryPath: string) => void
}

export async function handleWorkspaceRoutes(
  request: Request,
  pathname: string,
  options: WorkspaceRouteOptions = {}
) {
  try {
    if (pathname === "/api/workspaces" && request.method === "GET") {
      return Response.json(listWorkspaces())
    }

    if (pathname === "/api/workspaces" && request.method === "POST") {
      const input = createWorkspaceInputSchema.parse(await request.json())
      const workspace = createWorkspace(input)
      return Response.json(workspace, { status: 201 })
    }

    if (pathname === "/api/workspaces/discover-local-workflows" && request.method === "POST") {
      const requestUrl = new URL(request.url)
      const runtimeContext = buildRuntimeContext({
        runtimeMode: process.env.BURNS_RUNTIME_MODE,
        requestHostname: requestUrl.hostname,
      })

      if (!runtimeContext.capabilities.openNativeFolderPicker) {
        throw new HttpError(403, "Local workflow discovery is only available on local daemon URLs.")
      }

      const input = (await request.json().catch(() => null)) as { localPath?: unknown } | null
      if (!input || typeof input.localPath !== "string" || !input.localPath.trim()) {
        throw new HttpError(400, "Local repository path is required.")
      }

      return Response.json(discoverLocalWorkflows(input.localPath))
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

    const workspaceOpenFolderMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/open-folder$/)
    if (workspaceOpenFolderMatch && request.method === "POST") {
      const workspaceId = workspaceOpenFolderMatch[1]
      const workspace = getWorkspace(workspaceId)
      if (!workspace) {
        throw new HttpError(404, `Workspace not found: ${workspaceId}`)
      }

      const requestUrl = new URL(request.url)
      const runtimeContext = buildRuntimeContext({
        runtimeMode: process.env.BURNS_RUNTIME_MODE,
        requestHostname: requestUrl.hostname,
      })

      if (!runtimeContext.capabilities.openNativeFolderPicker) {
        throw new HttpError(
          403,
          "Workspace folder actions are only available on local daemon URLs."
        )
      }

      const openFolder = options.openWorkspaceFolder ?? ((targetPath) => {
        openDirectoryFolder(targetPath)
      })
      openFolder(workspace.path)
      return new Response(null, { status: 204 })
    }

    const workspacePathMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/path$/)
    if (workspacePathMatch && request.method === "POST") {
      const workspaceId = workspacePathMatch[1]
      const workspace = getWorkspace(workspaceId)
      if (!workspace) {
        throw new HttpError(404, `Workspace not found: ${workspaceId}`)
      }

      const requestUrl = new URL(request.url)
      const runtimeContext = buildRuntimeContext({
        runtimeMode: process.env.BURNS_RUNTIME_MODE,
        requestHostname: requestUrl.hostname,
      })

      if (!runtimeContext.capabilities.openNativeFolderPicker) {
        throw new HttpError(
          403,
          "Workspace path actions are only available on local daemon URLs."
        )
      }

      return Response.json({ path: workspace.path })
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
