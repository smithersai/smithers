#!/usr/bin/env bun

import { startDaemonFromLifecycle } from "./daemon"
import { openInBrowser } from "./open-browser"
import { parseCliArgs } from "./args"
import { renderUsage } from "./usage"
import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  getMissingWebBuildGuidance,
  getWebUrl,
  hasBuiltWebApp,
  startWebServer,
} from "./web"

async function waitForShutdown(onShutdown: () => Promise<void> | void) {
  return await new Promise<number>((resolve) => {
    let stopping = false

    const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping) {
        return
      }

      stopping = true
      process.off("SIGINT", handleSigInt)
      process.off("SIGTERM", handleSigTerm)

      Promise.resolve(onShutdown())
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`Shutdown failed for ${signal}: ${message}`)
        })
        .finally(() => {
          resolve(0)
        })
    }

    const handleSigInt = () => handleSignal("SIGINT")
    const handleSigTerm = () => handleSignal("SIGTERM")

    process.on("SIGINT", handleSigInt)
    process.on("SIGTERM", handleSigTerm)
  })
}

async function run() {
  const parsed = parseCliArgs(process.argv.slice(2))

  if (!parsed.ok) {
    console.error(parsed.error)
    console.error()
    console.error(renderUsage())
    return 1
  }

  const { command } = parsed

  if (command.kind === "help") {
    console.log(renderUsage(command.topic))
    return 0
  }

  if (command.kind === "daemon") {
    const { apiUrl, stopDaemon } = await startDaemonFromLifecycle()
    console.log(`Daemon listening at ${apiUrl}`)
    return waitForShutdown(stopDaemon)
  }

  if (command.kind === "start") {
    const { apiUrl, stopDaemon } = await startDaemonFromLifecycle()
    console.log(`Daemon listening at ${apiUrl}`)

    let stopWebServer: (() => void) | null = null
    let servedWebUrl = getWebUrl(DEFAULT_WEB_HOST, DEFAULT_WEB_PORT)

    if (await hasBuiltWebApp()) {
      const runningWebServer = startWebServer({
        host: DEFAULT_WEB_HOST,
        port: DEFAULT_WEB_PORT,
      })
      servedWebUrl = runningWebServer.url
      stopWebServer = () => runningWebServer.stop()
      console.log(`Web UI serving at ${servedWebUrl}`)
    } else {
      console.warn(getMissingWebBuildGuidance())
    }

    if (command.openWeb) {
      const openResult = await openInBrowser(command.webUrl || servedWebUrl)
      if (!openResult.ok) {
        console.error(`Failed to open browser: ${openResult.error}`)
        console.error(`Open this URL manually: ${command.webUrl || servedWebUrl}`)
      } else {
        console.log(`Opened web URL: ${command.webUrl || servedWebUrl}`)
      }
    }

    return waitForShutdown(async () => {
      stopWebServer?.()
      await stopDaemon()
    })
  }

  if (!(await hasBuiltWebApp())) {
    console.error(getMissingWebBuildGuidance())
    return 1
  }

  const runningWebServer = startWebServer({
    host: command.host,
    port: command.port,
  })

  console.log(`Serving web UI at ${runningWebServer.url}`)

  if (command.openWeb) {
    const openResult = await openInBrowser(runningWebServer.url)
    if (!openResult.ok) {
      console.error(`Failed to open browser: ${openResult.error}`)
      console.error(`Open this URL manually: ${runningWebServer.url}`)
    }
  }

  return waitForShutdown(() => {
    runningWebServer.stop()
  })
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message)
    } else {
      console.error(String(error))
    }
    process.exitCode = 1
  })
