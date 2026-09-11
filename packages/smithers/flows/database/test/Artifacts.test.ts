import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

/**
 * Every step here is synchronous, so it blocks this worker's event loop: the
 * enclosing Vitest timeout cannot fire while a child is stuck, and it cannot
 * kill one either. The per-child budget is what actually bounds them, sized
 * against a measurement on a loaded machine (build 26 s, the two runtime
 * fixtures 3 s each, the type fixture 8 s) with room for a cold cache. The
 * suite budget is deliberately larger than their sum so a wedged child fails
 * as a child timeout, naming the step, rather than as an opaque suite timeout.
 */
const budgets = {
  build: 120_000,
  runtime: 20_000,
  types: 60_000
} as const

const run = (script: string, timeout: number) =>
  execFileSync(process.execPath, [script], { cwd: packageRoot, timeout, killSignal: "SIGKILL" })

describe("built artifacts", () => {
  it(
    "preserves constructor identity between root and subpath exports",
    () => {
      run("../../../repo-targets/scripts/build.mjs", budgets.build)
      run("test/fixtures/artifact-esm.mjs", budgets.runtime)
      run("test/fixtures/artifact-cjs.cjs", budgets.runtime)
      // Runtime identity is only half of what is published. This type-checks a
      // consumer against the export map npm writes, once per condition that map
      // advertises, so a type the package exports but the packed declarations
      // do not reach a consumer with is a failure here rather than in someone's
      // editor. Measured at 8 s on top of the build.
      run("test/fixtures/artifact-types.mjs", budgets.types)
    },
    budgets.build + budgets.runtime * 2 + budgets.types + 20_000
  )
})
