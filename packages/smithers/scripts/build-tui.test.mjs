import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { build } from "esbuild"
import { declaredDependenciesExternal } from "./build-tui.mjs"

const bundled = (directory, declared) => build({
  entryPoints: [join(directory, "src/index.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
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
