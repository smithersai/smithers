import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Settings, SettingsReconcileSummary, Workspace } from "@burns/shared"

import {
  DEFAULT_SMITHERS_MAX_WORKSPACE_INSTANCES,
  DEFAULT_SMITHERS_PORT_BASE,
} from "@/config/app-config"
import { getLogger } from "@/logging/logger"
import {
  getBurnsSmithersRuntimeDefaults,
  haveManagedRuntimeSettingsChanged,
  resolveWorkspaceSmithersRuntimeConfig,
} from "@/services/smithers-runtime-config-service"
import {
  ensureWorkspaceSmithersLayout,
  getManagedSmithersDbPath,
} from "@/services/workspace-layout"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

type SmithersInstanceStatus = "starting" | "healthy" | "crashed" | "stopped"
type WorkspaceServerProcessState = SmithersInstanceStatus | "self-managed" | "disabled"

type SmithersInstanceRecord = {
  workspace: Workspace
  workspaceId: string
  port: number | null
  baseUrl: string | null
  dbPath: string | null
  process: ChildProcess | null
  status: SmithersInstanceStatus
  restartCount: number
  crashCount: number
  crashStreak: number
  lastHeartbeatAt: string | null
  startPromise?: Promise<void>
  restartTimer?: ReturnType<typeof setTimeout>
  stopRequested: boolean
}

export type WorkspaceServerStatus = {
  workspaceId: string
  runtimeMode: Workspace["runtimeMode"]
  processState: WorkspaceServerProcessState
  lastHeartbeatAt: string | null
  restartCount: number
  crashCount: number
  port: number | null
  baseUrl: string | null
}

const logger = getLogger().child({ component: "smithers.instance.service" })

const runnerScriptPath = fileURLToPath(new URL("../jobs/smithers-server-runner.ts", import.meta.url))
const instances = new Map<string, SmithersInstanceRecord>()

let shuttingDown = false
const HEARTBEAT_PROBE_TIMEOUT_MS = 1_500

function parseEnvInt(rawValue: string | undefined, fallback: number, min: number) {
  if (!rawValue) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback
  }

  return parsed
}

function parseBoolean(value: string | undefined) {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function sleep(durationMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs)
    timer.unref()
  })
}

function resolveBunExecutable() {
  const bunBinary =
    typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("bun") : undefined

  return bunBinary ?? process.execPath
}

function isManagedModeEnabled() {
  return getBurnsSmithersRuntimeDefaults().smithersManagedPerWorkspace
}

function resolveFallbackBaseUrl() {
  return getBurnsSmithersRuntimeDefaults().smithersBaseUrl
}

function getAllowNetworkSetting() {
  return getBurnsSmithersRuntimeDefaults().allowNetwork
}

function getMaxBodyBytesSetting() {
  return getBurnsSmithersRuntimeDefaults().maxBodyBytes
}

function getRootDirPolicySetting() {
  return getBurnsSmithersRuntimeDefaults().rootDirPolicy
}

function getSmithersPortBase() {
  return parseEnvInt(process.env.BURNS_SMITHERS_PORT_BASE, DEFAULT_SMITHERS_PORT_BASE, 1)
}

function getMaxWorkspaceInstances() {
  return parseEnvInt(
    process.env.BURNS_SMITHERS_MAX_WORKSPACE_INSTANCES,
    DEFAULT_SMITHERS_MAX_WORKSPACE_INSTANCES,
    1
  )
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })

    server.listen(port)
  })
}

async function allocatePort(record: SmithersInstanceRecord) {
  const portBase = getSmithersPortBase()
  const maxInstances = getMaxWorkspaceInstances()
  const usedPorts = new Set<number>()

  for (const [workspaceId, instance] of instances.entries()) {
    if (workspaceId === record.workspaceId) {
      continue
    }

    if (instance.port !== null && instance.status !== "stopped") {
      usedPorts.add(instance.port)
    }
  }

  if (record.port !== null && !usedPorts.has(record.port)) {
    const samePortAvailable = await isPortAvailable(record.port)
    if (samePortAvailable) {
      return record.port
    }
  }

  for (let offset = 0; offset < maxInstances; offset += 1) {
    const candidate = portBase + offset
    if (usedPorts.has(candidate)) {
      continue
    }

    const available = await isPortAvailable(candidate)
    if (available) {
      record.port = candidate
      return candidate
    }
  }

  throw new Error("No available Smithers port found for workspace instance")
}

