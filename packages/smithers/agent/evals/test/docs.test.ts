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
// documented export, so the reference is checked against the public source.
describe("documentation", () => {
  it("tables every documented export exactly once", () => {
    const rows = tabled()
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows)]).toEqual(rows)
    expect([...rows].sort()).toEqual([...exported()].sort())
  })

  // The package ships docs/, and npm renders the README. Its reference link
  // uses an absolute GitHub URL so readers can follow it directly from npm.
  it("keeps the package README pointing at the published reference", () => {
    const readme = read("../README.md")
    expect(readme).toContain(
      "https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/evals/docs/api.md"
    )
    expect(readme).not.toContain("npm install")
  })

  // Prereleases ship on the npm `next` dist-tag only; `latest` lags behind, so
  // an install line without the tag installs an older release.
  it("installs the package the way the README does", () => {
    const install = "pnpm add @smthrs/evals@next effect@4.1.1"
    const installation = read("../docs/installation.md")
    expect(read("../README.md")).toContain(install)
    expect(installation).toContain(install)
    expect(installation).not.toMatch(/(?:pnpm add|npm install|yarn add) @smthrs\/evals(?!@next)/)
    // The package is on npm, so neither page sends a reader to the source tree.
    for (const page of [read("../README.md"), installation]) {
      expect(page).not.toContain("workspace:*")
      expect(page).not.toMatch(/source checkout|not on npm/i)
    }
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

  // A reader copies a recording snippet verbatim, and a baseline recorded over
  // a failed case ratifies the missing measurement, so a later gate passes a
  // regressed flow. Every fence that writes a baseline refuses a failed case.
  it("guards every baseline recording against failed cases", () => {
    const pages = [
      "../README.md",
      ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .map((path) => `../docs/${path}`)
    ]
    let recordings = 0
    for (const page of pages) {
      for (const [, fence] of read(page).matchAll(/```ts\n([\s\S]*?)```/g)) {
        if (!fence!.includes("Baseline.write(")) continue
        recordings += 1
        const guard = fence!.indexOf("result.error !== undefined")
        expect(guard, page).toBeGreaterThanOrEqual(0)
        expect(fence!.indexOf("Refusing to record a baseline"), page).toBeGreaterThan(guard)
        expect(fence!.indexOf("Baseline.write("), page).toBeGreaterThan(guard)
      }
    }
    expect(recordings).toBeGreaterThan(0)
  })

  // Runner re-invokes executor and scorer effects on every run, so identical
  // options guarantee stable output only when those callbacks are stable, and
  // an Observation carries `at` but not `runId`.
  it("states determinism as conditional on caller-owned callbacks", () => {
    for (const page of ["../docs/api.md", "../docs/guides/run-a-suite.md", "../docs/concepts/determinism.md"]) {
      const text = read(page).replace(/\s+/g, " ")
      expect(text, page).not.toMatch(/stamps every observation with them/)
      expect(text, page).not.toMatch(
        /two runs (?:of the same suite )?over the same inputs produce (?:byte-)?identical/i
      )
    }
    const determinism = read("../docs/concepts/determinism.md").replace(/\s+/g, " ")
    expect(determinism).not.toContain("controls every input that could vary")
    for (const input of ["clock", "model", "random", "external state", "mutat"]) {
      expect(determinism).toContain(input)
    }
  })

  it("states that a declared case expected wins over binding groundTruth", () => {
    for (const page of ["../src/Suite.ts", "../docs/api.md", "../docs/guides/author-a-suite.md"]) {
      expect(read(page).replace(/\s*\*?\s+/g, " "), page).toMatch(
        /only an absent (?:one|`expected`) defers to the binding/
      )
    }
  })

  it("does not recommend the retired executor object forms", () => {
    for (const page of ["../docs/guides/run-a-suite.md", "../docs/troubleshooting.md"]) {
      const text = read(page).replace(/\s+/g, " ")
      expect(text, page).not.toMatch(/(?:accepts|pass)[^.]*object[^.]*`(?:run|execute)`/i)
    }
  })

  it("files the release notes under the released version", () => {
    expect(read("../CHANGELOG.md")).toContain("## [1.0.0-rc.0]")
  })
})
