import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build } from "esbuild"
import { assertTuiImports, buildTui, declaredDependenciesExternal } from "./build-tui.mjs"

const bundled = (directory, declared) => build({
  entryPoints: [join(directory, "src/index.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  metafile: true,
  logLevel: "silent",
  plugins: [declaredDependenciesExternal(declared)]
})

const fixture = async (body) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "smithers-tui-external-"))
  try {
    await mkdir(join(directory, "src"))
    await writeFile(join(directory, "package.json"), JSON.stringify({ imports: {
      "#native": { types: "./src/native.d.ts", default: "optional-native/host" },
      "#local": { default: "./src/local.js" }
    } }))
    await writeFile(join(directory, "src/local.js"), "export const local = 1\n")
    await writeFile(join(directory, "src/index.js"), "export const load = () => import(\"#native\")\nexport { local } from \"#local\"\n")
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("a declared package reached through a package import stays external and a relative one is inlined", () =>
  fixture(async (directory) => {
    const { outputFiles: [output] } = await bundled(directory, new Set(["optional-native"]))
    assert.match(output.text, /import\("optional-native\/host"\)/)
    assert.match(output.text, /local = 1/)
  }))

test("an undeclared package reached through a package import is not hidden as external", () =>
  fixture(async (directory) => {
    await assert.rejects(bundled(directory, new Set()), /Could not resolve/)
  }))

test("the real TUI entry bundles with only declared dependencies and esbuild's optional PnP probe", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...manifest.smthrs.privateEffectAdapters
  ])
  const metafile = await buildTui()
  const probes = Object.entries(metafile.inputs).flatMap(([importer, input]) =>
    input.imports.filter(({ path }) => path === "pnpapi").map((entry) => ({ importer, ...entry })))
  assert.ok(probes.length > 0, "the real bundle exercises the optional PnP import")
  for (const probe of probes) {
    assert.match(probe.importer, /(?:^|[/\\])esbuild[/\\]lib[/\\]main\.js$/)
    assert.equal(probe.kind, "require-call")
    assert.equal(probe.external, true)
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const entry of output.imports) {
      if (!entry.external || entry.path.startsWith(".") || /^(node|bun):/.test(entry.path)) continue
      if (builtinModules.includes(entry.path) || entry.path === "@smthrs/cli/tui-native") continue
      if (entry.path === "pnpapi") {
        assert.equal(entry.kind, "require-call")
        continue
      }
      const name = entry.path.split("/").slice(0, entry.path.startsWith("@") ? 2 : 1).join("/")
      assert.ok(declared.has(name), "undeclared TUI import: " + entry.path)
    }
  }
})

for (const specifier of ["pnpapi", "pnpapi/subpath", "missing-environment-probe"]) {
  test("an optional require of " + specifier + " outside esbuild remains undeclared", () =>
    fixture(async (directory) => {
      await writeFile(join(directory, "src/index.js"), "try { require(" + JSON.stringify(specifier) + ") } catch {}\n")
      const result = await bundled(directory, new Set())
      assert.throws(() => assertTuiImports(result.metafile, new Set()), /does not declare/)
    }))
}
