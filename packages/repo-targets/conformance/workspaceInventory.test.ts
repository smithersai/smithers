import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { readWorkspaceInventory } from "./readWorkspaceInventory.ts"

it("includes nested and config-less packages while excluding installed dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-workspace-inventory-"))
  try {
    for (const name of ["smithers", "smithers/flows", "smithers/flows/new-engine", "smithers/node_modules/installed"]) {
      const path = join(root, "packages", name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, "package.json"), JSON.stringify({ name, smthrs: { group: "engine" } }))
    }
    writeFileSync(join(root, "packages/smithers/flows/vitest.config.ts"), "export default {}")
    const inventory = readWorkspaceInventory(root)
    assert.equal(inventory.packagesDir, join(root, "packages"))
    assert.deepEqual(inventory.manifests.map(({ name }) => name), [
      "smithers",
      "smithers/flows",
      "smithers/flows/new-engine"
    ])
    assert.deepEqual(inventory.packages, inventory.manifests.map(({ name }) => name))
    assert.equal(inventory.configs.find(({ name }) => name === "smithers/flows/new-engine")?.source, "")
    assert.equal(inventory.configs.find(({ name }) => name === "smithers/flows")?.source, "export default {}")
    assert.equal(inventory.manifests[2]?.manifest.smthrs?.group, "engine")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps non-library members in the full inventory used by barrel and containment checks", () => {
  const inventory = readWorkspaceInventory()
  for (const name of ["rpc", "smithers/ui", "smithers/ui/ui-styleguide", "smithers/ui/repo-view", "smithers/ui/terminal-frame", "smithers/build/infra"]) {
    assert.ok(inventory.manifests.some((entry) => entry.name === name))
    assert.ok(!inventory.packages.includes(name))
  }
  assert.ok(inventory.packages.includes("smithers/flows"))
  assert.ok(inventory.packages.includes("smithers/flows/kernel"))
})

for (const name of ["repo-view", "terminal-frame"]) {
  it(`the private ${name} UI package retains its source exports and enforced Bun coverage`, () => {
    const { packagesDir, manifests } = readWorkspaceInventory()
    const directory = join(packagesDir, "smithers/ui", name)
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
    assert.ok(manifests.some((entry) => entry.name === `smithers/ui/${name}`))
    assert.equal(manifest.private, true)
    assert.deepEqual(manifest.exports["."], {
      types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts"
    })
    assert.equal(manifest.scripts.test, "bun test --isolate test")
    const config = readFileSync(join(directory, "bunfig.toml"), "utf8")
    assert.match(config, /^coverage = true$/m)
    assert.match(config, /^coverageThreshold = \{ lines = 1\.0, functions = 1\.0 \}$/m)
    const declaration = readFileSync(join(directory, "PACKAGE.ts"), "utf8")
    assert.match(declaration, /const unitTests = Smithers\.NodeTest\(\{\s*runtime: Smithers\.Runtime\.Bun\(/)
    assert.match(declaration, /runner: Smithers\.testSuite\(\["test"\], \{ isolate: true \}\)/)
    assert.match(declaration, /targets: \{[\s\S]*?\bunitTests\b/)
  })
}
