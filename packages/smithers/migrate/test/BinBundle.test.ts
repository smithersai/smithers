/**
 * The freshness rule the spawned-process tests depend on.
 *
 * `test/flow/Bin.test.ts` and the live end-to-end case run a bundle rather
 * than the sources, and that bundle inlines every `@smthrs` package the CLI
 * imports: `src/flow/bin.ts` reaches 512 files, of which 40 are this
 * package's. A cache that judges freshness from `src` alone hands those tests
 * the implementation from before a registry, kernel or harness change, while
 * the in-process tests beside them import the current tree, and the two
 * disagree for a reason neither reports.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBin, bundleInputs, bundleOnce } from "./fixtures/helpers.ts"

/** An entry that reaches a module outside its own directory, as `bin.ts` does. */
const project = (): { readonly entryPoint: string; readonly dependency: string; readonly directory: string } => {
  const root = mkdtempSync(join(tmpdir(), "migrate-bundle-"))
  mkdirSync(join(root, "entry"))
  mkdirSync(join(root, "dependency"))
  const dependency = join(root, "dependency", "greeting.ts")
  writeFileSync(dependency, `export const greeting = "first"\n`)
  const entryPoint = join(root, "entry", "main.ts")
  writeFileSync(entryPoint, `import { greeting } from "../dependency/greeting.ts"\nconsole.log(greeting)\n`)
  return { entryPoint, dependency, directory: join(root, "out") }
}

