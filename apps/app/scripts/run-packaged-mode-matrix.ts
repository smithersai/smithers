#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseMatrixConfig } from "../e2e/real/coverage/matrix"
import type { MatrixConfig } from "../e2e/real/coverage/matrix"
import { startPackagedWebSelfhost } from "./mode-matrix/docker-web-selfhost"
import type { WebSelfhostSession } from "./mode-matrix/docker-web-selfhost"
import { startLocalOwn } from "./mode-matrix/local-own"
import type { LocalOwnSession } from "./mode-matrix/local-own"
import { startPlueTargets } from "./mode-matrix/plue-target"
import type { PlueSession } from "./mode-matrix/plue-target"
import { startNativeOwn } from "./mode-matrix/native-own"
import type { NativeOwnSession } from "./mode-matrix/native-own"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const rootDir = resolve(appDir, "../..")
const args = process.argv.slice(2)
const matrixCommand = args[0] ?? "run"
if (matrixCommand !== "audit" && matrixCommand !== "run") {
  throw new Error("usage: run-packaged-mode-matrix.ts audit|run [--output-dir path] [--external-config path] [--auth-environment NAME] [--modes comma-separated]")
}

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

// Force the working-copy snapshot before building. Otherwise an unsnapshotted
// source tree could receive the preceding commit's revision in every receipt.
const sourceRevision = async (): Promise<string> => {
  for (const command of [["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], ["git", "rev-parse", "HEAD"]]) {
    try {
      const child = Bun.spawn(command, { cwd: rootDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      const revision = stdout.trim()
      if (code === 0 && /^[0-9a-f]{40,64}$/.test(revision)) return revision
    } catch { /* Git-only release checkouts have no jj. */ }
  }
  throw new Error("cannot identify the exact source revision")
}
const revision = await sourceRevision()

const outputDir = resolve(option("--output-dir") ?? process.env.SMITHERS_MODE_MATRIX_OUTPUT_DIR ?? resolve(appDir, "test-results/mode-matrix"))
const modeSelection = option("--modes")
const wants = (mode: string): boolean => modeSelection === undefined || modeSelection.split(",").includes(mode)
const configPath = resolve(outputDir, "config.json")
const reportPath = resolve(outputDir, "report.json")
mkdirSync(outputDir, { recursive: true })

const externalPath = option("--external-config") ?? process.env.SMITHERS_MODE_MATRIX_EXTERNAL_CONFIG
let external: MatrixConfig = { revision, modes: [] }
if (externalPath !== undefined) {
  if (!existsSync(externalPath)) throw new Error(`external mode configuration does not exist: ${externalPath}`)
  external = parseMatrixConfig(JSON.parse(readFileSync(resolve(externalPath), "utf8")) as unknown)
  if (external.revision !== revision) throw new Error(`external mode revision ${external.revision} does not match checkout ${revision}`)
  if (external.modes.some(({ mode }) => mode === "web-selfhost" || mode === "local-own")) {
    throw new Error("external mode configuration must not replace an in-repo owned launch")
  }
}

let session: WebSelfhostSession | undefined
let localSession: LocalOwnSession | undefined
let nativeSession: NativeOwnSession | undefined
let plueSessions: readonly PlueSession[] = []
let launchFailure: unknown
if (wants("web-selfhost")) try {
  session = await startPackagedWebSelfhost({
    rootDir,
    revision,
    outputDir,
    ...(process.env.SMITHERS_MODE_MATRIX_IMAGE ? { image: process.env.SMITHERS_MODE_MATRIX_IMAGE } : {}),
    ...(option("--auth-environment") === undefined ? {} : { authEnvironment: option("--auth-environment") })
  })
} catch (error) {
  launchFailure = error
  console.error(`web-selfhost launch failed: ${error instanceof Error ? error.message : String(error)}`)
}
const plueTarget = process.env.SMITHERS_MODE_MATRIX_PLUE_URL?.trim()
const plueTokenEnvironment = "SMITHERS_MODE_MATRIX_PLUE_TOKEN"
if (plueTarget && process.env[plueTokenEnvironment]?.trim() && (wants("web-plue") || wants("local-plue"))) {
  if (external.modes.some(({ mode }) => mode === "web-plue" || mode === "local-plue")) {
    throw new Error("external configuration must not duplicate the configured Plue web or local target")
  }
  try { plueSessions = await startPlueTargets(appDir, revision, outputDir, plueTarget, plueTokenEnvironment) }
  catch (error) {
    launchFailure = error
    console.error(`Plue target launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (wants("local-own")) try {
  localSession = await startLocalOwn(rootDir, revision, outputDir)
} catch (error) {
  launchFailure = error
  console.error(`local-own launch failed: ${error instanceof Error ? error.message : String(error)}`)
}
const nativeExecutable = process.env.SMITHERS_MODE_MATRIX_NATIVE_EXECUTABLE?.trim()
const nativeCDP = process.env.SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT?.trim()
if (wants("native-own") && Boolean(nativeExecutable) !== Boolean(nativeCDP)) {
  const error = new Error("native-own requires both SMITHERS_MODE_MATRIX_NATIVE_EXECUTABLE and SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT")
  launchFailure = error
  console.error(error.message)
}
if (nativeExecutable && nativeCDP && wants("native-own")) {
  try { nativeSession = await startNativeOwn(revision, outputDir, nativeExecutable, nativeCDP) }
  catch (error) {
    launchFailure = error
    console.error(`native-own launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const config: MatrixConfig = {
  revision,
  modes: [...(session === undefined ? [] : [session.modeConfig]), ...(localSession === undefined ? [] : [localSession.modeConfig]),
    ...(nativeSession === undefined ? [] : [nativeSession.modeConfig]), ...plueSessions.map(({ modeConfig }) => modeConfig), ...external.modes]
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

let matrixCode = 1
let teardownFailure: unknown
const stop = async (): Promise<void> => {
  const docker = session
  const local = localSession
  const native = nativeSession
  const remote = plueSessions
  session = undefined
  localSession = undefined
  nativeSession = undefined
  plueSessions = []
  const failures: unknown[] = []
  for (const close of [docker?.close, local?.close, native?.close, ...remote.map((target) => target.close)]) {
    if (close === undefined) continue
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "mode launcher teardown failed")
}
const interrupt = (signal: NodeJS.Signals): void => {
  void stop().finally(() => {
    process.kill(process.pid, signal)
  })
}
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
try {
  const matrix = Bun.spawn([
    "bun", "scripts/run-mode-matrix.ts", matrixCommand,
    "--config", configPath,
    "--report", reportPath,
    ...(modeSelection === undefined ? [] : ["--modes", modeSelection])
  ], {
    cwd: appDir,
    env: { ...process.env, ...session?.runtimeEnvironment, ...localSession?.runtimeEnvironment, ...nativeSession?.runtimeEnvironment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  matrixCode = await matrix.exited
} finally {
  process.off("SIGINT", interrupt)
  process.off("SIGTERM", interrupt)
  try { await stop() } catch (error) {
    teardownFailure = error
    console.error(`mode launcher teardown failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (launchFailure !== undefined || teardownFailure !== undefined || matrixCode !== 0) process.exitCode = 1
