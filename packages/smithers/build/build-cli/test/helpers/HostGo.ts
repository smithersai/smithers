import * as PackageTree from "../../src/PackageTree.ts"

/** Whether `go` is on this process's `PATH`. */
export const hasGo = PackageTree.findOnPath("go", process.env) !== undefined

/**
 * Whether a case that needs Go runs here: where it `present`ly has what it needs, and on CI, which installs Go,
 * so a CI without it is red instead of quietly dropping Go's coverage. `SMITHERS_TEST_SKIP_GO=1` skips them anywhere.
 */
export const runsGo = (present: boolean = hasGo): boolean =>
  process.env["SMITHERS_TEST_SKIP_GO"] !== "1" && (present || process.env["CI"] === "true")

/** A case's name that needs Go: where it is skipped, the name says what the host lacks. */
export const goCase = (name: string, present: boolean = hasGo, needs = "go on PATH"): string =>
  runsGo(present)
    ? name
    : `${name} (skipped: ${
      process.env["SMITHERS_TEST_SKIP_GO"] === "1" ? "SMITHERS_TEST_SKIP_GO=1" : `needs ${needs}`
    })`