async function waitForHealthy(baseUrl: string, timeoutMs = 12_000) {
  const deadlineMs = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/runs?limit=1`)
      if (response.ok) {
        return
      }

      lastError = new Error(`Health check returned status ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(200)
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for Smithers server")
}

async function probeSmithersHeartbeat(baseUrl: string, timeoutMs = HEARTBEAT_PROBE_TIMEOUT_MS) {
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort()
  }, timeoutMs)
  timeout.unref()

  try {
    const response = await fetch(`${baseUrl}/v1/runs?limit=1`, {
      signal: abortController.signal,
    })

    if (!response.ok) {
      return null
    }

    return new Date().toISOString()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function computeRestartDelayMs(crashStreak: number) {
  const boundedCrashStreak = Math.min(Math.max(crashStreak, 1), 6)
  return Math.min(30_000, 1_000 * 2 ** (boundedCrashStreak - 1))
}

function wireProcessLogs(record: SmithersInstanceRecord, child: ChildProcess) {
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      logger.debug(
        {
          event: "smithers.instance.stdout",
          workspaceId: record.workspaceId,
          pid: child.pid,
          line,
        },
        "Smithers workspace stdout"
      )
    }
  })

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      logger.warn(
        {
          event: "smithers.instance.stderr",
          workspaceId: record.workspaceId,
          pid: child.pid,
          line,
        },
        "Smithers workspace stderr"
      )
    }
  })
}

function scheduleRestart(record: SmithersInstanceRecord) {
  if (record.restartTimer || shuttingDown || record.stopRequested) {
    return
  }

  record.restartCount += 1
  const delayMs = computeRestartDelayMs(record.crashStreak)
  record.restartTimer = setTimeout(() => {
    record.restartTimer = undefined
    void startRecord(record).catch((error) => {
      logger.error(
        {
          event: "smithers.instance.restart_failed",
          workspaceId: record.workspaceId,
          err: error,
        },
        "Failed restarting Smithers workspace process"
      )
    })
  }, delayMs)

  record.restartTimer.unref()

  logger.warn(
    {
      event: "smithers.instance.restart_scheduled",
      workspaceId: record.workspaceId,
      delayMs,
      restartCount: record.restartCount,
      crashCount: record.crashCount,
    },
    "Scheduled Smithers workspace restart"
  )
}

function onProcessExit(record: SmithersInstanceRecord, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
  if (record.process?.pid === child.pid) {
    record.process = null
  }

  if (record.stopRequested || shuttingDown) {
    record.status = "stopped"
    return
  }

  record.crashCount += 1
  record.crashStreak += 1
  record.status = "crashed"

  logger.warn(
    {
      event: "smithers.instance.exited",
      workspaceId: record.workspaceId,
      pid: child.pid,
      code,
      signal,
    },
    "Smithers workspace process exited unexpectedly"
  )

  scheduleRestart(record)
}

function getDbPath(workspacePath: string) {
  return getManagedSmithersDbPath(workspacePath)
}

