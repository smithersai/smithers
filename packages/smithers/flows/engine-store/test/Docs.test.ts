import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const readDoc = (path: string): string => readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")

describe("documentation contracts", () => {
  it("describes the strict default and both explicit inconsistency layers", () => {
    const row = readDoc("guides/compose-a-durable-engine.md").split("\n")
      .find((line) => /^\|\s*`Inconsistency`\s*\|/.test(line))
    expect(row).toBeDefined()
    const cells = row!.split("|").map((cell) => cell.trim())
    expect(cells[2]).toContain("Conflicts are journaled and fail the dispatch (the strict default)")
    expect(cells[2]).toContain("`layerTolerant(owner)` to continue past them")
    expect(cells[3]).toContain("`layerStrict(owner)`")
    expect(cells[3]).toContain("`layerTolerant(owner)`")
  })

  it("documents the durable TTL removal refusal and recovery policy", () => {
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).toContain("Omitting `ttlMs` is unbounded only before a durable age verdict exists")
    expect(api).toContain("Removing `ttlMs` after a recorded verdict fails with `idempotency_conflict`")
    expect(api).toContain(
      "Recovery must retain the original TTL and history identity, or use a new action or run identity"
    )
    expect(api).not.toContain("retains the existing unbounded path and is not covered by this conflict check")
  })

  it("assembles the quickstart snippets without duplicate import bindings", () => {
    const blocks = [...readDoc("quickstart.md").matchAll(/^```ts\n([\s\S]*?)^```/gm)]
    expect(blocks.length).toBeGreaterThan(1)
    const source = ts.createSourceFile(
      "quickstart.ts",
      blocks.map((block) => block[1]).join("\n"),
      ts.ScriptTarget.Latest
    )
    const names: Array<string> = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const clause = statement.importClause
      if (clause?.name) names.push(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings === undefined) continue
      if (ts.isNamespaceImport(bindings)) names.push(bindings.name.text)
      else names.push(...bindings.elements.map((binding) => binding.name.text))
    }
    expect(names).toEqual(expect.arrayContaining(["Action", "Flow", "Interpreter"]))
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
  })
})

describe("source documentation pointers", () => {
  const sourceDir = new URL("../src/", import.meta.url)
  const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"))
  const read = (name: string): string => readFileSync(new URL(name, sourceDir), "utf8")

  it("every relative docs pointer in a public module resolves to a file", () => {
    const missing: Array<string> = []
    for (const name of sources) {
      for (const match of read(name).matchAll(/`((?:\.\.\/)*(?:docs|packages|apps)\/[^`\s]+\.(?:md|mdx))`/g)) {
        const pointer = match[1]!
        const target = pointer.startsWith("docs/")
          ? new URL(`../${pointer}`, import.meta.url)
          : new URL(`../../../../../${pointer}`, import.meta.url)
        if (!existsSync(target)) missing.push(`${name}: ${pointer}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("names the run statuses the schema admits and the real memory transaction", () => {
    const header = read("DurableEngineState.ts")
    expect(header).not.toMatch(/one `waiting` status/)
    expect(header).toContain("`suspended`")
    expect(header).toContain("`waiting_reason`")
    expect(header).not.toContain("runs the effect directly")
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).not.toContain("runs the effect directly")
    expect(api).toContain("rolls back")
  })
})
