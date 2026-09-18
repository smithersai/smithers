import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGES_DIR = fileURLToPath(new URL("../../../../", import.meta.url))
const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug|trace)\s*\(/

/**
 * `source` with the contents of every string and template literal blanked.
 *
 * A file that teaches another realm spells `console.log` inside a quoted demo
 * script: text handed to a cell, never a call in this process. Blanking literal
 * contents keeps the guard's subject to code that runs, and every character
 * outside the quotes, newlines included, stays where it was so a reported line
 * number still points at the offending line. A `${...}` interpolation is code
 * again, so it is left alone.
 *
 * A single or double quote closes at the end of its line, because JavaScript
 * has no raw newline inside one: a stray apostrophe in a regular expression
 * blanks at most the rest of that line instead of swallowing the file. Comments
 * are copied through untouched, so a mis-read `//` inside a regular expression
 * can only make the guard report more, never less.
 */
const withoutLiterals = (source: string): string => {
  const out: Array<string> = []
  // Brace depth recorded at each `${`; the `}` that returns to it resumes the template.
  const interpolations: Array<number> = []
  let braces = 0
  let quote: string | null = null
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (quote === null) {
      if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
        const line = source[index + 1] === "/"
        const found = line ? source.indexOf("\n", index) : source.indexOf("*/", index + 2)
        const end = found === -1 ? source.length : (line ? found : found + 2)
        out.push(source.slice(index, end))
        index = end
        continue
      }
      if (char === "'" || char === "\"" || char === "`") quote = char
      else if (char === "{") braces += 1
      else if (char === "}") {
        braces -= 1
        if (interpolations.at(-1) === braces) {
          interpolations.pop()
          quote = "`"
        }
      }
      out.push(char)
      index += 1
      continue
    }
    if (char === "\\") {
      out.push(source[index + 1] === "\n" ? " \n" : "  ")
      index += 2
      continue
    }
    if (char === quote) {
      quote = null
      out.push(char)
      index += 1
      continue
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      interpolations.push(braces)
      braces += 1
      quote = null
      out.push("${")
      index += 2
      continue
    }
    if (char === "\n") {
      if (quote !== "`") quote = null
      out.push("\n")
      index += 1
      continue
    }
    out.push(" ")
    index += 1
  }
  return out.join("")
}

/**
 * The file whose `console.log` is data rather than a call.
 *
 * `cellPrompt.ts` is the contract a model is taught, and the contract's worked
 * example is JavaScript for a *different* realm: `console.log` is how a cell
 * talks to its next turn, so the example has to spell it. Models imitate the
 * example, so spelling it any other way to satisfy a text match would teach a
 * shape the realm does not have.
 *
 * The guard reads this file like any other, because `withoutLiterals` already
 * drops the template literal the example lives in. What stays pinned is the
 * count below: editing the worked example moves this number, which is the same
 * deliberateness the contract's own digest and token ceiling ask for.
 */
const TEACHING = "smithers/agent/harness/src/internal/cellPrompt.ts"

/** How many `console.*` lines the teaching text is expected to spell. */
const TEACHING_LINES = 2

/**
 * The one file the guard still skips whole.
 *
 * `Sandbox.ts` teaches the same cell realm from a JSDoc block, and a comment is
 * not a literal, so `withoutLiterals` leaves it in place. The exception stays
 * tied to that single worked example, pinned by the test below, rather than
 * widening the pattern over comments and losing a commented-out debugging call.
 */
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
        if (relative === SANDBOX_TEACHING) continue
        const source = withoutLiterals(readFileSync(file, "utf8"))
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

  it("reads a quoted console call as text and a bare one as a call", () => {
    const source = "const demo = `console.log(1)`\nconsole.log(2)\n"
    const lines = withoutLiterals(source).split("\n").filter((line) => CONSOLE_CALL.test(line))
    expect(lines).toEqual(["console.log(2)"])
  })

  it("keeps a console call that runs inside a template interpolation", () => {
    const source = "const demo = `before ${console.log(3)} after`\n"
    expect(withoutLiterals(source)).toBe("const demo = `       ${console.log(3)}      `\n")
  })

  it("keeps the line numbers of a multi-line template literal", () => {
    const source = "const demo = `one\nconsole.log(4)\nthree`\nconsole.log(5)\n"
    const offenders = withoutLiterals(source).split("\n")
      .flatMap((line, index) => CONSOLE_CALL.test(line) ? [index + 1] : [])
    expect(offenders).toEqual([4])
  })

  it("closes a mistaken quote at its own line", () => {
    const source = "const apostrophe = /it's/\nconsole.log(6)\n"
    const lines = withoutLiterals(source).split("\n").filter((line) => CONSOLE_CALL.test(line))
    expect(lines).toEqual(["console.log(6)"])
  })

  it("scans a non-empty set of package sources", () => {
    const scanned = packageSourceRoots().flatMap((root) => Array.from(sourceFiles(root)))
    expect(scanned.length).toBeGreaterThan(0)
  })
})
