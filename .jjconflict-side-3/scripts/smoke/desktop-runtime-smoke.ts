import {
  buildRuntimeConfigInitScript,
  resolveRuntimeConfig,
} from "../../apps/desktop/src/runtime-config"

const HEALTH_TIMEOUT_MS = 15_000

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDaemonHealth(healthUrl: string) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling while daemon is warming up.
    }

    await delay(250)
  }

  throw new Error(`Daemon health check did not pass: ${healthUrl}`)
}

function reserveAvailablePort() {
  const probeServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })

  const availablePort = probeServer.port
  probeServer.stop(true)
  return availablePort
}

function evaluateRuntimeScript(script: string) {
  const evaluator = new Function(
    `
      const window = {};
      ${script}
      return window.__BURNS_RUNTIME_CONFIG__;
    `
  )

  return evaluator() as {
    burnsApiUrl?: unknown
    runtimeMode?: unknown
  }
}

async function main() {
  process.env.BURNS_SMITHERS_MANAGED_MODE = "0"
  const { startDaemon } = await import("../../apps/daemon/src/bootstrap/daemon-lifecycle")
  const daemonPort = reserveAvailablePort()
  const runtime = await startDaemon({ port: daemonPort })

  try {
    await waitForDaemonHealth(runtime.healthUrl)

    const runtimeConfig = resolveRuntimeConfig({ daemonApiUrl: runtime.url })
    if (runtimeConfig.runtimeMode !== "desktop") {
      throw new Error(`Expected runtimeMode=desktop, got ${String(runtimeConfig.runtimeMode)}`)
    }

    if (runtimeConfig.burnsApiUrl !== runtime.url) {
      throw new Error(
        `Expected runtime burnsApiUrl=${runtime.url}, got ${runtimeConfig.burnsApiUrl}`
      )
    }

    const initScript = buildRuntimeConfigInitScript(runtimeConfig)
    const injectedConfig = evaluateRuntimeScript(initScript)

    if (injectedConfig.runtimeMode !== "desktop") {
      throw new Error("Runtime init script did not set desktop runtime mode")
    }

    if (injectedConfig.burnsApiUrl !== runtime.url) {
      throw new Error("Runtime init script did not inject daemon API URL")
    }

    console.log(`[smoke:desktop] Daemon healthy at ${runtime.healthUrl}`)
    console.log("[smoke:desktop] Desktop runtime config contract validated")
  } finally {
    await runtime.stop()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[smoke:desktop] ${message}`)
  process.exitCode = 1
})