async function startRecord(record: SmithersInstanceRecord) {
  if (
    record.process &&
    record.status === "healthy" &&
    record.process.exitCode === null &&
    record.process.signalCode === null
  ) {
    return
  }

  if (record.startPromise) {
    await record.startPromise
    return
  }

  record.startPromise = (async () => {
    record.stopRequested = false
    if (record.restartTimer) {
      clearTimeout(record.restartTimer)
      record.restartTimer = undefined
    }

    if (!existsSync(record.workspace.path)) {
      throw new Error(`Workspace path does not exist: ${record.workspace.path}`)
    }

    const port = await allocatePort(record)
    ensureWorkspaceSmithersLayout(record.workspace.path)
    const dbPath = getDbPath(record.workspace.path)
    const baseUrl = `http://127.0.0.1:${port}`
    const env = {
      ...process.env,
      BURNS_SMITHERS_WORKSPACE_ID: record.workspaceId,
      BURNS_SMITHERS_WORKSPACE_PATH: record.workspace.path,
      BURNS_SMITHERS_DB_PATH: dbPath,
      BURNS_SMITHERS_PORT: String(port),
      BURNS_SMITHERS_ALLOW_NETWORK: getAllowNetworkSetting() ? "1" : "0",
      BURNS_SMITHERS_MAX_BODY_BYTES: String(getMaxBodyBytesSetting()),
      BURNS_SMITHERS_ROOT_DIR_POLICY: getRootDirPolicySetting(),
      BURNS_DAEMON_PID: String(process.pid),
    } satisfies NodeJS.ProcessEnv

    mkdirSync(path.dirname(dbPath), { recursive: true })

    const child = spawn(resolveBunExecutable(), [runnerScriptPath], {
      cwd: record.workspace.path,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    record.process = child
    record.dbPath = dbPath
    record.baseUrl = baseUrl
    record.status = "starting"

    wireProcessLogs(record, child)
    child.once("exit", (code, signal) => onProcessExit(record, child, code, signal))
    child.once("error", (error) => {
      logger.error(
        {
          event: "smithers.instance.process_error",
          workspaceId: record.workspaceId,
          pid: child.pid,
          err: error,
        },
        "Smithers workspace process emitted error"
      )
    })

    logger.info(
      {
        event: "smithers.instance.starting",
        workspaceId: record.workspaceId,
        workspacePath: record.workspace.path,
        port,
      },
      "Starting Smithers workspace process"
    )

    try {
      await waitForHealthy(baseUrl)
      record.status = "healthy"
      record.crashStreak = 0
      record.lastHeartbeatAt = new Date().toISOString()
    } catch (error) {
      if (record.process?.pid === child.pid) {
        record.process.kill("SIGTERM")
      }

      record.status = "crashed"
      scheduleRestart(record)
      throw error
    }
  })()

  try {
    await record.startPromise
  } finally {
    record.startPromise = undefined
  }
}

function getOrCreateRecord(workspace: Workspace) {
  const existing = instances.get(workspace.id)
  if (existing) {
    existing.workspace = workspace
    return existing
  }

  const record: SmithersInstanceRecord = {
    workspace,
    workspaceId: workspace.id,
    port: null,
    baseUrl: null,
    dbPath: null,
    process: null,
    status: "stopped",
    restartCount: 0,
    crashCount: 0,
    crashStreak: 0,
    lastHeartbeatAt: null,
    stopRequested: false,
  }
  instances.set(workspace.id, record)
  return record
}

async function stopProcess(child: ChildProcess, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise<void>((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) {
        return
      }

      finished = true
      resolve()
    }

    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
      }
      finish()
    }, timeoutMs)

    timer.unref()

    child.once("exit", () => {
      clearTimeout(timer)
      finish()
    })

    child.kill("SIGTERM")
  })
}

function parsePortFromBaseUrl(baseUrl: string | null) {
  if (!baseUrl) {
    return null
  }

  try {
    const url = new URL(baseUrl)
    if (url.port) {
      return Number(url.port)
    }

    return url.protocol === "https:" ? 443 : 80
  } catch {
    return null
  }
}

function toWorkspaceServerStatus(
  workspace: Workspace,
  params: {
    processState: WorkspaceServerProcessState
    lastHeartbeatAt: string | null
    restartCount: number
    crashCount: number
    port: number | null
    baseUrl: string | null
  }
): WorkspaceServerStatus {
  return {
    workspaceId: workspace.id,
    runtimeMode: workspace.runtimeMode,
    processState: params.processState,
    lastHeartbeatAt: params.lastHeartbeatAt,
    restartCount: params.restartCount,
    crashCount: params.crashCount,
    port: params.port,
    baseUrl: params.baseUrl,
  }
}

async function toSelfManagedStatus(workspace: Workspace) {
  const baseUrl = workspace.smithersBaseUrl ?? null
  const lastHeartbeatAt = baseUrl ? await probeSmithersHeartbeat(baseUrl) : null
  return toWorkspaceServerStatus(workspace, {
    processState: "self-managed",
    lastHeartbeatAt,
    restartCount: 0,
    crashCount: 0,
    port: parsePortFromBaseUrl(baseUrl),
    baseUrl,
  })
}

function toDisabledStatus(workspace: Workspace) {
  const baseUrl = resolveFallbackBaseUrl()
  return toWorkspaceServerStatus(workspace, {
    processState: "disabled",
    lastHeartbeatAt: null,
    restartCount: 0,
    crashCount: 0,
    port: parsePortFromBaseUrl(baseUrl),
    baseUrl,
  })
}

function toManagedRecordStatus(record: SmithersInstanceRecord) {
  return toWorkspaceServerStatus(record.workspace, {
    processState: record.status,
    lastHeartbeatAt: record.lastHeartbeatAt,
    restartCount: record.restartCount,
    crashCount: record.crashCount,
    port: record.port,
    baseUrl: record.baseUrl,
  })
}

