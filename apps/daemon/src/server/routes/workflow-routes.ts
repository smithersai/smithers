import {
  editWorkflowInputSchema,
  generateWorkflowInputSchema,
  workflowFileDocumentSchema,
  workflowFileListSchema,
  workflowLaunchFieldsResponseSchema,
  type WorkflowAuthoringStreamEvent,
  updateWorkflowInputSchema,
} from "@burns/shared"

import type { AgentCliEvent } from "@/agents/BaseCliAgent"
import { openWorkflowFolder } from "@/services/workflow-open-service"
import {
  deleteWorkflow,
  editWorkflowFromPrompt,
  generateWorkflowFromPrompt,
  getWorkflowFile,
  getWorkflow,
  getWorkflowLaunchFields,
  getWorkflowDirectoryPath,
  listWorkflowFiles,
  listWorkflows,
  saveWorkflow,
} from "@/services/workflow-service"
import { buildRuntimeContext } from "@/runtime-context"
import { HttpError, toErrorResponse } from "@/utils/http-error"

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return "Workflow authoring failed"
}

function toWorkflowAuthoringAgentEvent(event: AgentCliEvent): WorkflowAuthoringStreamEvent {
  const timestamp = new Date().toISOString()

  if (event.type === "started") {
    return {
      type: "agent-event",
      eventType: "started",
      engine: event.engine,
      title: event.title,
      message: event.resume ? `Session started (${event.resume})` : "Session started",
      resume: event.resume,
      detail: event.detail,
      timestamp,
    }
  }

  if (event.type === "action") {
    return {
      type: "agent-event",
      eventType: "action",
      engine: event.engine,
      title: event.action.title,
      message: event.message,
      phase: event.phase,
      actionId: event.action.id,
      actionKind: event.action.kind,
      entryType: event.entryType,
      ok: event.ok,
      level: event.level,
      detail: event.action.detail,
      timestamp,
    }
  }

  return {
    type: "agent-event",
    eventType: "completed",
    engine: event.engine,
    title: "completed",
    message: event.ok
      ? "Run completed successfully"
      : event.error || "Run completed with errors",
    resume: event.resume,
    ok: event.ok,
    answer: event.answer,
    error: event.error,
    usage: event.usage,
    timestamp,
  }
}

