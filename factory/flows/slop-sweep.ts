/**
 * The @slop tagging sweep: one agent per workspace package adds an `@slop`
 * JSDoc tag to every exported declaration that is not yet `@humanreviewed`.
 * Runs as waves of parallel `AgentTask` steps, one flow per wave.
 *
 * Launch: `bun factory/flows/slop-sweep.ts`
 * Progress: tail factory/reports/slop-sweep/<package>.log
 * Result:   factory/reports/SLOP-SWEEP.md
 */
import * as Schema from "effect/Schema"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { AgentTask, chunk, listWorkspacePackages, REPO_ROOT, REPORTS_DIR, runFlow, type TaskResult } from "./harness.ts"

const WAVE_SIZE = 8
const MODEL = "sonnet"
const TIMEOUT_MS = 30 * 60_000
const logDir = path.join(REPORTS_DIR, "slop-sweep")
const reportPath = path.join(REPORTS_DIR, "SLOP-SWEEP.md")
const progressPath = `${reportPath}.partial`

const promptFor = (pkg: string): string =>
  [
    `You are doing a mechanical JSDoc tagging sweep in the pnpm workspace ${REPO_ROOT}.`,
    `Work ONLY inside ${pkg}/src.`,
    "For every exported declaration (functions, consts, classes, interfaces, type aliases, schemas, data structures) whose JSDoc block does not already contain @humanreviewed, add a line `* @slop` inside the JSDoc block, after any existing @category/@since tags.",
    "If an exported declaration has no JSDoc block, create a minimal block directly above it containing only the @slop tag.",
    "Rules: change comments only — never code, imports, or formatting outside JSDoc blocks. Skip test files (*.test.ts, test/ directories), node_modules, dist, scripts, and generated files. Do not run builds, tests, or linters. Do not touch any other package.",
    "When finished, print DONE followed by the number of @slop tags you added."
  ].join(" ")

const packages = listWorkspacePackages().map((pkg) => pkg.dir)
const waves = chunk(packages, WAVE_SIZE)
const countCommand = `grep -rn "@slop" ${packages.map((pkg) => `${pkg}/src`).join(" ")} 2>/dev/null | wc -l`
const results: Array<TaskResult> = []

const writeReport = (done: number) => {
  const lines = [
    "# @slop tagging sweep",
    "",
    `Started ${startedAt}. ${done}/${packages.length} packages processed, wave size ${WAVE_SIZE}, model ${MODEL}.`,
    "",
    "| Package | Exit | Log |",
    "| --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.exitCode} | ${path.relative(REPO_ROOT, r.logPath)} |`),
    "",
    `Verification: \`${countCommand}\`.`,
    ""
  ]
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  fs.writeFileSync(progressPath, lines.join("\n"))
}

const startedAt = new Date().toISOString()
console.log(`slop-sweep: ${packages.length} packages, ${waves.length} waves`)

for (let index = 0; index < waves.length; index++) {
  const wave = waves[index]!
  const WaveFlow = Flow.make(`factory/SlopSweepWave${index}`, {
    payload: { wave: Schema.Number },
    success: Schema.Record(Schema.String, Schema.Unknown),
    body: () =>
      Node.all(
        Object.fromEntries(
          wave.map((pkg) => [
            pkg,
            AgentTask.call({
              id: pkg.replaceAll("/", "."),
              prompt: promptFor(pkg),
              cwd: REPO_ROOT,
              model: MODEL,
              timeoutMs: TIMEOUT_MS,
              logDir,
              completionMarker: "DONE",
              allowedPaths: [path.join(REPO_ROOT, pkg, "src")]
            })
          ])
        )
      )
  })
  console.log(`wave ${index + 1}/${waves.length}: ${wave.join(", ")}`)
  const waveResult = (await runFlow(
    WaveFlow,
    { wave: index },
    `slop-sweep-w${index}-${startedAt.slice(0, 10)}`
  )) as Record<string, TaskResult>
  for (const pkg of wave) {
    const r = waveResult[pkg]!
    results.push(r)
    console.log(`  ${pkg}: exit ${r.exitCode}`)
  }
  writeReport(results.length)
}

const slopCount = execSync(countCommand, {
  cwd: REPO_ROOT
})
  .toString()
  .trim()
fs.appendFileSync(progressPath, `\nTotal @slop tags after sweep: ${slopCount}\n`)
const failed = results.filter((result) => result.exitCode !== 0)
if (failed.length > 0) {
  process.exitCode = 1
  console.error(`slop-sweep failed: ${failed.length} agent seat(s) failed. Partial diagnostics: ${progressPath}`)
} else {
  fs.renameSync(progressPath, reportPath)
  console.log(`slop-sweep done: ${slopCount} tags. Report: ${reportPath}`)
}
