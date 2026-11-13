import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Root from "../src/index.ts"

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

it("documents only available root namespaces", () => {
  const table = readme.split("## Public API")[1]!.split("\n## ")[0]!
  for (const match of table.matchAll(/^\| `([^`]+)`\s*\|/gm)) {
    expect(Object.hasOwn(Root, match[1]!), match[1]).toBe(true)
  }
})

it("documents credential settings the CLI reads", () => {
  const environment = readme.split("## Environment")[1]!.split("\n## ")[0]!
  const names = new Set(Root.Environment.names.map(({ name }) => name))
  const documented = [...environment.matchAll(/^\| `(SMITHERS_\w+)`/gm)].map((match) => match[1]!)
  expect(documented).toContain("SMITHERS_TOKEN")
  for (const name of documented) expect(names.has(name), name).toBe(true)
  expect(readme).not.toContain("`SMITHERS_API_KEY`")
  expect(readme).not.toContain("`--credential`")
})
