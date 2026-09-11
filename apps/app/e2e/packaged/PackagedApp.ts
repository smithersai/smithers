import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 5_000
const EVAL_RETRY_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 8_000
const MAX_LOG_CHARACTERS = 512_000

export interface LaunchAppOptions {
  readonly executable: string
  readonly stateDirectory?: string
  readonly artifactsDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly startupTimeoutMs?: number
}

export interface PackagedAppState {
  readonly app: {
    readonly pid: number
    readonly origin: string
    readonly packaged: boolean
    readonly channel: string
    readonly defaultRenderer: string
  }
  readonly window: null | {
    readonly id: number
    readonly webviewId: number
    readonly renderer: string
    readonly url: string | null
    readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  }
}

interface BridgeEvalResponse<T> {
  readonly result: T | null
  readonly valueUndefined?: boolean
}

interface ProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface OwnedProcess {
  readonly pid: number
  readonly group: number
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const safeLabel = (label: string): string =>
  label.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "diagnostic"

const availableLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close()
        reject(new Error("The operating system did not allocate a loopback port."))
        return
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })

const normalizeEvalScript = (script: string): string => {
  const trimmed = script.trim()
  if (trimmed === "") return "return undefined"
  try {
    // Syntax-check locally only. Expression-shaped input gets its completion
    // value; statement-shaped input can use an explicit return.
    new Function(`return (\n${trimmed}\n)`)
    return `return (\n${trimmed}\n)`
  } catch {
    return trimmed
  }
}

const processExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

export class PackagedApp {
  readonly executable: string
  readonly artifactsDirectory: string
  readonly stateDirectory: string

  private readonly temporaryRoot: string
  private readonly processEnv: Readonly<Record<string, string>>
  private readonly startupTimeoutMs: number
  private child: ChildProcess | undefined
  private exit: Promise<ProcessExit> | undefined
  private processGroup: number | undefined
  private bridgePort: number | undefined
  private bridgeToken: string | undefined
  private readyPromise: Promise<void> | undefined
  private logBuffer = ""
  private launchNumber = 0
  private cleaned = false

  private constructor(
    options: LaunchAppOptions,
    temporaryRoot: string,
    stateDirectory: string,
    artifactsDirectory: string
  ) {
    this.executable = resolve(options.executable)
    this.temporaryRoot = temporaryRoot
    this.stateDirectory = stateDirectory
    this.artifactsDirectory = artifactsDirectory
    this.processEnv = options.env ?? {}
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  }

  static async launch(options: LaunchAppOptions): Promise<PackagedApp> {
    const executable = resolve(options.executable)
    await access(executable, constants.X_OK).catch(() => {
      throw new Error(`Packaged Electrobun executable is missing or not executable: ${executable}`)
    })

    const temporaryRoot = await mkdtemp(join(tmpdir(), "smithers-electrobun-e2e-"))
    const stateDirectory = resolve(options.stateDirectory ?? join(temporaryRoot, "home"))
    const artifactsDirectory = resolve(
      options.artifactsDirectory ?? join(process.cwd(), "test-results", "electrobun-packaged")
    )
    await Promise.all([
      mkdir(stateDirectory, { recursive: true }),
      mkdir(join(temporaryRoot, "tmp"), { recursive: true }),
      mkdir(join(stateDirectory, ".cache"), { recursive: true }),
      mkdir(join(stateDirectory, ".config"), { recursive: true }),
      mkdir(join(stateDirectory, ".local", "share"), { recursive: true }),
      mkdir(artifactsDirectory, { recursive: true })
    ])

    const app = new PackagedApp(
      { ...options, executable },
      temporaryRoot,
      stateDirectory,
      artifactsDirectory
    )
    try {
      await app.startProcess()
      return app
    } catch (error) {
      try {
        await app.cleanup()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Packaged app launch and cleanup both failed.")
      }
      throw error
    }
  }