function createWorkflowAuthoringStreamResponse(
  run: (emit: (event: WorkflowAuthoringStreamEvent) => void) => Promise<void>
) {
  const encoder = new TextEncoder()
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      keepaliveTimer = setInterval(() => {
        if (closed) {
          return
        }

        // Keep the connection active for long-running CLI generations.
        // Client parser ignores blank lines.
        controller.enqueue(encoder.encode("\n"))
      }, 3000)

      const emit = (event: WorkflowAuthoringStreamEvent) => {
        if (closed) {
          return
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }

      try {
        await run(emit)
      } catch (error) {
        emit({
          type: "error",
          message: getErrorMessage(error),
          timestamp: new Date().toISOString(),
        })
      } finally {
        closed = true
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer)
          keepaliveTimer = null
        }
        controller.close()
      }
    },
    cancel() {
      closed = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

type WorkflowRouteOptions = {
  openWorkflowFolder?: (directoryPath: string) => void
}

function toCdCommand(workflowDirectoryPath: string) {
  const escapedPath = workflowDirectoryPath.replaceAll('"', "\\\"")
  return `cd "${escapedPath}"`
}

export async function handleWorkflowRoutes(
  request: Request,
  pathname: string,
  options: WorkflowRouteOptions = {}
) {
  try {
    const workflowGenerateStreamMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/generate\/stream$/
    )
    if (workflowGenerateStreamMatch && request.method === "POST") {
      const input = generateWorkflowInputSchema.parse(await request.json())
      const workspaceId = workflowGenerateStreamMatch[1]

      return createWorkflowAuthoringStreamResponse(async (emit) => {
        const workflow = await generateWorkflowFromPrompt({
          workspaceId,
          ...input,
          onProgress: (progress) => {
            emit({
              type: "status",
              stage: progress.stage,
              message: progress.message,
              attempt: progress.attempt,
              totalAttempts: progress.totalAttempts,
              timestamp: new Date().toISOString(),
            })
          },
          onAgentOutput: (output) => {
            emit({
              type: "agent-output",
              stream: output.stream,
              chunk: output.chunk,
              timestamp: new Date().toISOString(),
            })
          },
          onAgentEvent: (event) => {
            emit(toWorkflowAuthoringAgentEvent(event))
          },
        })

        emit({
          type: "result",
          workflow,
          timestamp: new Date().toISOString(),
        })
      })
    }

    const workflowGenerateMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/workflows\/generate$/)
    if (workflowGenerateMatch && request.method === "POST") {
      const input = generateWorkflowInputSchema.parse(await request.json())
      return Response.json(
        await generateWorkflowFromPrompt({
          workspaceId: workflowGenerateMatch[1],
          ...input,
        }),
        { status: 201 }
      )
    }

    const workflowEditStreamMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/edit\/stream$/
    )
    if (workflowEditStreamMatch && request.method === "POST") {
      const input = editWorkflowInputSchema.parse(await request.json())
      const workspaceId = workflowEditStreamMatch[1]
      const workflowId = workflowEditStreamMatch[2]

      return createWorkflowAuthoringStreamResponse(async (emit) => {
        const workflow = await editWorkflowFromPrompt({
          workspaceId,
          workflowId,
          ...input,
          onProgress: (progress) => {
            emit({
              type: "status",
              stage: progress.stage,
              message: progress.message,
              attempt: progress.attempt,
              totalAttempts: progress.totalAttempts,
              timestamp: new Date().toISOString(),
            })
          },
          onAgentOutput: (output) => {
            emit({
              type: "agent-output",
              stream: output.stream,
              chunk: output.chunk,
              timestamp: new Date().toISOString(),
            })
          },
          onAgentEvent: (event) => {
            emit(toWorkflowAuthoringAgentEvent(event))
          },
        })

        emit({
          type: "result",
          workflow,
          timestamp: new Date().toISOString(),
        })
      })
    }

    const workflowEditMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/edit$/)
    if (workflowEditMatch && request.method === "POST") {
      const input = editWorkflowInputSchema.parse(await request.json())
      return Response.json(
        await editWorkflowFromPrompt({
          workspaceId: workflowEditMatch[1],
          workflowId: workflowEditMatch[2],
          ...input,
        })
      )
    }

    const workflowDetailMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)$/)
    const workflowFileListMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/files$/
    )
    if (workflowFileListMatch && request.method === "GET") {
      return Response.json(
        workflowFileListSchema.parse(listWorkflowFiles(workflowFileListMatch[1], workflowFileListMatch[2]))
      )
    }

    const workflowFileContentMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/files\/content$/
    )
    if (workflowFileContentMatch && request.method === "GET") {
      const url = new URL(request.url)
      const filePath = url.searchParams.get("path")
      if (!filePath) {
        throw new HttpError(400, "Missing file path")
      }

      return Response.json(
        workflowFileDocumentSchema.parse(
          getWorkflowFile(workflowFileContentMatch[1], workflowFileContentMatch[2], filePath)
        )
      )
    }

    const workflowLaunchFieldsMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/launch-fields$/
    )
    if (workflowLaunchFieldsMatch && request.method === "GET") {
      return Response.json(
        workflowLaunchFieldsResponseSchema.parse(
          getWorkflowLaunchFields(workflowLaunchFieldsMatch[1], workflowLaunchFieldsMatch[2])
        )
      )
    }

    const workflowOpenFolderMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/open-folder$/
    )
    if (workflowOpenFolderMatch && request.method === "POST") {
      const workspaceId = workflowOpenFolderMatch[1]
      const workflowId = workflowOpenFolderMatch[2]
      const requestUrl = new URL(request.url)
      const runtimeContext = buildRuntimeContext({
        runtimeMode: process.env.BURNS_RUNTIME_MODE,
        requestHostname: requestUrl.hostname,
      })

      if (!runtimeContext.capabilities.openNativeFolderPicker) {
        throw new HttpError(
          403,
          "Workflow folder actions are only available on local daemon URLs."
        )
      }

      const workflowDirectoryPath = getWorkflowDirectoryPath(workspaceId, workflowId)
      const openFolder = options.openWorkflowFolder ?? ((targetPath) => {
        openWorkflowFolder(targetPath)
      })
      openFolder(workflowDirectoryPath)
      return new Response(null, { status: 204 })
    }

    const workflowCdCommandMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/workflows\/([^/]+)\/cd-command$/
    )
    if (workflowCdCommandMatch && request.method === "POST") {
      const workspaceId = workflowCdCommandMatch[1]
      const workflowId = workflowCdCommandMatch[2]
      const requestUrl = new URL(request.url)
      const runtimeContext = buildRuntimeContext({
        runtimeMode: process.env.BURNS_RUNTIME_MODE,
        requestHostname: requestUrl.hostname,
      })

      if (!runtimeContext.capabilities.openTerminal) {
        throw new HttpError(403, "Workflow command actions are only available on local daemon URLs.")
      }

      const workflowDirectoryPath = getWorkflowDirectoryPath(workspaceId, workflowId)
      return Response.json({ command: toCdCommand(workflowDirectoryPath) })
    }

    if (workflowDetailMatch && request.method === "GET") {
      return Response.json(getWorkflow(workflowDetailMatch[1], workflowDetailMatch[2]))
    }

    if (workflowDetailMatch && request.method === "PUT") {
      const input = updateWorkflowInputSchema.parse(await request.json())
      return Response.json(saveWorkflow(workflowDetailMatch[1], workflowDetailMatch[2], input.source))
    }

    if (workflowDetailMatch && request.method === "DELETE") {
      deleteWorkflow(workflowDetailMatch[1], workflowDetailMatch[2])
      return new Response(null, { status: 204 })
    }

    const workflowMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/workflows$/)
    if (workflowMatch && request.method === "GET") {
      return Response.json(listWorkflows(workflowMatch[1]))
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
