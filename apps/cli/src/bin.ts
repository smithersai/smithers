#!/usr/bin/env bun

import { startDaemonFromLifecycle } from "./daemon"
import { parseCliArgs } from "./args"
import { renderUsage } from "./usage"

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

  if (command.kind === "daemon" || command.kind === "start") {
    const { apiUrl, stopDaemon } = await startDaemonFromLifecycle()
    console.log(`Daemon listening at ${apiUrl}`)
    return waitForShutdown(stopDaemon)
  }

  return 1
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