  get bridgeOrigin(): string {
    if (this.bridgePort === undefined) throw new Error("The E2E bridge has not started.")
    return `http://127.0.0.1:${this.bridgePort}`
  }

  logs(): string {
    return this.logBuffer
  }

  private appendLog(stream: "runner" | "stdout" | "stderr", text: string): void {
    const prefixed = text.split(/(?<=\n)/).map((line) => line === "" ? "" : `[${stream}] ${line}`).join("")
    this.logBuffer += prefixed
    if (this.logBuffer.length > MAX_LOG_CHARACTERS) this.logBuffer = this.logBuffer.slice(-MAX_LOG_CHARACTERS)
    if (process.env.SMITHERS_E2E_VERBOSE === "1") process.stderr.write(prefixed)
  }

  private async startProcess(): Promise<void> {
    if (this.cleaned) throw new Error("A cleaned-up packaged app cannot be relaunched.")
    if (this.child !== undefined && !processExited(this.child)) throw new Error("The packaged app is already running.")

    this.launchNumber += 1
    this.bridgePort = await availableLoopbackPort()
    this.bridgeToken = randomBytes(32).toString("base64url")
    this.readyPromise = undefined
    this.appendLog("runner", `launch ${this.launchNumber}: ${this.executable}\n`)

    const tmpDirectory = join(this.temporaryRoot, "tmp")
    const protectedEnv: NodeJS.ProcessEnv = {
      HOME: this.stateDirectory,
      CFFIXED_USER_HOME: this.stateDirectory,
      TMPDIR: tmpDirectory,
      XDG_CACHE_HOME: join(this.stateDirectory, ".cache"),
      XDG_CONFIG_HOME: join(this.stateDirectory, ".config"),
      XDG_DATA_HOME: join(this.stateDirectory, ".local", "share"),
      SMITHERS_E2E_BRIDGE: "1",
      SMITHERS_E2E_BRIDGE_PORT: String(this.bridgePort),
      SMITHERS_E2E_BRIDGE_TOKEN: this.bridgeToken,
      SMITHERS_LOCAL_PORT: undefined,
      SMITHERS_LOCAL_MODE: "offline",
      SMITHERS_CHAT_STUB: "1",
      ELECTROBUN_CONSOLE: "1",
      NO_COLOR: "1"
    }
    const child = spawn(this.executable, [], {
      cwd: dirname(this.executable),
      detached: process.platform !== "win32",
      env: { ...process.env, ...this.processEnv, ...protectedEnv },
      stdio: ["ignore", "pipe", "pipe"]
    })
    this.child = child
    this.processGroup = process.platform === "win32" ? undefined : child.pid
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.appendLog("stdout", chunk))
    child.stderr?.on("data", (chunk: string) => this.appendLog("stderr", chunk))
    child.once("error", (error) => this.appendLog("runner", `spawn error: ${error.message}\n`))
    this.exit = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.appendLog("runner", `exit: code=${String(code)} signal=${String(signal)}\n`)
        resolveExit({ code, signal })
      })
    })
  }

  private async request<T>(
    path: string,
    decode: (body: Uint8Array) => T,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (this.bridgeToken === undefined) throw new Error("The E2E bridge token is unavailable.")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancelBody = (): void => { void reader?.cancel().catch(() => undefined) }
    try {
      const response = await fetch(`${this.bridgeOrigin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.bridgeToken}`,
          ...init.headers
        },
        signal: controller.signal
      })
      reader = response.body?.getReader()
      controller.signal.addEventListener("abort", cancelBody, { once: true })
      controller.signal.throwIfAborted()
      const chunks: Array<Uint8Array> = []
      let size = 0
      if (reader !== undefined) {
        while (true) {
          const { done, value } = await reader.read()
          controller.signal.throwIfAborted()
          if (done) break
          chunks.push(value)
          size += value.byteLength
        }
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      if (!response.ok) {
        const message = new TextDecoder().decode(body) || response.statusText
        throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${message}`)
      }
      return decode(body)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${init.method ?? "GET"} ${path} timed out after ${timeoutMs}ms.`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", cancelBody)
      cancelBody()
      reader?.releaseLock()
    }
  }

  private async json<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return this.request(path, (body) => JSON.parse(new TextDecoder().decode(body)) as T, init, timeoutMs)
  }

  async ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise
    this.readyPromise = this.waitUntilReady()
    return this.readyPromise
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (this.child === undefined || processExited(this.child)) {
        const exited = this.exit === undefined ? undefined : await this.exit
        throw new Error(`Packaged app exited during startup (${JSON.stringify(exited)}).\n${this.logs()}`)
      }
      try {
        const health = await this.json<{ readonly ok?: boolean }>("/health")
        if (health.ok !== true) throw new Error("The E2E bridge reported unhealthy.")
        const state = await this.state()
        if (state.window === null) throw new Error("The main window has not been created.")
        const documentState = await this.evalReadOnly<{ readonly readyState: string; readonly bodyPresent: boolean }>(`
          ({ readyState: document.readyState, bodyPresent: document.body !== null })
        `, Math.max(1, deadline - Date.now()))
        if (documentState.bodyPresent && documentState.readyState !== "loading") return
      } catch (error) {
        lastError = error
      }
      await delay(200)
    }
    throw new Error(
      `Packaged app did not become ready within ${this.startupTimeoutMs}ms: ${String(lastError)}\n${this.logs()}`
    )
  }

  async state(): Promise<PackagedAppState> {
    return this.json<PackagedAppState>("/state")
  }

  private async evaluateOnce<T>(script: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await this.json<BridgeEvalResponse<T>>("/window/eval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: normalizeEvalScript(script) })
    }, timeoutMs)
    return (response.valueUndefined === true ? undefined : response.result) as T
  }

  /** Runs a potentially mutating script once. A failed reply does not prove non-execution. */
  async eval<T = unknown>(script: string): Promise<T> {
    try {
      return await this.evaluateOnce<T>(script)
    } catch (error) {
      throw new Error(`Renderer evaluation outcome is unknown; the script was not retried: ${String(error)}`, {
        cause: error
      })
    }
  }

  /** Only use for reads that are safe to execute again after a lost reply. */
  async evalReadOnly<T = unknown>(script: string, timeoutMs = EVAL_RETRY_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        return await this.evaluateOnce<T>(script, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Native WKWebView can lose an RPC reply after executing the script.
        // Only explicitly read-only evaluations may repeat that execution.
        const transient = message.includes("POST /window/eval timed out") ||
          message.includes("\"message\":\"RPC request timed out.")
        if (!transient) throw error
        lastError = error
        await delay(Math.min(250, Math.max(0, deadline - Date.now())))
      }
    }
    throw new Error(`Renderer evaluation did not recover within ${timeoutMs}ms: ${String(lastError)}`)
  }

  /** Answers the next real native folder-picker RPC; null exercises cancel. */
  async queueRepositorySelection(path: string | null): Promise<void> {
    await this.json<{ readonly ok: true }>("/window/repository-picker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path === null ? null : resolve(path) })
    })
  }

  /** Polls a read-only expression; the script must be safe to repeat. */
  async waitFor<T>(
    script: string,
    predicate: (value: T) => boolean = (value) => Boolean(value),
    timeoutMs = 15_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let lastValue: T | undefined
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        lastValue = await this.evalReadOnly<T>(script, Math.max(1, deadline - Date.now()))
        if (predicate(lastValue)) return lastValue
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    throw new Error(
      `Renderer condition did not pass within ${timeoutMs}ms. Last value: ${JSON.stringify(lastValue)}. Last error: ${
        String(lastError)
      }`
    )
  }

  async unauthorizedStatus(path = "/health"): Promise<number> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return (await fetch(`${this.bridgeOrigin}${path}`, { signal: controller.signal })).status
    } finally {
      clearTimeout(timeout)
    }
  }

  async screenshot(name = `launch-${this.launchNumber}.png`): Promise<string> {
    const bytes = await this.request("/window/screenshot", (body) => body)
    const path = join(this.artifactsDirectory, safeLabel(name.endsWith(".png") ? name : `${name}.png`))
    await writeFile(path, bytes)
    return path
  }

  async captureDiagnostics(label: string): Promise<void> {
    const stem = safeLabel(label)
    await mkdir(this.artifactsDirectory, { recursive: true })
    await writeFile(join(this.artifactsDirectory, `${stem}.log`), this.logs())
    await this.state()
      .then((value) =>
        writeFile(join(this.artifactsDirectory, `${stem}-state.json`), `${JSON.stringify(value, null, 2)}\n`)
      )
      .catch(() => undefined)
    await this.evalReadOnly(`
      ({
        title: document.title,
        url: location.href,
        bodyText: document.body?.innerText ?? '',
        testIds: Array.from(document.querySelectorAll('[data-testid]'), (node) => node.getAttribute('data-testid')),
        cards: Array.from(document.querySelectorAll('.smithers-card'), (node) => ({
          kind: node.getAttribute('data-kind'),
          text: node.textContent
        }))
      })
    `)
      .then((value) =>
        writeFile(join(this.artifactsDirectory, `${stem}-renderer.json`), `${JSON.stringify(value, null, 2)}\n`)
      )
      .catch(() => undefined)
    await this.screenshot(`${stem}.png`).catch(() => undefined)
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child === undefined || processExited(this.child)) return true
    if (this.exit === undefined) return false
    return Promise.race([
      this.exit.then(() => true),
      delay(timeoutMs).then(() => false)
    ])
  }

  private signalProcess(signal: NodeJS.Signals): void {
    const child = this.child
    if (child === undefined || processExited(child) || child.pid === undefined) return
    try {
      if (this.processGroup === undefined) child.kill(signal)
      else process.kill(-this.processGroup, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // It exited between the checks.
      }
    }
  }

  private async processGroupMembers(): Promise<Array<OwnedProcess>> {
    const group = this.processGroup
    if (group === undefined || group <= 1) return []
    const child = Bun.spawn(["/bin/ps", "-axo", "pid=,pgid=,command="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    if (exitCode !== 0) throw new Error(`Could not inspect packaged app process group: ${stderr.trim()}`)
    return stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+/.exec(line)
      if (match === null) return []
      const pid = Number(match[1])
      const candidateGroup = Number(match[2])
      return candidateGroup === group && pid !== process.pid && Number.isSafeInteger(pid)
        ? [{ pid, group }]
        : []
    })
  }

  private async terminateProcessGroup(): Promise<void> {
    let remaining = await this.processGroupMembers()
    if (remaining.length === 0) {
      this.processGroup = undefined
      return
    }
    this.appendLog(
      "runner",
      `terminating residual process-group pid(s): ${remaining.map(({ pid }) => pid).join(", ")}\n`
    )
    const signal = (value: NodeJS.Signals): void => {
      const group = this.processGroup
      if (group === undefined) return
      try {
        process.kill(-group, value)
      } catch {
        // The final descendant exited between inspection and the signal.
      }
    }
    signal("SIGTERM")
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100)
      remaining = await this.processGroupMembers()
      if (remaining.length === 0) {
        this.processGroup = undefined
        return
      }
    }
    signal("SIGKILL")
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100)
      remaining = await this.processGroupMembers()
      if (remaining.length === 0) {
        this.processGroup = undefined
        return
      }
    }
    throw new Error(
      `Packaged app process-group member(s) survived cleanup: ${remaining.map(({ pid }) => pid).join(", ")}`
    )
  }

  async quit(): Promise<void> {
    if (this.child !== undefined && !processExited(this.child)) {
      await this.request("/app/quit", () => undefined, { method: "POST" }).catch(() => undefined)
      if (!await this.waitForExit(EXIT_TIMEOUT_MS)) {
        this.signalProcess("SIGTERM")
        if (!await this.waitForExit(EXIT_TIMEOUT_MS)) {
          this.signalProcess("SIGKILL")
          if (!await this.waitForExit(EXIT_TIMEOUT_MS)) {
            throw new Error(`Packaged app process group did not terminate.\n${this.logs()}`)
          }
        }
      }
    }
    // Electrobun's launcher can exit before probes or PTYs inherited from the
    // backend. Drain the detached launch group before deleting isolated HOME.
    await this.terminateProcessGroup()
  }

  async relaunch(): Promise<void> {
    await this.quit()
    await this.startProcess()
    await this.ready()
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return
    await this.quit()
    this.cleaned = true
    const expectedPrefix = join(tmpdir(), "smithers-electrobun-e2e-")
    if (!this.temporaryRoot.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected temporary path: ${this.temporaryRoot}`)
    }
    await rm(this.temporaryRoot, { recursive: true, force: true })
  }
}

export const launchApp = (options: LaunchAppOptions): Promise<PackagedApp> => PackagedApp.launch(options)

interface ProductionCandidate {
  readonly executable: string
  readonly modifiedAt: number
}

const productionCandidate = async (bundle: string): Promise<ProductionCandidate | undefined> => {
  const resources = join(bundle, "Contents", "Resources")
  try {
    const metadata = JSON.parse(await readFile(join(resources, "metadata.json"), "utf8")) as {
      readonly channel?: unknown
      readonly hash?: unknown
      readonly identifier?: unknown
    }
    if (
      metadata.channel !== "stable" || metadata.identifier !== "sh.smithers.app" ||
      typeof metadata.hash !== "string" || !/^[a-z0-9]+$/.test(metadata.hash)
    ) {
      return undefined
    }
    await access(join(resources, `${metadata.hash}.tar.zst`), constants.R_OK)
    const executable = join(bundle, "Contents", "MacOS", "launcher")
    await access(executable, constants.X_OK)
    return { executable, modifiedAt: (await stat(executable)).mtimeMs }
  } catch {
    return undefined
  }
}

/** Finds the validated production bundle at the root of a mounted stable DMG. */
export const findMountedProductionAppExecutable = async (mountDirectory: string): Promise<string> => {
  const candidates: Array<ProductionCandidate> = []
  for (const entry of await readdir(mountDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue
    const candidate = await productionCandidate(join(mountDirectory, entry.name))
    if (candidate !== undefined) candidates.push(candidate)
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const candidate = candidates[0]
  if (candidate === undefined) {
    throw new Error(`No stable packaged Electrobun launcher found on ${mountDirectory}.`)
  }
  return candidate.executable
}

/** Finds only stable macOS launcher bundles produced by Electrobun. */
export const findProductionAppExecutable = async (uiDirectory: string): Promise<string> => {
  const buildDirectory = join(uiDirectory, "build")
  if (!existsSync(buildDirectory)) throw new Error(`${buildDirectory} does not exist; package the app first.`)
  const platforms = await readdir(buildDirectory, { withFileTypes: true })
  const candidates: Array<ProductionCandidate> = []

  for (const platform of platforms) {
    if (!platform.isDirectory() || !platform.name.startsWith("stable-macos-")) continue
    const platformDirectory = join(buildDirectory, platform.name)
    for (const entry of await readdir(platformDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue
      const bundle = join(platformDirectory, entry.name)
      const candidate = await productionCandidate(bundle)
      if (candidate !== undefined) candidates.push(candidate)
    }
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const candidate = candidates[0]
  if (candidate === undefined) {
    throw new Error(`No stable packaged Electrobun launcher found under ${buildDirectory}.`)
  }
  return candidate.executable
}
