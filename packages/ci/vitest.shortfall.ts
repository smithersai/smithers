// What a part of //packages/ci:test says besides the default reporter: when a source it holds is short of 100%, the
// file, the part that holds it, and where that part's cases are (a case another part runs does not count for it);
// and its slowest files, so a slow or cut job on a CI runner names its cause in its log.
import { relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Reporter, TestModule } from "vitest/node"

interface Summary {
  readonly lines: { readonly pct: number }
  readonly statements: { readonly pct: number }
  readonly functions: { readonly pct: number }
  readonly branches: { readonly pct: number }
}

interface CoverageMap {
  readonly files: () => ReadonlyArray<string>
  readonly fileCoverageFor: (file: string) => { readonly toSummary: () => Summary }
}

const root = fileURLToPath(new URL(".", import.meta.url))

/** A file of a part that takes longer than this is named as soon as it ends: a job cut later still shows it. */
const slowSeconds = 300

/** How long a test file took: importing it and running its cases, in whole seconds. */
const secondsOf = (module: TestModule): number => {
  const diagnostic = module.diagnostic()
  return Math.round((diagnostic.collectDuration + diagnostic.duration) / 1000)
}

/**
 * A reporter that names each file the part `name` holds and does not cover in full, and where its cases go; each file
 * over five minutes as it ends; and the ten slowest files when the run ends.
 */
export const shortfall = (name: string, cases: string): Reporter => ({
  onTestModuleEnd: (module) => {
    const seconds = secondsOf(module)
    if (seconds > slowSeconds) {
      console.error(`packages/ci: //packages/ci:${name}: ${relative(root, module.moduleId)} took ${seconds} s`)
    }
  },
  onTestRunEnd: (modules) => {
    const slowest = [...modules].map((module) => [secondsOf(module), relative(root, module.moduleId)] as const)
      .sort(([a], [b]) => b - a).slice(0, 10)
    console.error(
      `packages/ci: //packages/ci:${name}'s slowest files: ${
        slowest.map(([seconds, file]) => `${file} ${seconds} s`).join(", ")
      }`
    )
  },
  onCoverage: (coverage) => {
    const map = coverage as CoverageMap
    for (const file of map.files()) {
      const summary = map.fileCoverageFor(file).toSummary()
      const short = [summary.lines, summary.statements, summary.functions, summary.branches]
        .some((measure) => measure.pct < 100)
      if (!short) continue
      console.error(
        `packages/ci: ${relative(root, file)} is held by //packages/ci:${name} and is short of 100% there. Its cases ` +
          `go in ${cases}: a case another part runs does not count. Which part holds a source: \`held\` in ` +
          `packages/ci/vitest.config.ts.`
      )
    }
  }
})
