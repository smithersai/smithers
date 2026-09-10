/**
 * What the aomi template's browser entry can reach through static imports.
 *
 * create-app/performance/3: `src/main.tsx` imported `flows` from
 * `routes.gen.ts` for three strings per flow, and with it every layer file,
 * every tool module (`tools/tevm.ts` builds an in-memory EVM client at module
 * scope), and the harness. The browser table `routes.ui.gen.ts` now carries
 * `flowSummaries`, so the entry never reaches a layer file, a tool module, or
 * the Worker's table. This walks the relative import graph from the entry and
 * pins that, without a bundler and without evaluating a module.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { defaultDirs } from "../src/app.ts"
import { discover, renderAll } from "../src/router.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const templateRoot = join(packageRoot, "template")

/** Every relative specifier one file imports at value or type level. */
const relativeImports = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text.startsWith(".") ? [statement.moduleSpecifier.text] : []
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text.startsWith(".") ? [statement.moduleSpecifier.text] : []
    }
    return []
  })
}

/** Every file reachable from `entry` through relative imports, root-relative with `/` separators. */
const reachable = (root: string, entry: string): ReadonlySet<string> => {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    const key = relative(root, file).split(sep).join("/")
    if (seen.has(key)) return
    seen.add(key)
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) return
    for (const specifier of relativeImports(file)) {
      const target = resolve(dirname(file), specifier)
      if (existsSync(target)) visit(target)
    }
  }
  visit(entry)
  return seen
}

describe("aomi browser entry", () => {
  const root = join(templateRoot, "aomi")
  const files = [...reachable(root, join(root, "src/main.tsx"))].sort()

  it("reaches the browser table and never the Worker's", () => {
    expect(files).toContain("routes.ui.gen.ts")
    expect(files).not.toContain("routes.gen.ts")
  })

  it("reaches no layer file and no tool module", () => {
    const heavy = files.filter((file) => /(?:^|\/)(?:AGENT|SANDBOX|TOOLS)\.ts$/.test(file) || file.startsWith("tools/"))
    expect(heavy).toEqual([])
  })
})

describe("shipped route tables", () => {
  for (const template of ["aomi", "default"]) {
    it(`${template}'s routes.ui.gen.ts is what the router renders today`, () => {
      const root = join(templateRoot, template)
      for (const [file, expected] of Object.entries(renderAll(discover({ root, dirs: defaultDirs })))) {
        expect(readFileSync(join(root, file), "utf8"), file).toBe(expected)
      }
    })
  }
})
