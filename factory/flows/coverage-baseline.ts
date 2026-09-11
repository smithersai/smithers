/**
 * Coverage baseline: run every package's vitest suite with coverage and
 * write a per-package gap report, the input for the 100%-coverage sprint.
 * Waves of parallel `ShellTask` steps, one flow per wave.
 *
 * Launch: `bun factory/flows/coverage-baseline.ts`
 * Progress: tail factory/reports/coverage/<package>.log
 * Result:   factory/reports/COVERAGE-BASELINE.md
 */
import * as Schema from "effect/Schema"
import * as fs from "node:fs"
import * as path from "node:path"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import {
  chunk,
  listWorkspacePackages,
  REPO_ROOT,
  REPORTS_DIR,
  runFlow,
  ShellTask,
  type TaskResult
} from "./harness.ts"

const WAVE_SIZE = 4
const TIMEOUT_MS = 20 * 60_000
const logDir = path.join(REPORTS_DIR, "coverage")
const reportPath = path.join(REPORTS_DIR, "COVERAGE-BASELINE.md")
const progressPath = `${reportPath}.partial`

const packageDescriptors = listWorkspacePackages()
const packages = packageDescriptors.map((pkg) => pkg.dir)
const waves = chunk(packages, WAVE_SIZE)
const results: Array<TaskResult> = []
const startedAt = new Date().toISOString()

/** Pulls the vitest "All files" coverage row out of a task log. */
const coverageLine = (logPath: string): string => {
  if (!fs.existsSync(logPath)) return "no log"
  const text = fs.readFileSync(logPath, "utf8")
  const match = text.split("\n").filter((line) => line.includes("All files"))
  return match.length > 0 ? match[match.length - 1]!.trim() : "no coverage table (see log)"
}

const writeReport = (done: number) => {
  const lines = [
    "# Coverage baseline",
    "",
    `Started ${startedAt}. ${done}/${packages.length} packages measured, wave size ${WAVE_SIZE}.`,
    "Command per package: `pnpm --filter <manifest-name> exec vitest run --coverage`.",
    "",
    "| Package | Exit | All files (Stmts/Branch/Funcs/Lines) | Log |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) => `| ${r.id} | ${r.exitCode} | ${coverageLine(r.logPath)} | ${path.relative(REPO_ROOT, r.logPath)} |`
    ),
    ""
  ]
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  fs.writeFileSync(progressPath, lines.join("\n"))
}

console.log(`coverage-baseline: ${packages.length} packages, ${waves.length} waves`)

for (let index = 0; index < waves.length; index++) {
  const wave = waves[index]!
  const WaveFlow = Flow.make(`factory/CoverageWave${index}`, {
    payload: { wave: Schema.Number },
    success: Schema.Record(Schema.String, Schema.Unknown),
    body: () =>
      Node.all(
        Object.fromEntries(
          wave.map((pkg) => {
            const descriptor = packageDescriptors.find((candidate) => candidate.dir === pkg)!
            return [
              pkg,
              ShellTask.call({
                id: pkg.replaceAll("/", "."),
                command: "pnpm",
                args: ["--filter", descriptor.name, "exec", "vitest", "run", "--coverage"],
                cwd: REPO_ROOT,
                timeoutMs: TIMEOUT_MS,
                logDir
              })
            ]
          })
        )
      )
  })
  console.log(`wave ${index + 1}/${waves.length}: ${wave.join(", ")}`)
  const waveResult = (await runFlow(
    WaveFlow,
    { wave: index },
    `coverage-w${index}-${startedAt.slice(0, 10)}`
  )) as Record<string, TaskResult>
  for (const pkg of wave) {
    const r = waveResult[pkg]!
    results.push(r)
    console.log(`  ${pkg}: exit ${r.exitCode}`)
  }
  writeReport(results.length)
}

const failed = results.filter((result) => result.exitCode !== 0)
if (failed.length > 0) {
  process.exitCode = 1
  console.error(
    `coverage-baseline failed: ${failed.length} package gate(s) failed. Partial diagnostics: ${progressPath}`
  )
} else {
  fs.renameSync(progressPath, reportPath)
  console.log(`coverage-baseline done. Report: ${reportPath}`)
}
