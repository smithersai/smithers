import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (process.platform !== "darwin") throw new Error("The installed native lifecycle test requires macOS.")

const executable = resolve(process.argv[2] ?? process.env.SMITHERS_E2E_EXECUTABLE ?? "")
if (!executable.includes(".app/Contents/MacOS/launcher") || !existsSync(executable)) {
  throw new Error("Pass the installed Smithers.app/Contents/MacOS/launcher executable.")
}
if ((statSync(executable).mode & 0o111) === 0) throw new Error("The installed launcher is not executable.")

const root = mkdtempSync(join(tmpdir(), "smithers-native-owned-"))
const children: Array<ReturnType<typeof Bun.spawn>> = []
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("SMITHERS_") || value === undefined ? [] : [[name, value]])
)

const availablePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) {
      server.close()
      reject(new Error("No loopback port was allocated."))
      return
    }
    server.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
  })
})

interface RunningApp {
  readonly child: ReturnType<typeof Bun.spawn>
  readonly exited: Promise<number>
  readonly logs: () => string
  readonly origin: string
  readonly state: string
  stop(): Promise<void>
}

const launch = async (home: string, mode: "own" | "plue", origin: string): Promise<RunningApp> => {
  mkdirSync(home, { recursive: true })
  const temporary = join(home, "tmp")
  mkdirSync(temporary, { recursive: true })
  let output = ""
  const child = Bun.spawn([executable], {
    cwd: resolve(executable, ".."),
    env: {
      ...cleanEnvironment,
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: temporary,
      SMITHERS_LOCAL_HEADLESS: "1",
      SMITHERS_CHAT_STUB: "0",
      SMITHERS_BACKEND_MODE: mode,
      ...(mode === "own"
        ? { SMITHERS_OWNED_BACKEND_ORIGIN: origin }
        : {
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_BACKEND_BINARY: "/definitely/missing/backend",
          SMITHERS_POSTGRES_BUNDLE_DIR: "/definitely/missing/postgres"
        }),
      ELECTROBUN_CONSOLE: "1",
      NO_COLOR: "1"
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })
  children.push(child)
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
    output += decoder.decode()
  }
  const collectors = Promise.all([collect(child.stdout), collect(child.stderr)])
  const exited = child.exited
  const stop = async (): Promise<void> => {
    const alreadyExited = await Promise.race([exited.then(() => true), Bun.sleep(1).then(() => false)])
    if (!alreadyExited) child.kill("SIGTERM")
    const graceful = await Promise.race([exited.then(() => true), Bun.sleep(20_000).then(() => false)])
    if (!graceful) child.kill("SIGKILL")
    const code = await exited
    await collectors
    if (code !== 0) throw new Error(`Installed app exited ${code}.\n${output}`)
  }
  return {
    child,
    exited,
    logs: () => output,
    origin,
    state: join(home, "Library", "Application Support", "Smithers"),
    stop
  }
}

const waitReady = async (app: RunningApp): Promise<void> => {
  let exitCode: number | undefined
  void app.exited.then((code) => { exitCode = code })
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`Installed app exited ${exitCode} before readiness.\n${app.logs()}`)
    try {
      const response = await fetch(`${app.origin}/readyz`)
      if (response.ok) return
      lastError = new Error(`readyz returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(100)
  }
  throw new Error(`Installed app did not become ready: ${String(lastError)}\n${app.logs()}`)
}

const waitForLog = async (app: RunningApp, text: string): Promise<void> => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (app.logs().includes(text)) return
    const exited = await Promise.race([app.exited.then(() => true), Bun.sleep(100).then(() => false)])
    if (exited && !app.logs().includes(text)) break
  }
  throw new Error(`Installed app never logged ${JSON.stringify(text)}.\n${app.logs()}`)
}

const checksum = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const jsonRequest = async <T>(
  origin: string,
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetch(`${origin}${path}`, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`)
  return JSON.parse(body) as T
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitStopped = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await Bun.sleep(50)
  }
  throw new Error(`Bundled PostgreSQL process ${pid} survived native shutdown.`)
}

