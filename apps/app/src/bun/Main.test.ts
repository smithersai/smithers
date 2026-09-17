/*
 * The native main process, apps/app/src/bun/index.ts, asserted for real.
 *
 * It cannot be imported here: it is a top-level-await module that starts the
 * local origin and builds the window as an import side effect, and
 * `electrobun/main` dlopens a native wrapper. So each scenario runs the REAL
 * entrypoint in a subprocess against a recording host fake
 * (e2e/native/MainProcess.ts) and reports what the entrypoint did.
 *
 * Nothing the product decides is faked. The fake supplies only what a
 * headless machine lacks (the window, the directory dialog and the system
 * browser); the local server the entrypoint starts is the real one.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readDaemonDescriptor } from "./LocalDaemonProtocol"
import { shutdownLocalDaemon } from "./LocalDaemonStop"
import { PROBE_MARKER } from "../../e2e/native/Probe.ts"
import type { NativeProbeReport, ProbeScenario } from "../../e2e/native/Probe.ts"

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url))
const DRIVER = realpathSync(join(UI_DIR, "e2e", "native", "MainProcess.ts"))

interface ProbeOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly scenario?: ProbeScenario
}

/*
 * What a scenario leaves running.
 *
 * The entrypoint attaches to a local session owner and spawns it when none is
 * running; by product design that daemon outlives the window, so a probe that
 * only ends its own process leaks one owner per scenario. Each scenario gets
 * its own faked home, so its owner is stopped and its state removed here and
 * nowhere near the user's real session owner.
 */
interface ProbeDaemon {
  readonly home: string
  readonly stateDir: string
  /** The owner process, as its own /api/health reported it. */
  pid: number | null
}

/** Mirrors NativeState.nativeStateDirectory() under the home the driver fakes. */
const stateDirectoryOf = (home: string): string => process.platform === "darwin"
  ? join(home, "Library", "Application Support", "Smithers")
  : join(home, ".local", "share", "smithers")

const reportedPid = (health: unknown): number | null => {
  if (typeof health !== "object" || health === null || !("pid" in health)) return null
  const pid = (health as { readonly pid: unknown }).pid
  return typeof pid === "number" ? pid : null
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Only a pid whose command is still this checkout's driver may be signalled. */
const isProbeProcess = (pid: number): boolean =>
  new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout).includes(DRIVER)

const exited = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 3_000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(50)
  return !alive(pid)
}

/*
 * The belt: the driver stops its own owner, but a probe killed on the deadline
 * never reaches that line. The descriptor in the scenario's own state directory
 * is the only owner this may touch, and its pid is signalled only after the
 * documented shutdown failed to end it.
 */
const stopSessionOwner = async (daemon: ProbeDaemon): Promise<void> => {
  const descriptor = await readDaemonDescriptor(daemon.stateDir).catch(() => undefined)
  if (descriptor !== undefined && daemon.pid === null) {
    daemon.pid = reportedPid(await fetch(`${descriptor.origin}/api/health`).then((response) => response.json()).catch(() => null))
  }
  await shutdownLocalDaemon(daemon.stateDir).catch(() => {})
  const pid = daemon.pid
  if (pid !== null && !(await exited(pid)) && isProbeProcess(pid)) {
    process.kill(pid, "SIGTERM")
    await exited(pid)
  }
  await rm(daemon.home, { recursive: true, force: true })
}

const cache = new Map<string, Promise<NativeProbeReport>>()
const daemons = new Map<string, ProbeDaemon>()

const sessionOwner = (options: ProbeOptions): ProbeDaemon => {
  const daemon = daemons.get(JSON.stringify(options))
  if (daemon === undefined) throw new Error("no probe has run for these options")
  return daemon
}

/*
 * What one probe may take.
 *
 * A probe boots the REAL local origin in a subprocess: a few seconds idle, more
 * on a loaded machine. Under bun's 5s default that lands as a timeout — the
 * runner kills the test, the subprocess it was waiting on keeps its port, and
 * the report says "timed out" instead of what the scenario asserts. Every test
 * below carries this budget instead, and `spawnProbe` kills its own child five
 * seconds inside it, so a slow machine costs one named failure, and the belt
 * below still stops that scenario's session owner before the runner abandons
 * the test.
 */
