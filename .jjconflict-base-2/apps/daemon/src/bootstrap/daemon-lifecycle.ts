import { getLogger, resetLogger, type BurnsLogger } from "@/logging/logger"
import { createApp, type DaemonApp } from "@/server/app"
import { DAEMON_HEALTH_PATH } from "@/server/routes/health-routes"
import { registerDaemonRestartHandler } from "@/services/daemon-runtime-control-service"
import {
  shutdownWorkspaceSmithersInstances,
  warmWorkspaceSmithersInstances,
} from "@/services/smithers-instance-service"
import {
  pruneMissingWorkspaces,
  startMissingWorkspaceMonitor,
} from "@/services/workspace-reconciliation-service"
import { initializeWorkspaceService, listWorkspaces } from "@/services/workspace-service"

type DaemonServer = {
  fetch: unknown
  port?: number
  stop: (closeActiveConnections?: boolean) => void
}

type DaemonStartOptions = {
  port?: number
}

type DaemonStopSignal = "SIGINT" | "SIGTERM" | "programmatic"

type DaemonStopOptions = {
  signal?: DaemonStopSignal
}

export type DaemonRuntimeHandle = {
  server: DaemonServer
  port: number
  url: string
  healthUrl: string
  startedAt: string
  stop: () => Promise<void>
}

type DaemonLifecycle = {
  start: (options?: DaemonStartOptions) => Promise<DaemonRuntimeHandle>
  stop: (options?: DaemonStopOptions) => Promise<void>
  restart: (options?: DaemonStartOptions) => Promise<DaemonRuntimeHandle>
  getRuntime: () => DaemonRuntimeHandle | null
}

type DaemonLifecycleDependencies = {
  logger?: BurnsLogger
  now?: () => number
  createApp?: (options: { logger?: BurnsLogger; port?: number }) => DaemonApp
  serve?: (options: DaemonApp & { idleTimeout: number }) => DaemonServer
  initializeWorkspaceService?: typeof initializeWorkspaceService
  listWorkspaces?: typeof listWorkspaces
  warmWorkspaceSmithersInstances?: (
    workspaces: ReturnType<typeof listWorkspaces>
  ) => ReturnType<typeof warmWorkspaceSmithersInstances>
  shutdownWorkspaceSmithersInstances?: typeof shutdownWorkspaceSmithersInstances
  pruneMissingWorkspaces?: typeof pruneMissingWorkspaces
  startMissingWorkspaceMonitor?: typeof startMissingWorkspaceMonitor
}

// Bun.serve enforces a max idleTimeout of 255 seconds.
// Long-running SSE routes are kept alive via heartbeat frames.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 255

function defaultServe(options: DaemonApp & { idleTimeout: number }): DaemonServer {
  return Bun.serve(options)
}

