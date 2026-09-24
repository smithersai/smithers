/**
 * What every template's Worker needs to run a real turn under workerd.
 *
 * workerd instantiates only WebAssembly its toolchain compiled, so a Worker
 * that runs cells imports the QuickJS `.wasm` export as a module. That needs
 * the `CompiledWasm` rule in `wrangler.jsonc` and both QuickJS packages in the
 * template's dependencies; missing either, a deployed turn dies before it
 * reaches the model while every Node test stays green. The aomi template once
 * shipped a canned turn behind `APP_MOCK_TURN`, on by default; no template may
 * carry that switch again.
 */
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const templates = fileURLToPath(new URL("../template", import.meta.url))
const names = readdirSync(templates).filter((name) => statSync(join(templates, name)).isDirectory())

const files = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

describe.each(names)("the %s template's Worker", (name) => {
  const root = join(templates, name)

  it("bundles the QuickJS wasm export as a compiled module", () => {
    const wrangler = readFileSync(join(root, "worker/wrangler.jsonc"), "utf8")
    expect(wrangler).toContain("\"CompiledWasm\"")
    expect(wrangler).toContain("\"@jitl/quickjs-wasmfile-release-sync/wasm\"")
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>
    }
    expect(Object.keys(manifest.dependencies)).toEqual(
      expect.arrayContaining(["@jitl/quickjs-wasmfile-release-sync", "quickjs-emscripten-core"])
    )
  })

  it("has no mock-turn switch", () => {
    const mentions = files(root).filter((path) => readFileSync(path, "utf8").includes("APP_MOCK_TURN"))
    expect(mentions).toEqual([])
  })
})
