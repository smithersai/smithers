import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FullResult, TestCase, TestResult } from "@playwright/test/reporter"
import { TEARDOWN_ANNOTATION } from "./teardown"
import { scenario } from "../coverage/types"
import type { RealE2EEvidenceFile } from "../coverage/types"

const REVISION = "f175fbf15dcb0000000000000000000000000000"

/** The reporter reads its run's identity from the environment at construction. */
const load = async (): Promise<new() => {
  onTestEnd: (test: TestCase, result: TestResult) => void
  onEnd: (result: FullResult) => void
}> => {
  process.env.SMITHERS_REAL_E2E_HOST = "local"
  process.env.SMITHERS_REAL_E2E_REVISION = REVISION
  const module = await import(`../coverage/reporter.ts?case=${Math.random()}`)
  return module.default as never
}

/** The id every case here reports under, declared through the product helper. */
const DECLARED = [scenario("flows.production-create-reconnect-execute", { capabilities: [], coverage: ["host:local"] }).annotation]
  .flat() as ReadonlyArray<{ readonly type: string; readonly description?: string }>
const ID = DECLARED.find((item) => item.type === "real-scenario")!.description!

const testCase = (extra: ReadonlyArray<{ type: string; description?: string }>): TestCase =>
  ({
    title: "a scenario",
    annotations: [...DECLARED, { type: "real-host-verified", description: "local" }, ...extra]
  } as unknown as TestCase)

const passed = (): TestResult =>
  ({ status: "passed", startTime: new Date("2026-09-19T00:00:00.000Z"), duration: 1_000, attachments: [] } as unknown as TestResult)

const evidence = async (
  test: TestCase,
  result: TestResult
): Promise<RealE2EEvidenceFile> => {
  const output = join(mkdtempSync(join(tmpdir(), "real-e2e-evidence-")), "evidence.json")
  process.env.SMITHERS_REAL_E2E_RESULTS = output
  const Reporter = await load()
  const reporter = new Reporter()
  reporter.onTestEnd(test, result)
  reporter.onEnd({ status: "passed" } as FullResult)
  return JSON.parse(readFileSync(output, "utf8")) as RealE2EEvidenceFile
}

describe("a scenario whose cleanup could not finish", () => {
  test("keeps the verdict its body earned", async () => {
    const written = await evidence(
      testCase([{ type: TEARDOWN_ANNOTATION, description: "GitHub is holding the test account in sudo mode." }]),
      passed()
    )
    expect(written.runs).toHaveLength(1)
    expect(written.runs[0]?.status).toBe("passed")
  })

  test("still fails the run, because the leak is the run's problem", async () => {
    const written = await evidence(
      testCase([{ type: TEARDOWN_ANNOTATION, description: "GitHub is holding the test account in sudo mode." }]),
      passed()
    )
    expect(written.reporterErrors).toEqual([`${ID}: GitHub is holding the test account in sudo mode.`])
  })

  test("reports one line per unfinished step", async () => {
    const written = await evidence(
      testCase([
        { type: TEARDOWN_ANNOTATION, description: "the GitHub source was kept." },
        { type: TEARDOWN_ANNOTATION, description: "the cloud repository was kept." }
      ]),
      passed()
    )
    expect(written.reporterErrors).toEqual([
      `${ID}: the GitHub source was kept.`,
      `${ID}: the cloud repository was kept.`
    ])
  })
})

test("a scenario whose cleanup finished reports nothing extra", async () => {
  const written = await evidence(
    testCase([]),
    passed()
  )
  expect(written.reporterErrors).toEqual([])
  expect(written.runs[0]?.status).toBe("passed")
})
