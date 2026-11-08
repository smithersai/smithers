import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Ended, render, summarize } from "./summary"
import { assertShipSelection, shipAcceptance, type ShipTest } from "./ship"

// Playwright's side of the run's summary (e2e/summary.ts): playwright.config.ts names this file as a reporter for a
// deployment run.

const endedOf = (test: TestCase): Ended => {
  const result = test.results.at(-1)
  return {
    file: test.location.file,
    title: test.titlePath().slice(3).join(" › "),
    project: test.parent.project()!.name,
    name: test.title,
    line: test.location.line,
    column: test.location.column,
    outcome: test.outcome(),
    expectedStatus: test.expectedStatus,
    status: result?.status ?? "skipped",
    annotations: [...test.annotations, ...(result?.annotations ?? [])],
  }
}

/** Playwright's reporter: prints the summary, writes `summary.json` beside the results, and fails the run with it. */
export default class Summary implements Reporter {
  private suite: Suite | undefined
  private outputDir = "test-results"
  private config: FullConfig | undefined

  onBegin(config: FullConfig, suite: Suite) {
    this.config = config
    this.suite = suite
    this.outputDir = config.projects[0]?.outputDir ?? this.outputDir
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    let stage = "summarize"
    try {
      // Developer `--list` has nothing to sum up; acceptance must reject absent execution receipts. Every selected
      // test counts, including those a failed setup kept from running. An interruption already exits unsuccessfully.
      const tests = this.suite?.allTests() ?? []
      const acceptance = shipAcceptance(process.env)
      if (result.status === "interrupted" || (!acceptance && !tests.some((test) => test.results.length > 0))) return undefined
      stage = "selection"
      if (acceptance && this.config !== undefined) assertShipSelection(this.config)
      stage = "inventory"
      const inventory = acceptance && process.env.E2E_SHIP_INVENTORY !== undefined
        ? JSON.parse(readFileSync(process.env.E2E_SHIP_INVENTORY, "utf8")) as ReadonlyArray<ShipTest>
        : undefined
      stage = "summarize"
      const summary = summarize(tests.map(endedOf), { shipAcceptance: acceptance, inventory })
      console.log(`\n${render(summary)}\n`)
      stage = "persist"
      mkdirSync(this.outputDir, { recursive: true })
      writeFileSync(join(this.outputDir, "summary.json"), JSON.stringify(summary, null, 2))
      return summary.passed ? undefined : { status: "failed" }
    } catch (error) {
      // Playwright catches reporter exceptions. Return a failure explicitly, including when artifact storage fails.
      const code = (error as NodeJS.ErrnoException).code ?? "summary_error"
      console.error(`E2E summary failed at ${stage} (${code}); run failed`)
      return { status: "failed" }
    }
  }

  printsToStdio() {
    return true
  }
}
