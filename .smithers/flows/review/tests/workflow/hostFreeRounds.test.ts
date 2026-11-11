/**
 * The rounds a host without a checkout registers import no platform module.
 *
 * A Worker reads the change set from GitHub instead of git, so it registers
 * the review rounds, their pure steps and the change-set builders, and supplies
 * its own `PrepareReview` and `RenderWalkthrough`. This walks every module those
 * entries reach through relative imports and fails on a `node:` or `bun:`
 * specifier, a bare Node built-in, or a package outside `PACKAGES`. Each listed
 * package is on the repository's browser contract
 * (`packages/repo-targets/browser/browser-contract.mjs`), whose gate proves it
 * bundles without Node; `@smthrs/agent/AgentAction` is a module of the
 * contracted `@smthrs/agent` root.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** What a host without a checkout imports to run the rounds. */
const ENTRIES = [
  "src/workflow/reviewFlow.ts",
  "src/workflow/reviewActions.ts",
  "src/review/preparedReviewOf.ts"
]

const PACKAGES = new Set(["effect", "@smthrs/flow", "@smthrs/plan", "@smthrs/agent/AgentAction"])

const allowedPackage = (specifier: string) =>
  PACKAGES.has(specifier) || (specifier.startsWith("effect/") && !specifier.startsWith("effect/unstable/"))

/** Every specifier the compiler reads as a module reference in `file`. */
const specifiers = (file: string) =>
  ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((reference) => reference.fileName)

/** The disallowed imports reachable from `entries`, each with the chain that reaches it. */
function platformImports(entries: ReadonlyArray<string>): Array<string> {
  const parent = new Map<string, string>()
  const queue = entries.map((entry) => resolve(root, entry))
  for (const file of queue) parent.set(file, "")
  const found: Array<string> = []
  const chain = (file: string) => {
    const files: Array<string> = []
    for (let at = file; at; at = parent.get(at) ?? "") files.unshift(relative(root, at))
    return files.join(" -> ")
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".")) {
        const next = resolve(dirname(file), specifier)
        if (!parent.has(next)) {
          parent.set(next, file)
          queue.push(next)
        }
      } else if (specifier.startsWith("node:") || specifier.startsWith("bun:") || isBuiltin(specifier)) {
        found.push(`${specifier} <- ${chain(file)}`)
      } else if (!allowedPackage(specifier)) {
        found.push(`${specifier} (not on the browser contract) <- ${chain(file)}`)
      }
    }
  }
  return found
}

describe("the rounds a host without a checkout registers", () => {
  test("reach no platform module", () => {
    expect(platformImports(ENTRIES)).toEqual([])
  })

  test("the walk sees the host implementations' platform imports", () => {
    const found = platformImports(["src/workflow/reviewHostActions.ts"])
    expect(found).toContain("node:async_hooks <- src/workflow/reviewHostActions.ts -> src/io.ts")
    expect(found.some((line) => line.startsWith("node:path <- "))).toBe(true)
  })
})
