import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import { satisfies } from "semver"
import { readWorkspaceManifests } from "./pack-release.mjs"

/** The CLI dependency graph supports Node 22 LTS; the TUI gates FFI separately. */
const supported = ">=22.19.0"

test("the complete CLI dependency closure declares the supported Node range", () => {
  const manifests = readWorkspaceManifests()
  assert.ok([...manifests.values()].some((manifest) => manifest.name === "@smthrs/cli"))
  const byName = new Map([...manifests.values()].map(manifest => [manifest.name, manifest]))
  const seen = new Set()
  const visit = name => {
    if (seen.has(name) || !byName.has(name)) return
    seen.add(name)
    const manifest = byName.get(name)
    assert.equal(manifest.engines.node, supported, name)
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) visit(dependency)
  }
  visit("smthrs")
  assert.ok(seen.has("@smthrs/cli"))
  const outside = [...byName.values()].filter(manifest => !seen.has(manifest.name))
  assert.deepEqual(outside.map(manifest => manifest.name).sort(), ["@smthrs/platform-browser", "@smthrs/platform-cloudflare", "@smthrs/testing"])
  for (const manifest of outside) assert.equal(manifest.engines.node, ">=26.4.0", manifest.name)
})

test("the cell and view compilers' parsers accept the supported Node floor", () => {
  for (const [path, dependencies] of [
    ["../../../packages/smithers/agent/harness/package.json", ["@babel/parser", "@babel/types"]],
    ["../../../packages/smithers/ui/views/package.json", ["@babel/parser", "sucrase"]]
  ]) {
    const require = createRequire(new URL(path, import.meta.url))
    for (const dependency of dependencies) {
      const range = require(`${dependency}/package.json`).engines.node
      assert.ok(satisfies("22.19.0", range), `${dependency} requires node ${range}; recheck the public support range`)
    }
  }
})
