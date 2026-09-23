/**
 * The published export map, checked against what the package can actually
 * serve.
 *
 * `publishConfig.exports` mapped `require` to `./dist/cjs/*.js` for every
 * module, and the build emitted `dist/cjs/Vitest.js`, so a CommonJS consumer
 * following the README's documented `@smthrs/testing/Vitest` subpath resolved
 * a file that throws from inside vitest — a third-party crash instead of a
 * resolution error naming this package.
 *
 * The tarball is checked here too: `files` is a pair of directory globs, so
 * what it ships is decided by where a module lives, not by what the export map
 * serves.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(packageRoot, "src")

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly sideEffects: ReadonlyArray<string>
  readonly exports: Record<string, unknown>
  readonly publishConfig: { readonly exports: Record<string, unknown> }
}

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : []
  })

// Every `./src/...` target the development export map serves. The published
// map names `dist/`, which this checkout need not have built, and the build
// compiles one output per source file, so the sources are the honest roots.
const exportedSources = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? value.startsWith("./src/") ? [resolve(packageRoot, value)] : []
    : value === null || typeof value !== "object"
    ? []
    : Object.values(value).flatMap(exportedSources)

const specifiers = /(?:from|import)\s*\(?\s*"(\.[^"]+)"/g

const reachableFromExports = (): ReadonlySet<string> => {
  const seen = new Set<string>()
  const pending = [...exportedSources(manifest.exports)]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(specifiers)) {
      const target = resolve(dirname(file), specifier as string)
      if (target.startsWith(`${sourceRoot}${sep}`)) pending.push(target)
    }
  }
  return seen
}

describe("the export map", () => {
  it.each([
    ["development", manifest.exports],
    ["published", manifest.publishConfig.exports]
  ])("declares ./Vitest as ESM-only in the %s map", (_name, exports) => {
    const entry = exports["./Vitest"] as Record<string, string> | undefined
    expect(entry).toBeDefined()
    expect(entry).toHaveProperty("import")
    expect(entry).toHaveProperty("types")
    expect(entry).not.toHaveProperty("require")
  })

  it("uses explicit entrypoints so a fallback cannot re-expose Vitest to CommonJS", () => {
    for (const exports of [manifest.exports, manifest.publishConfig.exports]) {
      expect(exports["./*"]).toBeUndefined()
      expect(Object.entries(exports).filter(([key, value]) => key.includes("*") && value !== null)).toEqual([])
    }
  })

  it("keeps a require condition for every other module", () => {
    for (const [key, value] of Object.entries(manifest.publishConfig.exports)) {
      if (value === null || key === "./package.json" || key === "./Vitest") continue
      const entry = value as { import: { types: string; default: string }; require: { types: string; default: string } }
      expect(entry.require.default, key).toBe(entry.import.default.replace("./dist/esm/", "./dist/cjs/"))
      expect(entry.require.types, key).toBe(entry.import.types.replace("./dist/esm/", "./dist/cjs/"))
      expect(entry.require.default, key).toMatch(/^\.\/dist\/cjs\/.+\.js$/)
      expect(entry.require.types, key).toMatch(/^\.\/dist\/cjs\/.+\.d\.ts$/)
    }
  })

  // True only because the module no longer writes into `@effect/vitest`'s
  // exported `it`; see `src/Vitest.ts`.
  it("declares no side effects", () => {
    expect(manifest.sideEffects).toEqual([])
  })
})

describe("the publish allowlist", () => {
  // `files` ships `src/**/*.ts` and every `dist/**` artifact the build emits
  // from it, so a module under `src/` is published whether or not the export
  // map serves it. `ParityManifest.ts` was such a module: null-mapping
  // `./internal/*` hid it from resolution and still packed the source, four
  // generated copies and their maps. Test-only support code belongs under
  // `test/`, which neither the allowlist nor `scripts/build.mjs` reads.
  it("ships no source module the export map cannot reach", () => {
    const reachable = reachableFromExports()
    const orphans = sourceFiles(sourceRoot)
      .filter((file) => !reachable.has(file))
      .map((file) => relative(packageRoot, file))
      .sort()
    expect(orphans).toEqual([])
  })
})

describe("the subpath-only modules", () => {
  // `ProcessTable` shipped as a fourth subpath-only module while every page
  // still said "three", so a reader importing it from the root got a package
  // export error with no page naming the subpath.
  const barrel = readFileSync(join(sourceRoot, "index.ts"), "utf8")
  const subpathOnly = Object.keys(manifest.exports)
    .filter((key) => /^\.\/[A-Z]\w*$/.test(key))
    .map((key) => key.slice(2))
    .filter((name) => !barrel.includes(`export * as ${name} from`))
    .sort()
  const page = (path: string) => readFileSync(join(packageRoot, path), "utf8")
  const section = (text: string, heading: string) => {
    const start = text.indexOf(heading)
    expect(start, heading).toBeGreaterThanOrEqual(0)
    const next = text.indexOf("\n## ", start + heading.length)
    return text.slice(start, next === -1 ? undefined : next)
  }

  it("are Faults, ProcessTable, TestHost and Vitest", () => {
    expect(subpathOnly).toEqual(["Faults", "ProcessTable", "TestHost", "Vitest"])
  })

  it.each([
    ["docs/api.md", "Four modules are reachable only by subpath."],
    ["docs/installation.md", "## Four modules stay off the root barrel"],
    ["README.md", "## Four modules stay off the root barrel"]
  ])("are each named where %s lists them", (path, heading) => {
    const listed = section(page(path), heading)
    for (const name of subpathOnly) expect(listed, `${path}: ${name}`).toContain(`\`${name}\``)
  })

  it("each have an API reference section", () => {
    const api = page("docs/api.md")
    for (const name of subpathOnly.filter((name) => name !== "TestHost")) {
      expect(api, name).toContain(`\n## ${name}\n`)
    }
  })
})
