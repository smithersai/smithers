/**
 * Source and test comments defer the "why" to package docs by citing
 * backtick-quoted paths such as `docs/concepts/trampoline-rounds.md`. This
 * gate resolves every such citation against the package root, so a docs move
 * or rename cannot strand a comment pointing at a page nobody can open.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

describe("doc citations in comments", () => {
  it("resolve to pages that exist in the package", () => {
    const stranded: Array<string> = []
    for (const file of [...sourceFiles(join(packageRoot, "src")), ...sourceFiles(join(packageRoot, "test"))]) {
      // Join comment continuation lines so a path wrapped across lines still resolves.
      const text = readFileSync(file, "utf8").replace(/\n\s*(?:\*|\/\/)\s*/g, " ")
      for (const match of text.matchAll(/`(docs\/[^`]*?\.md)`/g)) {
        if (!existsSync(join(packageRoot, match[1]!))) {
          stranded.push(`${relative(packageRoot, file)}: ${match[1]}`)
        }
      }
    }
    expect(stranded).toEqual([])
  })
})
