// Stays .ts: Playwright loads reporters through its JS/TS loader.
import type { FullResult, Reporter, TestResult } from "@playwright/test/reporter"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { measure, readBuild, sourcesIn, type BuiltScript } from "../e2e/coverage-reporter.ts"
import { readEntries } from "../e2e/coverageStore.ts"

const require = createRequire(import.meta.url)
const { createContext } = require("istanbul-lib-report")
const reports = require("istanbul-reports")
const root = fileURLToPath(new URL("../", import.meta.url))

/** Remaps every executed bundle with the compiler/Vite maps; no test or generated JS is credited as source. */
export default class SourceCoverage implements Reporter {
  private readonly files = new Set<string>()
  private executed = 0

  constructor(private readonly options: { sources?: ReadonlyArray<string>; build?: ReadonlyArray<BuiltScript>; project?: string; directory?: string } = {}) {}

  onTestEnd(_test: unknown, result: TestResult) {
    if (result.status !== "skipped") this.executed++
    for (const attachment of result.attachments) {
      if (attachment.name === "chromium-coverage" && attachment.path) this.files.add(attachment.path)
    }
  }

  async onEnd(result: FullResult) {
    if (this.executed === 0) return
    // As in the e2e gate, seed every full source before crediting the bundle by source position.
    // `pnpm fuzz:affected` (FUZZ_REPORT_FILES) seeds and remaps only its changed sources; a chunk without one is skipped.
    const scoped = process.env.FUZZ_REPORT_FILES?.split(/\s+/).filter((file) => file !== "").map((file) => resolve(root, file))
    const sources = this.options.sources ?? scoped ?? await sourcesIn(["src", "worker"])
    const build = this.options.build ?? await readBuild()
    const coverage = await measure(readEntries(this.files), sources, build, this.options.project)
    const directory = this.options.directory ?? resolve(root, "coverage/fuzz-browser")
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, "coverage-final.json"), JSON.stringify(coverage))
    const context = createContext({ dir: directory, coverageMap: coverage })
    // `pnpm fuzz:affected` (FUZZ_REPORT_FILES) reads only coverage-final.json, through the fuzz flow's report stage.
    const formats = scoped === undefined ? ["text", "json-summary", "html", "lcovonly"] : []
    for (const format of formats) reports.create(format).execute(context)
    if (this.files.size === 0 && result.status === "passed") return { status: "failed" as const }
  }
}
