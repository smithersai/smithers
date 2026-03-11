import { getLogger } from "@/logging/logger"
import { createApp } from "@/server/app"
import { initializeWorkspaceService } from "@/services/workspace-service"

const bootstrapLogger = getLogger().child({ component: "bootstrap" })

bootstrapLogger.info({ event: "daemon.startup.begin" }, "Starting Mr. Burns daemon")

initializeWorkspaceService()

const app = createApp()
const server = Bun.serve(app)

bootstrapLogger.info(
  {
    event: "daemon.startup.complete",
    port: app.port,
    url: `http://localhost:${app.port}`,
    hasFetchHandler: typeof server.fetch === "function",
  },
  "Mr. Burns daemon is listening"
)
