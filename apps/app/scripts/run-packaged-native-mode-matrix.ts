#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startNativeOwn } from "./mode-matrix/native-own"
import { startNativePlue } from "./mode-matrix/native-plue"
import type { MatrixConfig, ModeConfig } from "../e2e/real/coverage/matrix"
import type { DeploymentMode } from "../e2e/real/coverage/types"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const revision = process.env.SMITHERS_BUILD_SHA?.trim()
const executable = process.argv[2]?.trim() ?? process.env.SMITHERS_MODE_MATRIX_NATIVE_EXECUTABLE?.trim()
const cdpEndpoint = process.env.SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT?.trim()
const selected = process.env.SMITHERS_MODE_MATRIX_NATIVE_MODES?.split(",") ?? ["native-own", "native-plue"]
if (selected.length === 0 || selected.some((mode) => mode !== "native-own" && mode !== "native-plue")) {
  throw new Error("SMITHERS_MODE_MATRIX_NATIVE_MODES must list native-own and/or native-plue")
}
if (!revision || !/^[0-9a-f]{40,64}$/.test(revision) || !executable || !cdpEndpoint) {
  throw new Error("native matrix requires SMITHERS_BUILD_SHA, a packaged launcher, and SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT")
}
const outputDir = resolve(process.env.SMITHERS_MODE_MATRIX_OUTPUT_DIR ?? resolve(appDir, "test-results/mode-matrix/native"))
mkdirSync(outputDir, { recursive: true })

const run = async (
  mode: DeploymentMode,
  command: "audit" | "run",
  config: ModeConfig | undefined,
  environment: Readonly<Record<string, string>> = {}
): Promise<number> => {
  const directory = resolve(outputDir, mode)
  mkdirSync(directory, { recursive: true })
  const configPath = resolve(directory, "config.json")
  writeFileSync(configPath, `${JSON.stringify({ revision, modes: config ? [config] : [] } satisfies MatrixConfig, null, 2)}\n`, { mode: 0o600 })
  const artifacts = ["real-e2e-artifacts", "real-e2e-results.json"]
  if (command === "run") {
    for (const name of artifacts) rmSync(resolve(appDir, "test-results", name), { recursive: true, force: true })
  }
  const child = Bun.spawn([
    "bun", "scripts/run-mode-matrix.ts", command,
    "--modes", mode,
    "--config", configPath,
    "--report", resolve(directory, "report.json")
  ], { cwd: appDir, env: { ...process.env, ...environment }, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  // The next mode reuses Playwright's output paths. Preserve this mode's
  // failures beside its receipt, where CI already uploads artifacts.
  if (command === "run") {
    for (const name of artifacts) {
      const source = resolve(appDir, "test-results", name)
      if (existsSync(source)) cpSync(source, resolve(directory, name), { recursive: true })
    }
  }
  return code
}

let failed = false
if (selected.includes("native-own")) {
  const own = await startNativeOwn(revision, resolve(outputDir, "native-own"), executable, cdpEndpoint)
  try { failed = (await run("native-own", "run", own.modeConfig, own.runtimeEnvironment)) !== 0 || failed }
  finally { await own.close() }
}

const plueURL = process.env.SMITHERS_MODE_MATRIX_PLUE_URL?.trim()
const plueToken = process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN?.trim()
if (Boolean(plueURL) !== Boolean(plueToken)) {
  throw new Error("native-plue requires both SMITHERS_MODE_MATRIX_PLUE_URL and SMITHERS_MODE_MATRIX_PLUE_TOKEN")
}
if (selected.includes("native-plue") && plueURL && plueToken) {
  const plue = await startNativePlue(revision, resolve(outputDir, "native-plue"), executable, cdpEndpoint, plueURL, "SMITHERS_MODE_MATRIX_PLUE_TOKEN")
  try { failed = (await run("native-plue", "run", plue.modeConfig, plue.runtimeEnvironment)) !== 0 || failed }
  finally { await plue.close() }
} else if (selected.includes("native-plue")) {
  failed = (await run("native-plue", "audit", undefined)) !== 0 || failed
}
if (failed) process.exitCode = 1
