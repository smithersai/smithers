#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseMatrixConfig } from "../e2e/real/coverage/matrix"
import type { MatrixConfig } from "../e2e/real/coverage/matrix"
import { startPackagedWebSelfhost } from "./mode-matrix/docker-web-selfhost"
import type { WebSelfhostSession } from "./mode-matrix/docker-web-selfhost"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const rootDir = resolve(appDir, "../..")
const args = process.argv.slice(2)
const matrixCommand = args[0] ?? "run"
if (matrixCommand !== "audit" && matrixCommand !== "run") {
  throw new Error("usage: run-packaged-mode-matrix.ts audit|run [--output-dir path] [--external-config path] [--auth-environment NAME]")
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
const revisionProcess = Bun.spawn(["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], {
  cwd: rootDir,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe"
})
const [revisionOutput, revisionError, revisionCode] = await Promise.all([
  new Response(revisionProcess.stdout).text(),
  new Response(revisionProcess.stderr).text(),
  revisionProcess.exited
])
const revision = revisionOutput.trim()
if (revisionCode !== 0 || !/^[0-9a-f]{40,64}$/.test(revision)) {
  throw new Error(`cannot identify the exact jj revision: ${revisionError.trim()}`)
}

const outputDir = resolve(option("--output-dir") ?? process.env.SMITHERS_MODE_MATRIX_OUTPUT_DIR ?? resolve(appDir, "test-results/mode-matrix"))
const configPath = resolve(outputDir, "config.json")
const reportPath = resolve(outputDir, "report.json")
mkdirSync(outputDir, { recursive: true })

const externalPath = option("--external-config") ?? process.env.SMITHERS_MODE_MATRIX_EXTERNAL_CONFIG
let external: MatrixConfig = { revision, modes: [] }
if (externalPath !== undefined) {
  if (!existsSync(externalPath)) throw new Error(`external mode configuration does not exist: ${externalPath}`)
  external = parseMatrixConfig(JSON.parse(readFileSync(resolve(externalPath), "utf8")) as unknown)
  if (external.revision !== revision) throw new Error(`external mode revision ${external.revision} does not match checkout ${revision}`)
  if (external.modes.some(({ mode }) => mode === "web-selfhost")) {
    throw new Error("external mode configuration must not replace the packaged web-selfhost launch")
  }
}

let session: WebSelfhostSession | undefined
let launchFailure: unknown
try {
  session = await startPackagedWebSelfhost({
    rootDir,
    revision,
    outputDir,
    ...(option("--auth-environment") === undefined ? {} : { authEnvironment: option("--auth-environment") })
  })
} catch (error) {
  launchFailure = error
  console.error(`web-selfhost launch failed: ${error instanceof Error ? error.message : String(error)}`)
}

const config: MatrixConfig = {
  revision,
  modes: [...(session === undefined ? [] : [session.modeConfig]), ...external.modes]
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

let matrixCode = 1
let teardownFailure: unknown
const stop = async (): Promise<void> => {
  if (session === undefined) return
  const current = session
  session = undefined
  await current.close()
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
    "--report", reportPath
  ], {
    cwd: appDir,
    env: { ...process.env, ...session?.runtimeEnvironment },
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
    console.error(`web-selfhost teardown failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (launchFailure !== undefined || teardownFailure !== undefined || matrixCode !== 0) process.exitCode = 1