async function refreshManagedRecordHeartbeat(record: SmithersInstanceRecord) {
  if (!record.baseUrl) {
    return
  }

  if (record.status !== "healthy" && record.status !== "starting") {
    return
  }

  const heartbeatAt = await probeSmithersHeartbeat(record.baseUrl)
  if (!heartbeatAt) {
    return
  }

  record.lastHeartbeatAt = heartbeatAt
  record.status = "healthy"
}

function assertWorkspaceRecord(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

async function stopRecord(record: SmithersInstanceRecord) {
  record.stopRequested = true

  if (record.restartTimer) {
    clearTimeout(record.restartTimer)
    record.restartTimer = undefined
  }

  const child = record.process
  record.process = null

  if (child) {
    await stopProcess(child)
  }

  record.baseUrl = null
  record.port = null
  record.lastHeartbeatAt = null
  record.status = "stopped"
}

export function isWorkspaceSmithersManaged() {
  return isManagedModeEnabled()
}

export function getSmithersBaseUrlSettingValue() {
  return resolveFallbackBaseUrl()
}

export function getWorkspaceSmithersRuntimeConfig(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)
  const record = instances.get(workspaceId)
  const managedBaseUrl =
    workspace.runtimeMode === "burns-managed" && isManagedModeEnabled() ? (record?.baseUrl ?? null) : null

  return resolveWorkspaceSmithersRuntimeConfig(workspace, { managedBaseUrl })
}

export function startWorkspaceSmithersInBackground(workspace: Workspace) {
  if (workspace.runtimeMode === "self-managed") {
    return
  }

  if (!isManagedModeEnabled()) {
    return
  }

  void ensureWorkspaceSmithersBaseUrl(workspace).catch((error) => {
    logger.error(
      {
        event: "smithers.instance.start_background_failed",
        workspaceId: workspace.id,
        err: error,
      },
      "Failed starting workspace Smithers instance in background"
    )
  })
}

export async function ensureWorkspaceSmithersBaseUrl(workspace: Workspace) {
  if (workspace.runtimeMode === "self-managed") {
    if (!workspace.smithersBaseUrl) {
      throw new Error(`Self-managed workspace ${workspace.id} is missing smithersBaseUrl`)
    }

    return workspace.smithersBaseUrl
  }

  if (!isManagedModeEnabled()) {
    return resolveFallbackBaseUrl()
  }

  const record = getOrCreateRecord(workspace)
  await startRecord(record)
  if (!record.baseUrl) {
    throw new Error(`No Smithers base URL available for workspace ${workspace.id}`)
  }

  return record.baseUrl
}

export async function getWorkspaceSmithersServerStatus(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)

  if (workspace.runtimeMode === "self-managed") {
    return await toSelfManagedStatus(workspace)
  }

  if (!isManagedModeEnabled()) {
    return toDisabledStatus(workspace)
  }

  const record = getOrCreateRecord(workspace)
  await refreshManagedRecordHeartbeat(record)
  return toManagedRecordStatus(record)
}

export async function startWorkspaceSmithersServer(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)

  if (workspace.runtimeMode === "self-managed") {
    return await toSelfManagedStatus(workspace)
  }

  if (!isManagedModeEnabled()) {
    return toDisabledStatus(workspace)
  }

  const record = getOrCreateRecord(workspace)
  await startRecord(record)
  return toManagedRecordStatus(record)
}

export async function restartWorkspaceSmithersServer(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)

  if (workspace.runtimeMode === "self-managed") {
    return await toSelfManagedStatus(workspace)
  }

  if (!isManagedModeEnabled()) {
    return toDisabledStatus(workspace)
  }

  const record = getOrCreateRecord(workspace)
  record.restartCount += 1
  await stopRecord(record)
  record.stopRequested = false
  await startRecord(record)
  return toManagedRecordStatus(record)
}

export async function stopWorkspaceSmithersServer(workspaceId: string) {
  const workspace = assertWorkspaceRecord(workspaceId)

  if (workspace.runtimeMode === "self-managed") {
    return await toSelfManagedStatus(workspace)
  }

  if (!isManagedModeEnabled()) {
    return toDisabledStatus(workspace)
  }

  const record = getOrCreateRecord(workspace)
  await stopRecord(record)
  return toManagedRecordStatus(record)
}

