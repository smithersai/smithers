import { metadata } from "@smthrs/targets/Target"
import { readdirSync, readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Package } from "../PACKAGE.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

/** The namespaces the barrel re-exports, each with the sibling module that holds it. */
const namespaces = [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.(ts|vibe)"/g)]
  .map(([, namespace, module, extension]) => ({ namespace: namespace!, module: module!, extension: extension! }))

const ones = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen"
]
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

/** The English word for a count below one hundred, as the docs spell it. */
const spelled = (count: number): string =>
  count < 20 ? ones[count]! : `${tens[Math.floor(count / 10)]}${count % 10 === 0 ? "" : `-${ones[count % 10]}`}`

/** One declared input of a target: a glob with its excludes, or one file. */
type Declared = { readonly _tag: "Glob"; readonly pattern: string; readonly exclude: ReadonlyArray<string> } | {
  readonly _tag: "File"
  readonly path: string
}

/** Every file under `directory`, as package-relative paths. */
const filesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(new URL(directory, import.meta.url), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.slice(packageRoot.length)}/${entry.name}`)

describe("package exports", () => {
  // The README and the API reference promise `@smthrs/agent/<Module>` for
  // every root namespace. A namespace the barrel exports but the export map
  // omits fails with ERR_PACKAGE_PATH_NOT_EXPORTED for the documented import.
  it("exports every root namespace from its own subpath, in development and when published", () => {
    const manifest = JSON.parse(read("../package.json")) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(namespaces.length).toBeGreaterThan(0)
    for (const { extension, module, namespace } of namespaces) {
      expect(manifest.exports[`./${namespace}`], `exports["./${namespace}"]`).toBe(`./src/${module}.${extension}`)
      expect(manifest.publishConfig.exports[`./${namespace}`], `publishConfig.exports["./${namespace}"]`).toEqual({
        import: { types: `./dist/esm/${module}.d.ts`, default: `./dist/esm/${module}.js` },
        require: { types: `./dist/cjs/${module}.d.ts`, default: `./dist/cjs/${module}.js` }
      })
    }
  })

  it("documents every root namespace in the README's public API list and the API reference", () => {
    const readme = read("../README.md")
    const publicApi = readme.slice(readme.indexOf("## Public API"), readme.indexOf("Every export of every one of them"))
    const reference = read("../docs/api.md")
    for (const { namespace } of namespaces) {
      expect(publicApi, `README lists ${namespace}`).toContain(`\`${namespace}\``)
      expect(reference, `api.md documents ${namespace}`).toContain(`\n## ${namespace}\n`)
    }
    expect(reference).toContain(`exports ${spelled(namespaces.length)} modules from its root entry point`)
  })

  it.each([[1, "one"], [19, "nineteen"], [20, "twenty"], [32, "thirty-two"], [99, "ninety-nine"]])(
    "spells %i as %s",
    (count, word) => {
      expect(spelled(count)).toBe(word)
    }
  )
})

describe("test target inputs", () => {
  const declared = (metadata(Package.test).attrs as { readonly sources: ReadonlyArray<Declared> }).sources

  /** Whether one declared input names `path`, a package-relative file. */
  const covers = (path: string): boolean =>
    declared.some((input) =>
      input._tag === "File"
        ? input.path === path
        : matchesGlob(path, input.pattern) && !input.exclude.some((pattern) => matchesGlob(path, pattern))
    )

  /** The docs pages and examples test files read, as package-relative paths. */
  const pagesRead = (): ReadonlyArray<string> =>
    [
      ...new Set(
        filesUnder("../test")
          .filter((path) => /\.(?:ts|vibe)$/.test(path))
          .flatMap((path) =>
            [...read(`../${path}`).matchAll(/"(?:\.\.\/)+((?:docs|examples)\/[\w./-]+)"/g)].map((m) => m[1]!)
          )
      )
    ].sort()

  // The target's key material is the digests of its declared inputs. A
  // fixture or docs page a test reads but the target omits leaves the key
  // unchanged when that file changes, so a cached green result survives an
  // edit that fails the suite.
  it("declares every file under test/ as a source", () => {
    expect(filesUnder("../test").filter((path) => !covers(path))).toEqual([])
  })

  it("declares every docs page and example a test reads as a source", () => {
    const pages = pagesRead()
    expect(pages).toContain("docs/api.md")
    expect(pages).toContain("examples/quickstart.vibe")
    expect(pages.filter((path) => !covers(path))).toEqual([])
  })

  it.each([
    ["test/fixtures/cell-call-material-v1.json", true],
    ["test/Agent.test.ts", true],
    ["examples/quickstart.vibe", true],
    ["docs/quickstart.md", true],
    ["docs/missing.md", false]
  ])("covers %s: %s", (path, expected) => {
    expect(covers(path)).toBe(expected)
  })
})