const PROBE_BUDGET_MS = 60_000
const PROBE_KILL_MS = PROBE_BUDGET_MS - 5_000

const spawnProbe = async (options: ProbeOptions, daemon: ProbeDaemon): Promise<NativeProbeReport> => {
  const child = Bun.spawn([process.execPath, DRIVER], {
    cwd: UI_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_NATIVE_PROBE: JSON.stringify(options.scenario ?? {}),
      SMITHERS_NATIVE_PROBE_HOME: daemon.home,
      SMITHERS_LOCAL_PORT: "0",
      SMITHERS_CHAT_STUB: "1",
      SMITHERS_LOCAL_MODE: "offline",
      ...options.env
    },
    stdout: "pipe",
    stderr: "pipe"
  })
  const overdue = setTimeout(() => child.kill("SIGKILL"), PROBE_KILL_MS)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]).finally(() => clearTimeout(overdue))
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(PROBE_MARKER))
    if (line === undefined) {
      throw new Error(
        `the native main process printed no report (exit ${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
      )
    }
    const report = JSON.parse(line.slice(PROBE_MARKER.length)) as NativeProbeReport
    daemon.pid = reportedPid(report.health)
    return report
  } finally {
    await stopSessionOwner(daemon)
  }
}

/** Scenarios are pure, so identical ones share one subprocess. */
const probe = (options: ProbeOptions): Promise<NativeProbeReport> => {
  const key = JSON.stringify(options)
  const existing = cache.get(key)
  if (existing !== undefined) return existing
  const home = mkdtempSync(join(tmpdir(), "smithers-native-probe-home-"))
  const daemon: ProbeDaemon = { home, stateDir: stateDirectoryOf(home), pid: null }
  daemons.set(key, daemon)
  const started = spawnProbe(options, daemon)
  cache.set(key, started)
  return started
}

const temporaryDirectories: Array<string> = []

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...(Bun.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

/** A throwaway repository, never the working copy this test runs inside. */
const makeRepository = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-main-"))
  temporaryDirectories.push(directory)
  await git(directory, ["init", "-b", "main"])
  await git(directory, [
    "-c",
    "user.email=e2e@smithers.test",
    "-c",
    "user.name=E2E",
    "commit",
    "--allow-empty",
    "-m",
    "root"
  ])
  return directory
}

afterAll(async () => {
  for (const daemon of daemons.values()) {
    await stopSessionOwner(daemon)
  }
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("the native main process starts the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN on 127.0.0.1 and the origin answers /api/health", async () => {
    const report = await probe({})
    expect(report.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(report.health).toMatchObject({ ok: true, sandbox: { platform: process.platform } })
    expect(report.logs).toContain("Smithers app started!")
  }, PROBE_BUDGET_MS)

  test("the window loads the local origin, never views:// and never a dev server", async () => {
    const report = await probe({})
    expect(report.windows).toHaveLength(1)
    expect(report.windows[0]?.url).toBe(`${report.origin}/`)
    expect(report.windows[0]?.title).toBe("Smithers")
    expect(report.windows[0]?.frame).toEqual({ width: 1180, height: 800, x: 100, y: 60 })
    // The seams bind to the window: an unbound rpc is a window whose
    // repository picker and sign-in door are dead.
    expect(report.windows[0]?.rpcBound).toBe(true)
  }, PROBE_BUDGET_MS)

  test("SMITHERS_LOCAL_HEADLESS=1 serves without a window", async () => {
    const report = await probe({ env: { SMITHERS_LOCAL_HEADLESS: "1" } })
    expect(report.windows).toEqual([])
    expect(report.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(report.health).toMatchObject({ ok: true })
    expect(report.logs).toContain("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
  }, PROBE_BUDGET_MS)
})

describe("the native RPC surface", () => {
  test("exactly the two native doors are bound: the folder dialog and the system browser", async () => {
    const report = await probe({})
    expect([...report.requestNames].sort()).toEqual(["openExternal", "pickLocalRepository"])
    expect(report.messageNames).toEqual([])
  }, PROBE_BUDGET_MS)

  test("the repository picker asks the host for a directory, not a file", async () => {
    const report = await probe({
      scenario: {
        dialogPaths: ["/nonexistent-smithers-probe"],
        exercises: [
          { label: "pick", request: "pickLocalRepository", params: { access: "read" } }
        ]
      }
    })
    expect(report.dialogOptions).toEqual([
      { canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false }
    ])
  }, PROBE_BUDGET_MS)

  test("a dismissed directory dialog answers cancelled", async () => {
    for (const dialogPaths of [[], [""], ["   "]]) {
      const report = await probe({
        scenario: {
          dialogPaths,
          exercises: [
            { label: "pick", request: "pickLocalRepository", params: { access: "read" } }
          ]
        }
      })
      expect(report.results.pick).toEqual({ status: "cancelled" })
      expect(report.dialogOptions).toHaveLength(1)
    }
  }, PROBE_BUDGET_MS)

  test("a chosen directory is inspected for real and reports its head and branch", async () => {
    const repository = await makeRepository()
    const report = await probe({
      scenario: {
        dialogPaths: [repository],
        exercises: [
          { label: "pick", request: "pickLocalRepository", params: { access: "read-write" } }
        ]
      }
    })
    const root = await realpath(repository)
    expect(report.results.pick).toMatchObject({
      status: "connected",
      repository: { root, name: basename(root), branch: "main", remoteUrl: null }
    })
    const picked = report.results.pick as { repository: { head: string; authorizationId: string } }
    expect(picked.repository.head).toMatch(/^[0-9a-f]{40}$/)
    expect(picked.repository.authorizationId).toMatch(/^[A-Za-z0-9_-]{43}$/)
  }, PROBE_BUDGET_MS)

  test("openExternal refuses every scheme but http and https", async () => {
    const refused = ["file:///etc/passwd", "smithers://x", "javascript:alert(1)", "not a url", ""]
    const report = await probe({
      scenario: {
        exercises: refused.map((url, index) => ({
          label: `refuse-${index}`,
          request: "openExternal",
          params: { url }
        }))
      }
    })
    for (let index = 0; index < refused.length; index += 1) {
      expect(report.results[`refuse-${index}`]).toEqual({ opened: false })
    }
    expect(report.openedExternally).toEqual([])
  }, PROBE_BUDGET_MS)

  test("openExternal hands a web URL to the host browser and reports what it answered", async () => {
    const report = await probe({
      scenario: {
        openExternalAnswer: true,
        exercises: [
          {
            label: "https",
            request: "openExternal",
            params: { url: "https://smithers.sh/sign-in?next=%2Fapp" }
          },
          { label: "http", request: "openExternal", params: { url: "http://localhost:5173/" } }
        ]
      }
    })
    expect(report.results.https).toEqual({ opened: true })
    expect(report.results.http).toEqual({ opened: true })
    expect(report.openedExternally).toEqual([
      "https://smithers.sh/sign-in?next=%2Fapp",
      "http://localhost:5173/"
    ])
  }, PROBE_BUDGET_MS)

  test("openExternal reports a refusal by the host as not opened", async () => {
    const report = await probe({
      scenario: {
        openExternalAnswer: false,
        exercises: [
          { label: "denied", request: "openExternal", params: { url: "https://smithers.sh/" } }
        ]
      }
    })
    expect(report.results.denied).toEqual({ opened: false })
  }, PROBE_BUDGET_MS)
})

describe("a probe owns the session it starts", () => {
  test("the session owner a scenario spawned is stopped and its state is gone", async () => {
    await probe({})
    const daemon = sessionOwner({})
    expect(daemon.pid).not.toBeNull()
    expect(alive(daemon.pid!)).toBe(false)
    expect(existsSync(daemon.stateDir)).toBe(false)
    expect(existsSync(daemon.home)).toBe(false)
  }, PROBE_BUDGET_MS)
})