export function dropWorkspaceSmithersRecord(workspaceId: string) {
  const record = instances.get(workspaceId)
  if (!record) {
    return
  }

  if (record.restartTimer) {
    clearTimeout(record.restartTimer)
    record.restartTimer = undefined
  }

  record.process = null
  instances.delete(workspaceId)
}

export async function warmWorkspaceSmithersInstances(workspaces: Workspace[]) {
  if (!isManagedModeEnabled() || workspaces.length === 0) {
    return
  }

  const managedWorkspaces = workspaces.filter((workspace) => workspace.runtimeMode !== "self-managed")
  const existingWorkspacePaths = managedWorkspaces.filter((workspace) => existsSync(workspace.path))
  const skippedCount = managedWorkspaces.length - existingWorkspacePaths.length

  if (existingWorkspacePaths.length === 0) {
    return
  }

  if (skippedCount > 0) {
    logger.info(
      {
        event: "smithers.instance.warm_skipped_disconnected",
        skippedCount,
        total: managedWorkspaces.length,
      },
      "Skipped warming disconnected workspaces"
    )
  }

  const results = await Promise.allSettled(
    existingWorkspacePaths.map(async (workspace) => {
      await ensureWorkspaceSmithersBaseUrl(workspace)
    })
  )

  const failedCount = results.filter((result) => result.status === "rejected").length
  if (failedCount > 0) {
    logger.warn(
      {
        event: "smithers.instance.warm_partial_failure",
        failedCount,
        total: existingWorkspacePaths.length,
      },
      "Failed to warm one or more Smithers workspace instances"
    )
  }
}

export async function shutdownWorkspaceSmithersInstances() {
  shuttingDown = true

  const stopTasks = [...instances.values()].map(async (record) => {
    await stopRecord(record)
  })

  await Promise.allSettled(stopTasks)
}

export async function reconcileManagedWorkspaceRuntimeAfterSettingsChange(
  previousSettings: Settings,
  nextSettings: Settings
): Promise<SettingsReconcileSummary> {
  const managedRuntimeSettingsChanged = haveManagedRuntimeSettingsChanged(previousSettings, nextSettings)
  const managedModeChanged =
    previousSettings.smithersManagedPerWorkspace !== nextSettings.smithersManagedPerWorkspace

  if (!managedRuntimeSettingsChanged) {
    return {
      managedRuntimeSettingsChanged,
      managedModeChanged,
      affectedManagedWorkspaces: 0,
      restartedManagedWorkspaces: 0,
      stoppedManagedWorkspaces: 0,
      daemonSettingsChanged: false,
      daemonRestartScheduled: false,
    }
  }

  const activeManagedRecords = [...instances.values()].filter(
    (record) => record.workspace.runtimeMode !== "self-managed" && (record.status !== "stopped" || record.process !== null)
  )

  if (!nextSettings.smithersManagedPerWorkspace) {
    const stopResults = await Promise.allSettled(
      activeManagedRecords.map(async (record) => {
        await stopRecord(record)
      })
    )

    return {
      managedRuntimeSettingsChanged,
      managedModeChanged,
      affectedManagedWorkspaces: activeManagedRecords.length,
      restartedManagedWorkspaces: 0,
      stoppedManagedWorkspaces: stopResults.filter((result) => result.status === "fulfilled").length,
      daemonSettingsChanged: false,
      daemonRestartScheduled: false,
    }
  }

  if (!previousSettings.smithersManagedPerWorkspace) {
    return {
      managedRuntimeSettingsChanged,
      managedModeChanged,
      affectedManagedWorkspaces: 0,
      restartedManagedWorkspaces: 0,
      stoppedManagedWorkspaces: 0,
      daemonSettingsChanged: false,
      daemonRestartScheduled: false,
    }
  }

  const restartResults = await Promise.allSettled(
    activeManagedRecords.map(async (record) => {
      record.restartCount += 1
      await stopRecord(record)
      record.stopRequested = false
      await startRecord(record)
    })
  )

  return {
    managedRuntimeSettingsChanged,
    managedModeChanged,
    affectedManagedWorkspaces: activeManagedRecords.length,
    restartedManagedWorkspaces: restartResults.filter((result) => result.status === "fulfilled").length,
    stoppedManagedWorkspaces: 0,
    daemonSettingsChanged: false,
    daemonRestartScheduled: false,
  }
}
