/** Check every public declaration, including the root's wildcard exports. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
// The docs target uses Node; the package suite also discovers this same guard.
const { test } = await import(process.env.VITEST ? "vitest" : "node:test")

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("every crypto public export has an API reference entry", () => {
  const root = read("src/index.ts")
  const docs = read("docs/api.md")
  const missing = []
  for (const [, namespace, module] of root.matchAll(/export \*(?: as (\w+))? from "\.\/([^\"]+)"/g)) {
    const source = read(`src/${module}`)
    for (const [, name] of source.matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)) {
      const qualified = namespace ? `${namespace}.${name}` : name
      if (!docs.includes(qualified)) missing.push(qualified)
    }
  }
  assert.deepEqual([...new Set(missing)], [], "public crypto exports missing from docs/api.md")
})
