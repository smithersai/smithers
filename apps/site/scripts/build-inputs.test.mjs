/**
 * Plan the site's actual declared inputs without running Astro.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { installEffectResolution } from "../../../packages/smithers/build/build-cli/src/effect-resolution.js"

installEffectResolution()
const { Smithers: S } = await import("@smthrs/targets")
const { metadata } = await import("@smthrs/targets/Target")
const { Package } = await import("../PACKAGE.ts")
const { PackageIndex } = await import("../../../packages/smithers/build/build-cli/src/PackageIndex.ts")
const { plan } = await import("../../../packages/smithers/build/build-cli/src/internal/PackagePlanner.ts")

test("site build inputs change identity when screenshot bytes or membership change", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-site-inputs-"))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  try {
    for (const path of [
      "package.json", "yarn.lock", "CHANGELOG.md", "apps/site/PACKAGE.ts",
      "apps/site/astro.config.mjs", "apps/site/package.json", "apps/site/tsconfig.json"
    ]) put(path, path.endsWith(".json") ? "{}" : "")
    const screenshot = "apps/site/docs/app/images/settings.light.webp"
    put(screenshot, "before")
    // Use the build declaration itself, so a dropped input breaks this test.
    // A filegroup isolates input planning from tool discovery and execution.
    const inputs = S.Filegroup({ cwd: "apps/site", srcs: metadata(Package.build).inputs })
    const packageJson = S.file("//package.json")
    const index = PackageIndex.make({
      root,
      workspace: S.Workspace("site-inputs", {
        repository: "git+https://example.invalid/site-inputs.git",
        cache: S.Cache({ directory: ".flows" }),
        runtime: S.Runtime.Node({ version: ">=26.4.0" }),
        packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
        nodeModules: S.Npm.NodeModules({ packageJson })
      }),
      factory: undefined,
      packages: [{ file: "apps/site/PACKAGE.ts", packagePath: "apps/site", value: S.Package({ targets: { inputs } }) }]
    })
    const inspect = async () => (await plan({
      index, cacheDirectory: ".flows", verb: "auto", patterns: ["//apps/site:inputs"]
    })).nodes.get("//apps/site:inputs")
    const first = await inspect()
    assert.ok(first.declaredInputs.flatMap((input) => input.files.map((file) => file.path)).includes(screenshot), "the copied screenshot must be a declared build input")
    put(screenshot, "after!")
    const changed = await inspect()
    assert.notEqual(changed.keyPreview, first.keyPreview, "replacing screenshot bytes must invalidate the build inputs")
    put(screenshot, "before")
    assert.equal((await inspect()).keyPreview, first.keyPreview)
    const added = "apps/site/docs/app/images/settings.dark.webp"
    put(added, "dark")
    assert.notEqual((await inspect()).keyPreview, first.keyPreview, "adding a screenshot must invalidate the build inputs")
    rmSync(join(root, added))
    assert.equal((await inspect()).keyPreview, first.keyPreview)
    rmSync(join(root, screenshot))
    assert.notEqual((await inspect()).keyPreview, first.keyPreview, "removing a screenshot must invalidate the build inputs")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
