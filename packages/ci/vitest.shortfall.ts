// What a part of //packages/ci:test says when a source it holds is short of 100%: the file, the part that holds it,
// and where that part's cases are. A case another part runs does not count for it.
import { relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Reporter } from "vitest/node"

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

/** A reporter that names each file the part `name` holds and does not cover in full, and where its cases go. */
export const shortfall = (name: string, cases: string): Reporter => ({
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
