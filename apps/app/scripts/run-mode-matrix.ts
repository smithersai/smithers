#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MANDATORY_DETERMINISTIC_BROWSER_SPECS,
  MANDATORY_DETERMINISTIC_BUN_TESTS,
  MODE_DESCRIPTORS,
  missingModeReadiness,
  parseMatrixConfig,
  probeMode,
  scenarioReceipts
} from "../e2e/real/coverage/matrix"
import { DEPLOYMENT_MODES } from "../e2e/real/coverage/types"
import type { MatrixConfig, MatrixScenarioReceipt, ModeReadiness } from "../e2e/real/coverage/matrix"
import type { DeploymentMode, RealE2EEvidenceFile, RealScenarioRunEvidence } from "../e2e/real/coverage/types"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
const command = args[0] ?? "audit"
if (command !== "audit" && command !== "run") throw new Error("usage: run-mode-matrix.ts audit|run [--config path] [--report path]")

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

const detectRevision = async (): Promise<string> => {
  // Let jj snapshot first: a stale @ would label tests of unsnapshotted source
  // with the previous tree's revision.
  const child = Bun.spawn(["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], { cwd: appDir, stdout: "pipe", stderr: "pipe" })
  const revision = (await new Response(child.stdout).text()).trim()
  if (await child.exited !== 0 || !/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("cannot identify the exact jj revision")
  return revision
}

const detectedRevision = await detectRevision()
const configPath = option("--config") ?? process.env.SMITHERS_MODE_MATRIX_CONFIG
let config: MatrixConfig = { revision: detectedRevision, modes: [] }
let configFailure: string | undefined
if (configPath) {
  try { config = parseMatrixConfig(JSON.parse(readFileSync(resolve(configPath), "utf8")) as unknown) }
  catch (error) { configFailure = error instanceof Error ? error.message : String(error) }
}
if (config.revision !== detectedRevision) configFailure = `matrix revision ${config.revision} does not match checkout ${detectedRevision}`

const commands: Array<{ readonly tier: string; readonly command: readonly string[]; readonly status: "passed" | "failed" | "unavailable"; readonly exitCode?: number }> = []
let deterministicPassed = command === "audit"
if (command === "run") {
  const unit = ["bun", "test", "e2e/real/coverage", "e2e/real/support", ...MANDATORY_DETERMINISTIC_BUN_TESTS]
  const unitRun = Bun.spawn(unit, { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const unitCode = await unitRun.exited
  commands.push({ tier: "deterministic", command: unit, status: unitCode === 0 ? "passed" : "failed", exitCode: unitCode })

  const browser = ["pnpm", "exec", "playwright", "test", "--config", "playwright.config.ts", ...MANDATORY_DETERMINISTIC_BROWSER_SPECS]
  const browserRun = Bun.spawn(browser, { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const browserCode = await browserRun.exited
  commands.push({ tier: "deterministic", command: browser, status: browserCode === 0 ? "passed" : "failed", exitCode: browserCode })
  deterministicPassed = unitCode === 0 && browserCode === 0
}

const readiness: ModeReadiness[] = []
const runs: RealScenarioRunEvidence[] = []
for (const mode of DEPLOYMENT_MODES) {
  const modeConfig = config.modes.find((entry) => entry.mode === mode)
  const state = configFailure ? missingModeReadiness(mode, configFailure)
    : modeConfig === undefined ? missingModeReadiness(mode, `configuration for ${mode} is unavailable`)
      : await probeMode(modeConfig, config.revision)
  readiness.push(state)
  if (command !== "run" || state.status !== "passed" || modeConfig === undefined || !deterministicPassed) continue

  const evidence = resolve(appDir, "test-results", "mode-matrix", `${mode}.real-e2e.json`)
  const invocation = ["bun", "scripts/run-real-e2e.ts"]
  const child = Bun.spawn(invocation, {
    cwd: appDir,
    env: {
      ...process.env,
      SMITHERS_REAL_BASE_URL: modeConfig.origin,
      SMITHERS_REAL_E2E_MODE: mode,
      SMITHERS_REAL_E2E_HOST: MODE_DESCRIPTORS[mode].legacyHost,
      SMITHERS_REAL_E2E_REVISION: config.revision,
      SMITHERS_REAL_E2E_RESULTS: evidence,
      SMITHERS_REAL_AUTH_KIND: modeConfig.auth.kind,
      SMITHERS_REAL_AUTH_ENVIRONMENT: modeConfig.auth.environment,
      ...(modeConfig.auth.kind === "browser-profile" ? { SMITHERS_E2E_PROFILE: process.env[modeConfig.auth.environment] } : {})
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await child.exited
  commands.push({ tier: state.tier, command: invocation, status: code === 0 ? "passed" : "failed", exitCode: code })
  if (!existsSync(evidence)) continue
  const value = JSON.parse(readFileSync(evidence, "utf8")) as RealE2EEvidenceFile
  runs.push(...value.runs.map((run) => ({ ...run, mode: mode as DeploymentMode })))
}

const scenarios: MatrixScenarioReceipt[] = readiness.flatMap((state) => scenarioReceipts(state, config.revision, runs))
const report = {
  ok: deterministicPassed && readiness.every(({ status }) => status === "passed") && scenarios.every(({ status }) => status === "passed"),
  generatedAt: new Date().toISOString(),
  revision: config.revision,
  command,
  commands,
  readiness,
  scenarios
}
const reportPath = resolve(option("--report") ?? process.env.SMITHERS_MODE_MATRIX_REPORT ?? `${appDir}/test-results/mode-matrix/report.json`)
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")

for (const state of readiness) console.log(`${state.status.toUpperCase()} ${state.mode}${state.reasons.length ? `: ${state.reasons.join("; ")}` : ""}`)
const counts = scenarios.reduce((result, row) => ({ ...result, [row.status]: result[row.status] + 1 }), { passed: 0, failed: 0, unavailable: 0 })
console.log(`matrix scenarios: ${counts.passed} passed, ${counts.failed} failed, ${counts.unavailable} unavailable`)
console.log(`matrix report: ${reportPath}`)
if (!report.ok) process.exitCode = 1
