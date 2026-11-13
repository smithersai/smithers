import { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Core from "../src/index.ts"
import type * as KeyMaterial from "../src/KeyMaterial.ts"

const publicApiRows = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const afterHeading = readme.slice(readme.indexOf("## Public API") + "## Public API".length)
  const nextHeading = afterHeading.search(/^## /m)
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
  const rows = new Map<string, ReadonlySet<string>>()

  for (const line of section.split(/\r?\n/)) {
    const cells = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/)
    if (cells === null) continue
    rows.set(cells[1]!, new Set([...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)))
  }

  return rows
}

describe("README public API table", () => {
  it("authors every flow example with the canonical tagged constructor", () => {
    const docs = new URL("../docs/", import.meta.url)
    const files = [new URL("../README.md", import.meta.url)]
    for (const name of readdirSync(docs, { recursive: true })) {
      if (typeof name === "string" && name.endsWith(".md")) files.push(new URL(name, docs))
    }
    let declarations = 0
    for (const file of files) {
      const document = readFileSync(file, "utf8")
      for (const match of document.matchAll(/```ts\n([\s\S]*?)```/g)) {
        const code = match[1]!
        expect(code, file.pathname).not.toMatch(/\b(?:Flow\.make|defineFlow)\s*\(\s*\{/)
        if (!/\bFlow\.make\s*\(/.test(code)) continue
        declarations += [...code.matchAll(/\bFlow\.make\s*\(/g)].length
        expect(document, file.pathname).toMatch(/import\s*\{[^}]*\bFlow\b[^}]*\}\s*from\s*"@smthrs\/flow"/)
        expect(code, file.pathname).not.toMatch(/\bFlow\.(?:within|withCapabilities|sealed)\s*\(/)
      }
    }
    expect(declarations).toBe(8)
    const source = readFileSync(new URL("../src/Flow.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/export (?:const make|.*\bMakeOptions\b)/)
  })

  it("has one row per namespace and lists every runtime export", () => {
    const rows = publicApiRows()

    expect(new Set(rows.keys())).toEqual(new Set(Object.keys(Core)))
    for (const [module, namespace] of Object.entries(Core)) {
      const documented = rows.get(module) ?? new Set<string>()
      expect(Object.keys(namespace).filter((name) => !documented.has(name)), module).toEqual([])
    }
  })
})

describe("documented key material", () => {
  it("exposes an action's nondeterminism to typed consumers and in the API reference", () => {
    for (const nondeterministic of [undefined, true] as const) {
      const action = Action.make("key-material", {
        payload: {},
        success: Schema.Void,
        ...(nondeterministic === undefined ? {} : { nondeterministic })
      })
      const draft = Core.Graph.drafts(Core.Graph.build(action.call({})))[0]!
      const material: KeyMaterial.KeyMaterial = {
        ...draft.material,
        effects: undefined,
        placement: undefined
      }
      const flag: true | undefined = material.nondeterministic
      expect(flag).toBe(nondeterministic)
      expect(Object.hasOwn(material, "nondeterministic")).toBe(nondeterministic === true)
      const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
      const shape = api.match(/interface KeyMaterial \{([\s\S]*?)\n\}/)![1]!
      const documented = new Set([...shape.matchAll(/readonly (\w+)[?:]/g)].map((match) => match[1]!))
      expect(Object.keys(material).filter((field) => !documented.has(field))).toEqual([])
    }
  })
})
