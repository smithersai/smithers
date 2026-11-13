/** API coverage follows every public entry point and requires code references. */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { exportedNames, missingReferenceNames, publicEntries } from "./reference-docs.mjs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const api = read("docs/api.md")
const entries = publicEntries(JSON.parse(read("package.json")))

for (const { specifier, path } of entries) {
  test(`${specifier} exports have API reference entries`, () => {
    assert.ok(api.split("\n").some((line) => line.split("|")[1]?.trim() === `\`${specifier}\``), "list the specifier in the entry-points table")
    const names = exportedNames(new URL(`../${path}`, import.meta.url))
    assert.ok(names.length > 0, "the public entry has named exports")
    assert.deepEqual(missingReferenceNames(names, api), [], `${specifier} exports missing from docs/api.md`)
  })
}

test("prose, guide mentions and longer identifiers cannot stand in for API entries", () => {
  assert.deepEqual(missingReferenceNames(["Card", "Input", "Plan"], "Card and Input with a plan.\n`CardProps`\n```ts\nInputProps\n```"), ["Card", "Input", "Plan"])
  assert.deepEqual(missingReferenceNames(["Card", "Input"], "`Card`\n```ts\nfunction Input(): void\n```"), [])
  assert.deepEqual(missingReferenceNames(["$tag"], "`$tag`"), [])
})

test("export scanning handles declarations, async, enum, default, aliases, destructuring and recursive barrels", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-reference-"))
  try {
    writeFileSync(join(dir, "index.ts"), `
      // export const NotAnExport = 1
      export async function load() {}
      export enum Status { Ready }
      export declare const pending: boolean
      export declare function start(): void
      export abstract class Base {}
      export interface Props {}
      export type Value = string
      export const { first, renamed: second } = value, [third] = list
      const hidden = 0
      export { hidden as visible }
      export { default as Component } from "./component"
      export * as Scope from "./other"
      export * from "./other"
      export * from "./component"
      export default function Main() {}
    `)
    writeFileSync(join(dir, "other.vibe"), 'export const branch = 1; export * from "./index"')
    writeFileSync(join(dir, "component.tsx"), 'export default () => null; export const Nested = 1')
    assert.deepEqual(exportedNames(pathToFileURL(join(dir, "index.ts"))).sort(),
      ["load", "Status", "pending", "start", "Base", "Props", "Value", "first", "second", "third", "visible", "Component", "Scope", "branch", "default", "Nested"].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("manifest coverage includes subpath-only and conditional entry points", () => {
  assert.deepEqual(publicEntries({ name: "@smthrs/ui", exports: {
    ".": { types: "./index.ts", default: "./index.js" },
    "./only": "./only.ts",
    "./runtime": { import: "./runtime.ts" },
    "./default": { default: "./default.ts" },
  } }), [
    { specifier: "@smthrs/ui", path: "./index.ts" },
    { specifier: "@smthrs/ui/only", path: "./only.ts" },
    { specifier: "@smthrs/ui/runtime", path: "./runtime.ts" },
    { specifier: "@smthrs/ui/default", path: "./default.ts" },
  ])
})
