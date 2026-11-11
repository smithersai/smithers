/** Check every public declaration, including the root's wildcard exports. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
// The docs target uses Node; the package suite also discovers this same guard.
const { test } = await import(process.env.VITEST ? "vitest" : "node:test")

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const missingReferenceEntries = (docs) => {
  const root = read("src/index.ts")
  const entries = new Set([
    ...docs.matchAll(/^### ([\w.]+)[ \t]*$/gm),
    ...docs.matchAll(/^\|[ \t]*`([\w.]+)`[ \t]*\|/gm)
  ].map(([, name]) => name))
  const missing = []
  for (const [, namespace, module] of root.matchAll(/export \*(?: as (\w+))? from "\.\/([^\"]+)"/g)) {
    const source = read(`src/${module}`)
    for (const [, name] of source.matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)) {
      const qualified = namespace ? `${namespace}.${name}` : name
      if (!entries.has(qualified)) missing.push(qualified)
    }
  }
  return [...new Set(missing)]
}

test("every crypto public export has an API reference entry", () => {
  assert.deepEqual(missingReferenceEntries(read("docs/api.md")), [], "public crypto exports missing from docs/api.md")
})

test("incidental mentions cannot replace an export heading", () => {
  for (const name of ["Digest", "digest", "Sha256", "WebCrypto.make"]) {
    const docs = read("docs/api.md").replace(`### ${name}\n`, `### ${name}Extra\n`)
    assert.ok(missingReferenceEntries(docs).includes(name), `missing heading for ${name}`)
  }
})

test("an exact export table cell can replace its heading", () => {
  for (const name of ["Digest", "digest", "Sha256", "WebCrypto.make"]) {
    const docs = read("docs/api.md").replace(`### ${name}\n`, `| \`${name}\` | Reference entry |\n`)
    assert.deepEqual(missingReferenceEntries(docs), [])
  }
})

test("a reference entry must match the complete qualified name", () => {
  const name = "WebCrypto.make"
  for (const replacement of ["### Uuid.make", "| `make` | Reference entry |", "| `WebCrypto.makeExtra` | Reference entry |"]) {
    const docs = read("docs/api.md").replace(`### ${name}\n`, `${replacement}\n`)
    assert.ok(missingReferenceEntries(docs).includes(name), `wrong entry: ${replacement}`)
  }
})