try {
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const home = join(root, "owned-home")
  const first = await launch(home, "own", origin)
  await waitReady(first)
  const [index, bootstrap] = await Promise.all([
    fetch(`${origin}/`).then((response) => response.text()),
    fetch(`${origin}/api/bootstrap`).then(async (response) => {
      if (!response.ok) throw new Error(`/api/bootstrap returned ${response.status}`)
      return response.json() as Promise<{ readonly apiVersion?: number }>
    })
  ])
  if (!index.includes('<div id="root"')) throw new Error("The installed backend did not serve the real web application.")
  if (bootstrap.apiVersion !== 1) throw new Error("The installed backend returned an invalid bootstrap document.")
  const secrets = join(first.state, "config", "secrets.json")
  const pgVersion = join(first.state, "postgres", "data", "PG_VERSION")
  const postmasterPID = join(first.state, "postgres", "data", "postmaster.pid")
  if (readFileSync(pgVersion, "utf8").trim() !== "18") throw new Error("The installed app did not initialize PostgreSQL 18.")
  const secretDocument = JSON.parse(readFileSync(secrets, "utf8")) as {
    readonly version?: number
    readonly values?: Readonly<Record<string, string>>
  }
  const bootstrapToken = secretDocument.values?.SMITHERS_AUTH_BOOTSTRAP_TOKEN
  if (secretDocument.version !== 1 || bootstrapToken === undefined || bootstrapToken === "") {
    throw new Error("The installed app did not persist its trusted owner bootstrap token.")
  }
  const owner = "nativeowner"
  const password = "Issue 12 installed native password"
  await jsonRequest(first.origin, "/api/auth/local/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-smithers-bootstrap-token": bootstrapToken
    },
    body: JSON.stringify({ username: owner, email: `${owner}@example.test`, password })
  })
  const credential = await jsonRequest<{ readonly token?: string }>(first.origin, "/api/auth/local/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: owner, password, name: "native-acceptance" })
  })
  if (credential.token === undefined || credential.token === "") {
    throw new Error("The installed app did not issue an owner credential.")
  }
  const repository = await jsonRequest<{ readonly full_name?: string }>(first.origin, "/api/user/repos", {
    method: "POST",
    headers: {
      authorization: `token ${credential.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "native-owned", private: true, auto_init: true })
  })
  if (repository.full_name !== `${owner}/native-owned`) {
    throw new Error("The installed app did not create a repository through the shared backend.")
  }
  const initialSecrets = checksum(secrets)
  const pid = Number.parseInt(readFileSync(postmasterPID, "utf8").split("\n")[0] ?? "", 10)
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("The installed PostgreSQL owner PID is invalid.")
  await first.stop()
  await waitStopped(pid)

  const second = await launch(home, "own", origin)
  await waitReady(second)
  if (checksum(secrets) !== initialSecrets) throw new Error("Native restart replaced the persisted owner secrets.")
  if (readFileSync(pgVersion, "utf8").trim() !== "18") throw new Error("Native restart lost the PostgreSQL cluster.")
  const restoredRepository = await jsonRequest<{ readonly full_name?: string }>(second.origin, `/api/repos/${owner}/native-owned`, {
    headers: { authorization: `token ${credential.token}` }
  })
  if (restoredRepository.full_name !== `${owner}/native-owned`) {
    throw new Error("Native restart lost the repository or owner credential.")
  }
  await second.stop()

  const plueHome = join(root, "plue-home")
  const plue = await launch(plueHome, "plue", "https://plue.invalid")
  await waitForLog(plue, "Smithers app started!")
  await plue.stop()
  if (existsSync(plue.state)) throw new Error("Native Plue mode created local backend or PostgreSQL state.")

  console.log(`NATIVE_ACCEPTANCE_OK executable=${executable} state=${first.state}`)
} finally {
  for (const child of children) {
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1).then(() => false)])
    if (!exited) child.kill("SIGKILL")
  }
  rmSync(root, { recursive: true, force: true })
}
