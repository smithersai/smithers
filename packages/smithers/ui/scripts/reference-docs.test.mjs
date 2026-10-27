/** Read the root barrel without loading the browser components. */
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const exportedNames = (url, visited = new Set()) => {
  if (visited.has(url.href)) return []
  visited.add(url.href)
  const source = readFileSync(url, "utf8")
  const names = [...source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)].flatMap(([, block]) =>
    block.split(",").map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)).filter(Boolean))
  names.push(...[...source.matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)].map((match) => match[1]))
  for (const [, namespace, path] of source.matchAll(/export \*(?: as (\w+))? from "([^"]+)"/g)) {
    if (namespace) { names.push(namespace); continue }
    const target = [path, `${path}.ts`, `${path}.tsx`, `${path}.vibe`, `${path}/index.ts`, `${path}/index.vibe`]
      .map((path) => new URL(path, url)).find((candidate) => /\.(?:ts|tsx|vibe)$/.test(candidate.pathname) && existsSync(candidate))
    assert.ok(target, `resolve public wildcard: ${path}`)
    names.push(...exportedNames(target, visited))
  }
  return [...new Set(names)]
}

test("every UI root export has an API reference entry", () => {
  const docs = readdirSync(new URL("../docs/", import.meta.url), { recursive: true })
    .filter((path) => path.endsWith(".md")).map((path) => read(`docs/${path}`)).join("\n")
  const names = exportedNames(new URL("../src/index.ts", import.meta.url))
  assert.ok(names.length > 0, "the public root barrel has named exports")
  assert.deepEqual(names.filter((name) => !new RegExp(`\\b${name}\\b`).test(docs)), [], "UI root exports missing from docs/api.md")
})