export function createDaemonLifecycle(dependencies: DaemonLifecycleDependencies = {}): DaemonLifecycle {
  const now = dependencies.now ?? Date.now
  const buildApp = dependencies.createApp ?? createApp
  const serve = dependencies.serve ?? defaultServe
  const initWorkspaceService = dependencies.initializeWorkspaceService ?? initializeWorkspaceService
  const getWorkspaceList = dependencies.listWorkspaces ?? listWorkspaces
  const warmWorkspaceInstances =
    dependencies.warmWorkspaceSmithersInstances ?? warmWorkspaceSmithersInstances
  const shutdownWorkspaceInstances =
    dependencies.shutdownWorkspaceSmithersInstances ?? shutdownWorkspaceSmithersInstances
  const pruneMissingWorkspacePaths =
    dependencies.pruneMissingWorkspaces ?? pruneMissingWorkspaces
  const startWorkspaceMonitor =
    dependencies.startMissingWorkspaceMonitor ?? startMissingWorkspaceMonitor

  let runtime: DaemonRuntimeHandle | null = null
  let startPromise: Promise<DaemonRuntimeHandle> | null = null
  let stopPromise: Promise<void> | null = null
  let stopWorkspaceMonitor: (() => void) | null = null

  function createLifecycleLogger() {
    return (dependencies.logger ?? getLogger()).child({ component: "bootstrap" })
  }

  async function start(options: DaemonStartOptions = {}) {
    if (runtime) {
      return runtime
    }

    if (startPromise) {
      return startPromise
    }

    startPromise = (async () => {
      const logger = createLifecycleLogger()
      logger.info({ event: "daemon.startup.begin" }, "Starting Burns daemon")

      try {
        initWorkspaceService()
        await pruneMissingWorkspacePaths()
        stopWorkspaceMonitor = startWorkspaceMonitor()
        void warmWorkspaceInstances(getWorkspaceList())

        const app = buildApp({ port: options.port })
        const server = serve({
          ...app,
          // Workflow authoring streams can be quiet for >10s while a CLI agent works.
          // Keep idle timeout high enough for long-running generation/edit sessions.
          idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
        })

        const resolvedPort = typeof server.port === "number" ? server.port : app.port
        const url = `http://localhost:${resolvedPort}`
        const startedAt = new Date(now()).toISOString()

        runtime = {
          server,
          port: resolvedPort,
          url,
          healthUrl: `${url}${DAEMON_HEALTH_PATH}`,
          startedAt,
          stop: () => stop({ signal: "programmatic" }),
        }

        logger.info(
          {
            event: "daemon.startup.complete",
            port: runtime.port,
            url: runtime.url,
            healthUrl: runtime.healthUrl,
            startedAt: runtime.startedAt,
            hasFetchHandler: typeof server.fetch === "function",
          },
          "Burns daemon is listening"
        )

        return runtime
      } catch (error) {
        if (stopWorkspaceMonitor) {
          stopWorkspaceMonitor()
          stopWorkspaceMonitor = null
        }
        logger.error({ event: "daemon.startup.failed", err: error }, "Failed to start daemon")
        throw error
      }
    })().finally(() => {
      startPromise = null
    })

    return startPromise
  }

  async function stop(options: DaemonStopOptions = {}) {
    if (stopPromise) {
      return stopPromise
    }

    const signal = options.signal ?? "programmatic"

    stopPromise = (async () => {
      const logger = createLifecycleLogger()
      if (startPromise && !runtime) {
        try {
          await startPromise
        } catch {
          return
        }
      }

      if (!runtime) {
        if (stopWorkspaceMonitor) {
          stopWorkspaceMonitor()
          stopWorkspaceMonitor = null
        }
        return
      }

      logger.info({ event: "daemon.shutdown.begin", signal }, "Shutting down Burns daemon")

      try {
        if (stopWorkspaceMonitor) {
          stopWorkspaceMonitor()
          stopWorkspaceMonitor = null
        }
        await shutdownWorkspaceInstances()
        runtime.server.stop(true)
        runtime = null
        if (!dependencies.logger) {
          resetLogger()
        }
        logger.info({ event: "daemon.shutdown.complete", signal }, "Burns daemon stopped")
      } catch (error) {
        logger.error(
          { event: "daemon.shutdown.failed", signal, err: error },
          "Failed shutting down daemon cleanly"
        )
        throw error
      }
    })().finally(() => {
      stopPromise = null
    })

    return stopPromise
  }

  async function restart(options: DaemonStartOptions = {}) {
    const nextPort = options.port ?? runtime?.port
    await stop({ signal: "programmatic" })
    return await start({ port: nextPort })
  }

  function getRuntime() {
    return runtime
  }

  return {
    start,
    stop,
    restart,
    getRuntime,
  }
}

const daemonLifecycle = createDaemonLifecycle()

export const startDaemon = daemonLifecycle.start
export const stopDaemon = daemonLifecycle.stop
export const restartDaemon = daemonLifecycle.restart
export const getDaemonRuntime = daemonLifecycle.getRuntime

registerDaemonRestartHandler(async () => {
  await daemonLifecycle.restart()
})

export type { DaemonStartOptions, DaemonStopOptions, DaemonStopSignal }
