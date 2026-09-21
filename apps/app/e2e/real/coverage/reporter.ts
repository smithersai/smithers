import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import { TEARDOWN_ANNOTATION } from "../support/teardown"
import { DEPLOYMENT_MODES, REAL_HOSTS } from "./types"
import type { DeploymentMode, RealE2EEvidenceFile, RealHost, RealScenarioRunEvidence } from "./types"

const annotation = (test: TestCase, type: string): readonly string[] =>
  test.annotations.filter((item) => item.type === type).flatMap((item) => item.description === undefined ? [] : [item.description])

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the real E2E evidence reporter`)
  return value
}

/** Writes normalized executed verdicts for the coverage gate; declarations alone never enter this file. */
export default class RealE2EEvidenceReporter implements Reporter {
  private readonly runs: RealScenarioRunEvidence[] = []
  private readonly errors: string[] = []
  private readonly host = requiredEnvironment("SMITHERS_REAL_E2E_HOST")
  private readonly revision = requiredEnvironment("SMITHERS_REAL_E2E_REVISION")
  private readonly buildSha = process.env.SMITHERS_REAL_E2E_BUILD_SHA?.trim()
  private readonly mode = process.env.SMITHERS_REAL_E2E_MODE?.trim()

  constructor() {
    if (!(REAL_HOSTS as readonly string[]).includes(this.host)) throw new Error(`Unknown SMITHERS_REAL_E2E_HOST ${this.host}`)
    if (!/^[0-9a-f]{40,64}$/.test(this.revision)) throw new Error("SMITHERS_REAL_E2E_REVISION must be an exact 40-64 digit lowercase hex revision")
    if (this.host === "production" && !this.buildSha) throw new Error("Production evidence requires SMITHERS_REAL_E2E_BUILD_SHA")
    if (this.buildSha && !/^[0-9a-f]{40,64}$/.test(this.buildSha)) throw new Error("SMITHERS_REAL_E2E_BUILD_SHA must be an exact 40-64 digit lowercase hex revision")
    if (this.mode !== undefined && !(DEPLOYMENT_MODES as readonly string[]).includes(this.mode)) throw new Error(`Unknown SMITHERS_REAL_E2E_MODE ${this.mode}`)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const ids = annotation(test, "real-scenario")
    if (ids.length !== 1) {
      this.errors.push(`${test.title}: expected exactly one real-scenario annotation, got ${ids.length}`)
      return
    }
    const verifiedHosts = annotation(test, "real-host-verified")
    if (verifiedHosts.length !== 1 || verifiedHosts[0] !== this.host) this.errors.push(`${ids[0]}: fixture did not verify host ${this.host}`)
    /*
     * A teardown that could not finish is the run's problem, not the
     * scenario's verdict: the body keeps the status it earned, and the leak is
     * reported here, where the coverage gate reads it and fails the run.
     */
    for (const sentence of annotation(test, TEARDOWN_ANNOTATION)) this.errors.push(`${ids[0]}: ${sentence}`)
    const started = result.startTime
    const artifact = result.attachments.find((item) => item.path !== undefined)?.path
    this.runs.push({
      scenarioId: ids[0]!,
      host: this.host as RealHost,
      ...(this.mode === undefined ? {} : { mode: this.mode as DeploymentMode }),
      status: result.status,
      revision: this.revision,
      ...(this.buildSha === undefined ? {} : { buildSha: this.buildSha }),
      startedAt: started.toISOString(),
      finishedAt: new Date(started.getTime() + result.duration).toISOString(),
      ...(artifact === undefined ? {} : { artifact })
    })
  }

  onEnd(result: FullResult): void {
    const output = resolve(process.env.SMITHERS_REAL_E2E_RESULTS ?? "test-results/real-e2e-evidence.json")
    mkdirSync(dirname(output), { recursive: true })
    const evidence: RealE2EEvidenceFile = { suiteStatus: result.status, reporterErrors: this.errors, runs: this.runs }
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n")
  }
}
