import { randomUUID } from "node:crypto"

import { getLogger, type BurnsLogger } from "@/logging/logger"
import { handleAgentRoutes } from "@/server/routes/agent-routes"
import { handleApprovalRoutes } from "@/server/routes/approval-routes"
import { handleDiagnosticsRoutes } from "@/server/routes/diagnostics-routes"
import { DAEMON_HEALTH_PATH, handleHealthRequest } from "@/server/routes/health-routes"
import { handleRunRoutes } from "@/server/routes/run-routes"
import { handleSettingsRoutes } from "@/server/routes/settings-routes"
import { handleSystemRoutes } from "@/server/routes/system-routes"
import { handleWorkflowRoutes } from "@/server/routes/workflow-routes"
import { handleWorkspaceRoutes } from "@/server/routes/workspace-routes"

const jsonHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
}

function withCorsHeaders(response: Response) {
  const nextHeaders = new Headers(response.headers)
  Object.entries(jsonHeaders).forEach(([key, value]) => nextHeaders.set(key, value))

  return new Response(response.body, {
    status: response.status,
    headers: nextHeaders,
  })
}

type CreateAppOptions = {
  logger?: BurnsLogger
  port?: number
}

export type DaemonApp = ReturnType<typeof createApp>

export function createApp(options: CreateAppOptions = {}) {
  const logger = (options.logger ?? getLogger()).child({ component: "http.server" })
  const port = options.port ?? 7332

  return {
    port,
    async fetch(request: Request) {
      const startedAt = performance.now()
      const url = new URL(request.url)
      const pathname = url.pathname
      const requestId = randomUUID()
      const requestLogger = logger.child({
        requestId,
        method: request.method,
        path: pathname,
      })
      requestLogger.info({ event: "http.request.received" }, "Request received")

      let response: Response

      try {
        if (request.method === "OPTIONS") {
          response = new Response(null, { status: 204 })
        } else {
          const routeResponse =
            (pathname === DAEMON_HEALTH_PATH ? handleHealthRequest() : null) ??
            handleAgentRoutes(request, pathname) ??
            (await handleWorkspaceRoutes(request, pathname)) ??
            (await handleWorkflowRoutes(request, pathname)) ??
            (await handleRunRoutes(request, pathname)) ??
            (await handleApprovalRoutes(request, pathname)) ??
            (await handleSettingsRoutes(request, pathname)) ??
            (await handleSystemRoutes(request, pathname)) ??
            handleDiagnosticsRoutes(request, pathname)

          response = routeResponse ?? Response.json({ error: "Not found" }, { status: 404 })
        }
      } catch (error) {
        requestLogger.error(
          { event: "http.request.unhandled_error", err: error },
          "Request failed with unhandled error"
        )
        response = Response.json({ error: "Unexpected server error" }, { status: 500 })
      }

      const finalizedResponse = withCorsHeaders(response)
      const durationMs = Number((performance.now() - startedAt).toFixed(3))
      const completionFields = {
        event: "http.request.completed",
        statusCode: finalizedResponse.status,
        durationMs,
      }

      if (finalizedResponse.status >= 500) {
        requestLogger.error(completionFields, "Request completed with server error")
      } else if (finalizedResponse.status >= 400) {
        requestLogger.warn(completionFields, "Request completed with client error")
      } else {
        requestLogger.info(completionFields, "Request completed")
      }

      return finalizedResponse
    },
  }
}
