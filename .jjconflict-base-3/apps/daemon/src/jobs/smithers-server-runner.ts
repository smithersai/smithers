import { mkdirSync } from "node:fs"
import path from "node:path"

import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { startServer } from "smithers-orchestrator/server"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }

  return value
}

function parsePort(rawValue: string) {
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid Smithers port: ${rawValue}`)
  }

  return value
}

function parseOptionalPid(rawValue: string | undefined) {
  if (!rawValue) {
    return null
  }

  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function parseBoolean(rawValue: string | undefined) {
  if (!rawValue) {
    return false
  }

  const normalized = rawValue.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function parsePositiveInt(rawValue: string | undefined, fallback: number) {
  if (!rawValue) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

const workspaceId = requireEnv("BURNS_SMITHERS_WORKSPACE_ID")
const workspacePath = requireEnv("BURNS_SMITHERS_WORKSPACE_PATH")
const dbPath = requireEnv("BURNS_SMITHERS_DB_PATH")
const port = parsePort(requireEnv("BURNS_SMITHERS_PORT"))
const allowNetwork = parseBoolean(process.env.BURNS_SMITHERS_ALLOW_NETWORK)
const maxBodyBytes = parsePositiveInt(process.env.BURNS_SMITHERS_MAX_BODY_BYTES, 1_048_576)
const rootDirPolicy = process.env.BURNS_SMITHERS_ROOT_DIR_POLICY?.trim() || "workspace-root"
const daemonPid = parseOptionalPid(process.env.BURNS_DAEMON_PID)

mkdirSync(path.dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath, { create: true })
sqlite.exec("PRAGMA journal_mode = WAL")
sqlite.exec("PRAGMA busy_timeout = 5000")
sqlite.exec("PRAGMA foreign_keys = ON")

const db = drizzle(sqlite)

const server = startServer({
  port,
  db,
  rootDir: rootDirPolicy === "workspace-root" ? workspacePath : undefined,
  allowNetwork,
  maxBodyBytes,
})

let shuttingDown = false
let daemonMonitorInterval: ReturnType<typeof setInterval> | null = null

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const errorCode = (error as { code?: string }).code
    return errorCode === "EPERM"
  }
}

function closeAndExit(exitCode: number) {
  if (daemonMonitorInterval) {
    clearInterval(daemonMonitorInterval)
    daemonMonitorInterval = null
  }

  try {
    sqlite.close()
  } catch {
    // Ignore sqlite close failures while exiting.
  }

  process.exit(exitCode)
}

function shutdown(reason: string) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.info(`[smithers-runner:${workspaceId}] shutting down (${reason})`)

  const forceExitTimer = setTimeout(() => {
    closeAndExit(1)
  }, 8_000)

  forceExitTimer.unref()

  if (!server.listening) {
    clearTimeout(forceExitTimer)
    closeAndExit(1)
    return
  }

  server.close((error?: Error) => {
    clearTimeout(forceExitTimer)
    if (error) {
      console.error(`[smithers-runner:${workspaceId}] close failed`, error)
      closeAndExit(1)
      return
    }

    closeAndExit(0)
  })
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("uncaughtException", (error) => {
  console.error(`[smithers-runner:${workspaceId}] uncaught exception`, error)
  shutdown("uncaughtException")
})
process.on("unhandledRejection", (error) => {
  console.error(`[smithers-runner:${workspaceId}] unhandled rejection`, error)
  shutdown("unhandledRejection")
})

server.once("listening", () => {
  console.info(
    `[smithers-runner:${workspaceId}] listening on http://127.0.0.1:${port} (rootDir=${workspacePath})`
  )
})

server.on("error", (error) => {
  console.error(`[smithers-runner:${workspaceId}] server error`, error)
  shutdown("serverError")
})

if (daemonPid !== null) {
  daemonMonitorInterval = setInterval(() => {
    if (!isProcessAlive(daemonPid)) {
      shutdown("daemonExited")
    }
  }, 1_000)

  daemonMonitorInterval.unref()
}
