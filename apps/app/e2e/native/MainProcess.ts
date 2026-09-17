/*
 * The native main process, run for real, with no window.
 *
 * apps/app/src/bun/index.ts is a top-level-await module: importing it starts
 * the local origin, registers the RPC surface and constructs the window as a
 * side effect, once per process. So it cannot be re-imported for a second
 * scenario, and `electrobun/main` cannot be imported inside `bun test` at all:
 * it dlopens a native wrapper and installs a quit handler that keeps the
 * process alive.
 *
 * This driver is the way around both. It replaces `electrobun/main` wholesale
 * with a recording fake, imports the REAL entrypoint, exercises the handlers
 * the entrypoint registered, probes the origin it started, and prints one
 * JSON report on stdout. src/bun/Main.test.ts spawns it once per scenario.
 *
 * Nothing here fakes the product. The fake stands in for the HOST: the
 * window, the file dialog and the system browser, exactly the parts a
 * headless machine does not have. The local server is the real one.
 */
import { mock } from "bun:test"
import * as os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { PROBE_MARKER } from "./Probe.ts"
import type { NativeProbeReport, ProbeScenario, RecordedWindow } from "./Probe.ts"

const scenario: ProbeScenario = JSON.parse(process.env.SMITHERS_NATIVE_PROBE ?? "{}") as ProbeScenario
const dialogPaths = scenario.dialogPaths ?? []
const openExternalAnswer = scenario.openExternalAnswer ?? true

const logs: Array<string> = []
const windows: Array<RecordedWindow> = []
const dialogOptions: Array<unknown> = []
const openedExternally: Array<string> = []
const results: Record<string, unknown> = {}
let requestNames: ReadonlyArray<string> = []
let messageNames: ReadonlyArray<string> = []
let handlers: Record<string, unknown> = {}

const originalLog = console.log
console.log = (...parts: ReadonlyArray<unknown>): void => {
  logs.push(parts.map((part) => String(part)).join(" "))
}

const fakeRpc = { proxy: { request: {}, send: {} } }

interface RpcConfig {
  readonly handlers: {
    readonly requests: Record<string, unknown>
    readonly messages: Record<string, unknown>
  }
}

const fakeSdk = {
  default: { events: { on: () => {} } },
  BuildConfig: {
    getSync: () => ({
      isPackaged: false,
      channel: "dev",
      defaultRenderer: "native"
    })
  },
  BrowserView: {
    defineRPC: (config: RpcConfig) => {
      requestNames = Object.keys(config.handlers.requests)
      messageNames = Object.keys(config.handlers.messages)
      handlers = config.handlers.requests
      return fakeRpc
    }
  },
  BrowserWindow: class FakeBrowserWindow {
    constructor(options: { title: unknown; url: unknown; frame: unknown; rpc: unknown }) {
      windows.push({
        title: options.title,
        url: options.url,
        frame: options.frame,
        rpcBound: options.rpc === fakeRpc
      })
    }
  },
  Screen: {
    captureRegion: () => null
  },
  Utils: {
    openFileDialog: async (options: unknown): Promise<ReadonlyArray<string>> => {
      dialogOptions.push(options)
      return [...dialogPaths]
    },
    openExternal: (url: string): boolean => {
      openedExternally.push(url)
      return openExternalAnswer
    }
  }
}
mock.module("electrobun/main", () => fakeSdk)
mock.module("electrobun/bun", () => fakeSdk)

// A probe must never restore or rewrite the signed-in user's real application state.
// The caller may own the home so it can reach the state a scenario leaves behind.
const givenHome = process.env.SMITHERS_NATIVE_PROBE_HOME
const probeHome = givenHome ?? await mkdtemp(join(os.tmpdir(), "smithers-native-probe-home-"))
const hostOs = { ...os, homedir: () => probeHome }
mock.module("node:os", () => hostOs)

await import("../../src/bun/index.ts")

for (const exercise of scenario.exercises ?? []) {
  const handler = handlers[exercise.request]
  if (typeof handler !== "function") {
    results[exercise.label] = { probeError: `no handler named ${exercise.request}` }
    continue
  }
  results[exercise.label] = await (handler as (params: unknown) => unknown)(exercise.params)
}

const originLine = logs.find((line) => line.startsWith("SMITHERS_LOCAL_ORIGIN="))
const origin = originLine === undefined ? null : originLine.slice("SMITHERS_LOCAL_ORIGIN=".length)
const health = origin === null ? null : await fetch(`${origin}/api/health`).then((response) => response.json()).catch(() => null)

console.log = originalLog

const report: NativeProbeReport = {
  logs,
  windows,
  requestNames,
  messageNames,
  dialogOptions,
  openedExternally,
  origin,
  health,
  results
}
await Bun.write(Bun.stdout, `${PROBE_MARKER}${JSON.stringify(report)}\n`)

/*
 * The session owner the entrypoint attached to outlives the window by product
 * design, so the probe stops the one it caused; a probe that IS that owner has
 * nothing to stop and must not recreate the state its caller is removing. Both
 * imports stay dynamic: a static one would read the real home directory before
 * the mock above lands, and the state directory is checked to be the faked one
 * before anything is asked to stop.
 */
if (process.env.SMITHERS_LOCAL_DAEMON !== "1") {
  const { nativeStateDirectory } = await import("../../src/bun/NativeState.ts")
  const { shutdownLocalDaemon } = await import("../../src/bun/LocalDaemonStop.ts")
  const stateDir = nativeStateDirectory()
  if (stateDir.startsWith(probeHome)) await shutdownLocalDaemon(stateDir)
}
if (givenHome === undefined) await rm(probeHome, { recursive: true, force: true })
process.exit(0)
