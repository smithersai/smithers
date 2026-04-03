import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import net from "node:net"

const STARTUP_TIMEOUT_MS = 45_000
const HEALTH_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 10_000
const HEALTH_PATH = "/api/health"
const DEFAULT_DAEMON_PORT = 7332
const SKIP_IF_BUSY_ENV = "BURNS_SMOKE_CLI_SKIP_IF_DAEMON_PORT_BUSY"

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message))
      }, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

function collectProcessOutput(process: ChildProcessWithoutNullStreams) {
  const lines: string[] = []

  const append = (chunk: Buffer) => {
    const text = chunk.toString()
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }
      lines.push(line)
      console.log(`[smoke:cli] ${line}`)
    }
  }

  process.stdout.on("data", append)
  process.stderr.on("data", append)

  return {
    getLines() {
      return [...lines]
    },
    dump() {
      return lines.join("\n")
    },
  }
}

function readUrlFromLogs(lines: string[], prefix: string) {
  const entry = lines.find((line) => line.startsWith(prefix))
  if (!entry) {
    return null
  }

  return entry.slice(prefix.length).trim()
}

async function isPortBusy(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      resolve(false)
    })
  })
}

async function waitForStartupUrls(logs: ReturnType<typeof collectProcessOutput>) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    const lines = logs.getLines()
    const daemonUrl = readUrlFromLogs(lines, "Daemon listening at")
    const webUrl = readUrlFromLogs(lines, "Web UI serving at")

    if (daemonUrl && webUrl) {
      return { daemonUrl, webUrl }
    }

    await delay(250)
  }

  throw new Error(`Timed out waiting for startup URLs. Logs:\n${logs.dump()}`)
}

async function isHealthy(url: string) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHttpOk(url: string, timeoutMs: number) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthy(url)) {
      return
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for healthy URL: ${url}`)
}

async function shutdown(process: ChildProcessWithoutNullStreams, logs: ReturnType<typeof collectProcessOutput>) {
  if (process.exitCode !== null) {
    if (process.exitCode !== 0) {
      throw new Error(`CLI process exited with code ${process.exitCode}. Logs:\n${logs.dump()}`)
    }
    return
  }

  process.kill("SIGTERM")

  const exitCode = await withTimeout(
    new Promise<number>((resolve, reject) => {
      process.once("error", reject)
      process.once("exit", (code) => resolve(code ?? 0))
    }),
    SHUTDOWN_TIMEOUT_MS,
    "Timed out waiting for CLI shutdown"
  )

  if (exitCode !== 0) {
    throw new Error(`CLI process exited with code ${exitCode}. Logs:\n${logs.dump()}`)
  }
}

async function ensureWebBuild() {
  console.log("[smoke:cli] Building web assets for smoke run")
  const build = Bun.spawn(["bun", "run", "build:web"], {
    cwd: process.cwd(),
    stderr: "inherit",
    stdout: "inherit",
  })

  const exitCode = await build.exited
  if (exitCode !== 0) {
    throw new Error(`bun run build:web failed with code ${exitCode}`)
  }
}

async function main() {
  if (await isPortBusy(DEFAULT_DAEMON_PORT)) {
    const message = `Port ${DEFAULT_DAEMON_PORT} is already in use.`
    if (process.env[SKIP_IF_BUSY_ENV] === "1") {
      console.log(`[smoke:cli] ${message} Skipping smoke run because ${SKIP_IF_BUSY_ENV}=1.`)
      return
    }

    throw new Error(
      `${message} Stop the existing daemon or rerun with ${SKIP_IF_BUSY_ENV}=1 to skip this local check.`
    )
  }

  await ensureWebBuild()

  const processHandle = spawn("bun", ["run", "apps/cli/src/bin.ts", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BURNS_SMITHERS_MANAGED_MODE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const logs = collectProcessOutput(processHandle)

  try {
    const { daemonUrl, webUrl } = await waitForStartupUrls(logs)
    await waitForHttpOk(`${daemonUrl}${HEALTH_PATH}`, HEALTH_TIMEOUT_MS)
    await waitForHttpOk(webUrl, HEALTH_TIMEOUT_MS)
    console.log(`[smoke:cli] Daemon healthy at ${daemonUrl}${HEALTH_PATH}`)
    console.log(`[smoke:cli] Web healthy at ${webUrl}`)
  } finally {
    await shutdown(processHandle, logs)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[smoke:cli] ${message}`)
  process.exitCode = 1
})
