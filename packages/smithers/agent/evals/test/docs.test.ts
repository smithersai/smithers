import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// The JSDoc scanner must not run past the end of a comment block, so the body
// pattern excludes a closing delimiter rather than matching lazily.
const documented =
  /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(?:const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g

const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

const exported = (): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const [namespace, file] of namespaces()) {
    for (const [, block, name] of read(`../src/${file}.ts`).matchAll(documented)) {
      if (block!.includes("@category")) names.add(`${namespace}.${name!}`)
    }
  }
  return [...names]
}

const tabled = (): ReadonlyArray<string> =>
  [...read("../docs/api.md").matchAll(/^\| `([A-Za-z]+\.[A-Za-z0-9_$]+)` *\| /gmu)].map(([, name]) => name!)

// A hand-written export table drifts the moment a module gains or loses a
// documented export, and nothing else in this private package would notice.
describe("documentation", () => {
  it("tables every documented export exactly once", () => {
    const rows = tabled()
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows)]).toEqual(rows)
    expect([...rows].sort()).toEqual([...exported()].sort())
  })

  // The README is what npm renders, and the package's "files" list does not
  // ship docs/, so the reference it points a reader at has to be the published
  // site rather than a path that is absent from the tarball.
  it("keeps the package README pointing at the published reference", () => {
    const readme = read("../README.md")
    expect(readme).toContain("https://evals.smithers.sh/reference/api/")
    expect(readme).not.toContain("npm install")
  })

  // The README says the package is not on the npm registry, so an install page
  // that tells a reader to `pnpm add` it sends them to a registry 404.
  it("installs the package the way the README does", () => {
    expect(read("../README.md")).toContain("not on the npm registry")
    const installation = read("../docs/installation.md")
    expect(installation).not.toMatch(/(?:pnpm add|npm install|yarn add) @smthrs\/evals/)
    expect(installation).toContain(`"@smthrs/evals": "workspace:*"`)
  })

  // A formatter spaces `yield*` into `yield *` in a fragment it cannot parse
  // as a generator body, so every `yield*` fence has to sit inside one.
  it("shows every yield* inside a generator", () => {
    const pages = [
      "../README.md",
      ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .map((path) => `../docs/${path}`)
    ]
    for (const page of pages) {
      for (const [, fence] of read(page).matchAll(/```ts\n([\s\S]*?)```/g)) {
        expect(fence, page).not.toContain("yield *")
        if (fence!.includes("yield*")) expect(fence, page).toContain("function*")
      }
    }
  })

  it("files the release notes under the released version", () => {
    expect(read("../CHANGELOG.md")).toContain("## [1.0.0-rc.0]")
  })
})
