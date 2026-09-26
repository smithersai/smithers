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
 * headless machine lacks (the window and the system browser); the local
 * server the entrypoint starts is the real one.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PROBE_MARKER } from "../../e2e/native/Probe.ts"
import type { NativeProbeReport, ProbeScenario } from "../../e2e/native/Probe.ts"

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url))
const DRIVER = realpathSync(join(UI_DIR, "e2e", "native", "MainProcess.ts"))

interface ProbeOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly scenario?: ProbeScenario
}

const cache = new Map<string, Promise<NativeProbeReport>>()
/* Each scenario gets its own faked home, removed once its subprocess exits. */
const homes = new Set<string>()

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

const spawnProbe = async (options: ProbeOptions, home: string): Promise<NativeProbeReport> => {
  const child = Bun.spawn([process.execPath, DRIVER], {
    cwd: UI_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_NATIVE_PROBE: JSON.stringify(options.scenario ?? {}),
      SMITHERS_NATIVE_PROBE_HOME: home,
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
    return JSON.parse(line.slice(PROBE_MARKER.length)) as NativeProbeReport
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Scenarios are pure, so identical ones share one subprocess. */
const probe = (options: ProbeOptions): Promise<NativeProbeReport> => {
  const key = JSON.stringify(options)
  const existing = cache.get(key)
  if (existing !== undefined) return existing
  const home = mkdtempSync(join(tmpdir(), "smithers-native-probe-home-"))
  homes.add(home)
  const started = spawnProbe(options, home)
  cache.set(key, started)
  return started
}

const temporaryDirectories: Array<string> = []

afterAll(async () => {
  for (const directory of [...homes, ...temporaryDirectories]) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("the native main process starts the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN on 127.0.0.1 and the origin answers /api/health", async () => {
    const report = await probe({})
    expect(report.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(report.health).toMatchObject({
      ok: true,
      pid: expect.any(Number),
      home: expect.stringContaining("smithers-native-probe-home-")
    })
    expect(report.logs).toContain("Smithers app started!")
  }, PROBE_BUDGET_MS)

  test("the window loads the local origin, never views:// and never a dev server", async () => {
    const report = await probe({})
    expect(report.windows).toHaveLength(1)
    expect(report.windows[0]?.url).toBe(`${report.origin}/`)
    expect(report.windows[0]?.title).toBe("Smithers")
    expect(report.windows[0]?.frame).toEqual({ width: 1180, height: 800, x: 100, y: 60 })
    // The seams bind to the window: an unbound rpc is a window whose
    // sign-in door is dead.
    expect(report.windows[0]?.rpcBound).toBe(true)
  }, PROBE_BUDGET_MS)

  test("SMITHERS_LOCAL_HEADLESS=1 serves without a window", async () => {
    const report = await probe({ env: { SMITHERS_LOCAL_HEADLESS: "1" } })
    expect(report.windows).toEqual([])
    expect(report.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(report.health).toMatchObject({ ok: true })
    expect(report.logs).toContain("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
  }, PROBE_BUDGET_MS)

  test("E2E bridge keeps its window hidden unless explicitly requested", async () => {
    const hidden = await probe({ env: { SMITHERS_E2E_BRIDGE: "1", SMITHERS_E2E_BRIDGE_PORT: "12345", SMITHERS_E2E_BRIDGE_TOKEN: "01234567890123456789012345678901" } })
    expect(hidden.windows[0]).toMatchObject({ hidden: true, activate: false })
    const visible = await probe({ env: { SMITHERS_E2E_BRIDGE: "1", SMITHERS_E2E_BRIDGE_PORT: "12346", SMITHERS_E2E_BRIDGE_TOKEN: "01234567890123456789012345678901", SMITHERS_NATIVE_E2E_VISIBLE: "1" } })
    expect(visible.windows[0]).toMatchObject({ hidden: false, activate: true })
  }, PROBE_BUDGET_MS)
})

describe("the native RPC surface", () => {
  test("binds only platform and backend-configuration doors", async () => {
    const report = await probe({})
    expect([...report.requestNames].sort()).toEqual([
      "applicationBootstrapToken",
      "applicationTarget",
      "applicationToken",
      "openExternal",
      "switchApplicationTarget"
    ])
    expect(report.messageNames).toEqual([])
  }, PROBE_BUDGET_MS)

  test("hands the renderer a secret-free target and the credential separately", async () => {
    const report = await probe({
      scenario: {
        exercises: [
          { label: "target", request: "applicationTarget", params: {} },
          { label: "token", request: "applicationToken", params: {} },
          { label: "bootstrap-token", request: "applicationBootstrapToken", params: {} }
        ]
      }
    })
    expect(report.results.target).toEqual({
      target: {
        apiVersion: 1,
        mode: "native-own",
        apiOrigin: report.origin,
        auth: { kind: "session" },
        cors: "same-origin",
        developerExternal: false
      }
    })
    expect(report.results.token).toEqual({ token: null })
    expect(report.results["bootstrap-token"]).toEqual({ token: null })
  }, PROBE_BUDGET_MS)

  // smithers:// is inbound only (the "open-url" tests below): the page may
  // not relaunch the app through the system browser door.
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

describe("smithers://open/<owner>/<repo> opens that repository page", () => {
  test("a cold launch by URL becomes the window's first page", async () => {
    const report = await probe({ scenario: { openUrlsAtLaunch: ["smithers://open/smithersai/smithers"] } })
    expect(report.windows).toHaveLength(1)
    expect(report.windows[0]?.url).toBe(`${report.origin}/smithersai/smithers`)
    expect(report.windows[0]?.loaded).toEqual([])
  }, PROBE_BUDGET_MS)

  test("the dev build receives the same link through SMITHERS_OPEN_URL", async () => {
    const report = await probe({ env: { SMITHERS_OPEN_URL: "smithers://open/acme/widgets" } })
    expect(report.windows[0]?.url).toBe(`${report.origin}/acme/widgets`)
  }, PROBE_BUDGET_MS)

  test("a link while running navigates the open window; anything else is refused", async () => {
    const report = await probe({
      scenario: {
        openUrlsAtLaunch: ["smithers://x"],
        openUrlsAfterStart: [
          "smithers://open/acme/widgets",
          "smithers://open/acme/widgets?next=https://evil.example",
          "smithers://open/acme/widgets/extra",
          "file:///etc/passwd"
        ]
      }
    })
    expect(report.windows[0]?.url).toBe(`${report.origin}/`)
    expect(report.windows[0]?.loaded).toEqual([`${report.origin}/acme/widgets`])
    expect(report.openedExternally).toEqual([])
  }, PROBE_BUDGET_MS)
})
