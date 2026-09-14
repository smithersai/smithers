#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { checkRealE2E, formatGateReport } from "../e2e/real/coverage/gate"

const appRoot = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const reportFile = resolve(value("--report") ?? joinDefault(appRoot, "test-results/real-e2e-coverage.json"))
const report = checkRealE2E({
  realDir: resolve(value("--real-dir") ?? joinDefault(appRoot, "e2e/real")),
  flowNameFile: resolve(value("--flow-names") ?? joinDefault(appRoot, "src/mainview/flows/FlowName.ts")),
  resultsFile: value("--results") ? resolve(value("--results")!) : undefined,
  requireComplete: args.includes("--require-complete"),
  expectedRevision: value("--expected-revision"),
  expectedHost: value("--expected-host") as "local" | "production" | "native" | undefined
})

mkdirSync(dirname(reportFile), { recursive: true })
writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n")
console.log(formatGateReport(report, appRoot))
console.log(`machine report: ${reportFile}`)
if (!report.ok) process.exitCode = 1

function joinDefault(root: string, child: string): string {
  return `${root}/${child}`
}