describe("bundleOnce", () => {
  it("rebuilds when a dependency it inlines changes, and reuses the bundle when nothing did", () => {
    const { dependency, directory, entryPoint } = project()

    const first = bundleOnce({ entryPoint, directory })
    expect(readFileSync(first, "utf8")).toContain("first")
    // Nothing changed, so the second call neither rebuilds nor renames.
    expect(bundleOnce({ entryPoint, directory })).toBe(first)

    // The entry is untouched. Only the module it reaches through changes.
    writeFileSync(dependency, `export const greeting = "second"\n`)

    const second = bundleOnce({ entryPoint, directory })
    expect(second).not.toBe(first)
    expect(readFileSync(second, "utf8")).toContain("second")
    expect(readFileSync(second, "utf8")).not.toContain("first")
  })

  it("rebuilds when a file it was told to key on changes", () => {
    const { directory, entryPoint } = project()
    const manifest = join(directory, "..", "manifest.json")
    writeFileSync(manifest, `{"version":"1"}`)

    const first = bundleOnce({ entryPoint, directory, keyedOn: [manifest] })
    expect(bundleOnce({ entryPoint, directory, keyedOn: [manifest] })).toBe(first)

    writeFileSync(manifest, `{"version":"2"}`)

    expect(bundleOnce({ entryPoint, directory, keyedOn: [manifest] })).not.toBe(first)
  })

  it.each(["exports", "main"] as const)("rebuilds when only a dependency manifest's %s target changes", (field) => {
    const { directory, entryPoint } = project()
    const dependency = join(directory, "..", "node_modules", "greeting")
    mkdirSync(join(dependency, "src", "nested"), { recursive: true })
    const manifest = join(dependency, "package.json")
    writeFileSync(join(dependency, "src", "nested", "one.ts"), `export const greeting = "first"\n`)
    writeFileSync(join(dependency, "src", "nested", "two.ts"), `export const greeting = "second"\n`)
    writeFileSync(entryPoint, `import { greeting } from "greeting"\nconsole.log(greeting)\n`)
    writeFileSync(manifest, JSON.stringify({ name: "greeting", [field]: "./src/nested/one.ts" }))

    const first = bundleOnce({ entryPoint, directory })
    const run = (bundle: string): string => {
      const result = spawnSync(process.execPath, [bundle], { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      return result.stdout.trim()
    }
    expect(run(first)).toBe("first")
    expect(bundleOnce({ entryPoint, directory })).toBe(first)

    // Both target files already exist; only resolution changes.
    writeFileSync(manifest, JSON.stringify({ name: "greeting", [field]: "./src/nested/two.ts" }))
    const second = bundleOnce({ entryPoint, directory })
    expect(second).not.toBe(first)
    expect(run(second)).toBe("second")
    expect(bundleInputs(directory)).toContain(manifest)
    expect(bundleOnce({ entryPoint, directory })).toBe(second)

    writeFileSync(manifest, JSON.stringify({ name: "greeting", [field]: "./src/nested/one.ts" }))
    expect(run(bundleOnce({ entryPoint, directory }))).toBe("first")
  })

  it("rebuilds when an ancestor manifest is added, then tracks its package imports", () => {
    const { directory, entryPoint } = project()
    const manifest = join(entryPoint, "..", "package.json")
    const first = bundleOnce({ entryPoint, directory })

    writeFileSync(join(entryPoint, "..", "other.ts"), `export const greeting = "other"\n`)
    writeFileSync(manifest, JSON.stringify({ imports: { "#greeting": "./other.ts" } }))
    // Adding a package scope can change resolution without editing a source.
    expect(bundleOnce({ entryPoint, directory })).not.toBe(first)

    writeFileSync(entryPoint, `import { greeting } from "#greeting"\nconsole.log(greeting)\n`)
    const second = bundleOnce({ entryPoint, directory })
    expect(readFileSync(second, "utf8")).toContain("other")

    writeFileSync(join(entryPoint, "..", "last.ts"), `export const greeting = "last"\n`)
    writeFileSync(manifest, JSON.stringify({ imports: { "#greeting": "./last.ts" } }))
    const third = bundleOnce({ entryPoint, directory })
    expect(third).not.toBe(second)
    expect(readFileSync(third, "utf8")).toContain("last")
    expect(bundleInputs(directory)).toContain(manifest)
  })

  it("does not trust a source-only input record from an older cache", () => {
    const { dependency, directory, entryPoint } = project()
    const first = bundleOnce({ entryPoint, directory })
    // Recreate the old on-disk format: only the entry and its source dependency.
    const sources = [entryPoint, dependency].sort()
    const hash = createHash("sha256")
    for (const source of sources) hash.update(source).update("\0").update(readFileSync(source)).update("\0")
    const legacy = join(directory, `bundle-${hash.digest("hex").slice(0, 16)}.mjs`)
    renameSync(first, legacy)
    writeFileSync(join(directory, "inputs.json"), JSON.stringify(sources))
    const manifest = join(entryPoint, "..", "package.json")
    writeFileSync(manifest, JSON.stringify({ type: "module" }))

    const rebuilt = bundleOnce({ entryPoint, directory })
    expect(rebuilt).not.toBe(legacy)
    expect(bundleInputs(directory)).toContain(manifest)
    expect(readFileSync(rebuilt, "utf8")).toContain("first")
    expect(bundleOnce({ entryPoint, directory })).toBe(rebuilt)
  })

  it("names every bundle after its inputs, so concurrent workers never share an output path", () => {
    const one = project()
    const two = project()
    writeFileSync(two.dependency, `export const greeting = "other"\n`)

    expect(bundleOnce({ entryPoint: one.entryPoint, directory: one.directory }))
      .not.toBe(bundleOnce({ entryPoint: two.entryPoint, directory: two.directory }))
  })
})

describe("buildBin", () => {
  it("keys the CLI bundle on the workspace sources it inlines and on the manifest", () => {
    const directory = fileURLToPath(new URL("../node_modules/.migrate-bin/", import.meta.url))
    const source = fileURLToPath(new URL("../src/", import.meta.url))
    const root = fileURLToPath(new URL("../", import.meta.url))

    const bundle = buildBin()
    const inputs = bundleInputs(directory)

    expect(bundle.startsWith(directory)).toBe(true)
    expect(inputs.some((input) => input.startsWith(source))).toBe(true)
    // The bundled `@smthrs` dependencies, which are most of it and were the
    // part the old mtime rule never looked at.
    expect(inputs.filter((input) => !input.startsWith(root)).length).toBeGreaterThan(inputs.length / 2)
    expect(inputs).toContain(join(root, "package.json"))
  })
})
