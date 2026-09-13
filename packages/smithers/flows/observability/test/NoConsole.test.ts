import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGES_DIR = fileURLToPath(new URL("../../../../", import.meta.url))
const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug|trace)\s*\(/

/**
 * The one file whose `console.log` is data rather than a call.
 *
 * `cellPrompt.ts` is the contract a model is taught, and the contract's worked
 * example is JavaScript for a *different* realm: `console.log` is how a cell
 * talks to its next turn, so the example has to spell it. Models imitate the
 * example, so spelling it any other way to satisfy a text match would teach a
 * shape the realm does not have. Nothing in this file calls `console`; the
 * matches are inside a template literal that is shown, never run.
 *
 * The exemption is pinned to a count rather than left open, because a
 * whole-file pass would let a real debugging call into the one file the guard
 * no longer reads. Editing the worked example moves this number, which is the
 * same deliberateness the contract's own digest and token ceiling ask for.
 */
const TEACHING = "smithers/agent/harness/src/internal/cellPrompt.ts"

/** How many `console.*` lines the teaching text is expected to spell. */
const TEACHING_LINES = 2

// The public sandbox documentation teaches the same cell realm. Keep this
// exception tied to its single worked example rather than exempting source.
const SANDBOX_TEACHING = "smithers/agent/harness/src/Sandbox.ts"

/**
 * Source files under every package's `src`. Walked in-process rather than
 * shelled out to ripgrep: a runner without `rg` makes `spawnSync` return
 * `status: null`, which fails this guard with "expected null to be 1" and
 * reads like a real console violation instead of a missing binary.
 */
function* sourceFiles(dir: string): Generator<string> {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      yield* sourceFiles(path)
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      yield path
    }
  }
}

/**
 * The two browser UI kits this guard does not read.
 *
 * `@smthrs/ui` and `@smthrs/ui-styleguide` are browser components:
 * `WebPreview.tsx` warns through `console.warn` because a
 * component has no Effect logger to reach. The guard's subject is engine source
 * that must log through `@smthrs/observability`, not retained browser code, so
 * the honest scope is to name them rather than to widen the pattern.
 */
const ZERO_X_UI_KITS = new Set(["ui", "ui-styleguide"])

/**
 * Every package's `src`, at every depth.
 *
 * A granular package can sit inside the product package it belongs to, so the
 * walk descends: reading one directory level would leave most of the engine
 * outside this guard while the guard stayed green. A directory holding a
 * `package.json` is a package, and the walk goes on through it because a
 * package may hold packages.
 */
function packageSourceRoots(dir: string = PACKAGES_DIR): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue
    // Templates contain browser application source, outside the engine logger.
    if (ZERO_X_UI_KITS.has(entry.name) || entry.name === "template") continue
    const path = join(dir, entry.name)
    if (existsSync(join(path, "package.json"))) roots.push(join(path, "src"))
    roots.push(...packageSourceRoots(path))
  }
  return roots
}

describe("console guard", () => {
  it("finds no direct console calls in package source", () => {
    const offenders: string[] = []
    for (const root of packageSourceRoots()) {
      for (const file of sourceFiles(root)) {
        const relative = file.slice(PACKAGES_DIR.length)
        if (relative === TEACHING || relative === SANDBOX_TEACHING) continue
        const source = readFileSync(file, "utf8")
        if (!CONSOLE_CALL.test(source)) continue
        for (const [index, line] of source.split("\n").entries()) {
          if (CONSOLE_CALL.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("holds the teaching file to the console lines its worked example spells", () => {
    const source = readFileSync(join(PACKAGES_DIR, TEACHING), "utf8")
    const matched = source.split("\n").filter((line) => CONSOLE_CALL.test(line))
    expect(matched).toHaveLength(TEACHING_LINES)
  })

  it("holds the sandbox documentation to its one cell-console example", () => {
    const source = readFileSync(join(PACKAGES_DIR, SANDBOX_TEACHING), "utf8")
    const matched = source.split("\n").filter((line) => CONSOLE_CALL.test(line))
    expect(matched).toEqual([" * console.log(result.ok === false ? result.error.code : result.stdout)"])
  })

  it("scans a non-empty set of package sources", () => {
    const scanned = packageSourceRoots().flatMap((root) => Array.from(sourceFiles(root)))
    expect(scanned.length).toBeGreaterThan(0)
  })
})
