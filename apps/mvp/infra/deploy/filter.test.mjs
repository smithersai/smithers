import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  assertFilter, assertInstalled, dependencyClosure, deploymentGraph, installArguments, requiredWorkspaces, root
} from "./filter.mjs"

const packageAt = (dir, name, dependencies = {}) => ({ dir, manifest: { name, dependencies } })
const fixtures = [
  packageAt("apps/web", "web", { cli: "workspace:*" }),
  packageAt("packages/cli", "cli"),
  packageAt("apps/terminal", "terminal", { cli: "workspace:*", adapter: "workspace:*" }),
  packageAt("packages/adapter", "adapter"),
  packageAt("apps/docs", "docs")
]
const targets = [{
  label: "//packages/cli:lib", package: "packages/cli", kinds: ["build"], outputs: ["dist"],
  inputs: [], dependencies: ["//packages/cli:terminalSources"]
}, {
  label: "//packages/cli:terminalSources", package: "packages/cli", kinds: [], outputs: [],
  inputs: [{ pattern: "apps/terminal/src/**/*.tsx" }], dependencies: []
}]

test("the deployment graph finds every package used by bundled workspace sources", () => {
  assert.deepEqual(requiredWorkspaces(fixtures, targets, ["apps/web", "apps/docs"]), [
    "apps/docs", "apps/terminal", "apps/web", "packages/adapter", "packages/cli"
  ])
})
test("a renamed or additional bundle is discovered through its build inputs", () => {
  const entries = [...fixtures, packageAt("apps/extra", "new-bundle", { adapter: "workspace:*" })]
  const changed = structuredClone(targets)
  changed[1].inputs.push({ path: "apps/extra/src/main.ts" })
  assert.ok(requiredWorkspaces(entries, changed, ["apps/web"]).includes("apps/extra"))
})
test("dependency cycles terminate; runtime, optional and development edges all count", () => {
  const entries = [packageAt("a", "a", { b: "workspace:*" }), packageAt("b", "b", { a: "workspace:*" })]
  entries[0].manifest.devDependencies = { c: "workspace:*" }
  entries.push(packageAt("c", "c"))
  entries[1].manifest.optionalDependencies = { d: "workspace:*" }
  entries.push(packageAt("d", "d"))
  assert.deepEqual([...dependencyClosure(entries, ["a"])].sort(), ["a", "b", "c", "d"])
  assert.throws(() => dependencyClosure(entries, ["absent"]), /missing workspace/)
  entries[0].manifest.dependencies.absent = "workspace:*"
  assert.throws(() => dependencyClosure(entries, ["a"]), /missing workspace dependency absent/)
})
test("a missing declaration target cannot silently produce an incomplete filter", () => {
  assert.throws(() => requiredWorkspaces(fixtures, targets.slice(0, 1), ["apps/web"]), /missing build target/)
})
test("the real former MVP filter omits the TUI and docs; the derived filter includes both closures", () => {
  const { packages, targets, directories } = deploymentGraph()
  assert.throws(() => assertFilter(packages, targets, ["apps/mvp"]), (error) =>
    error.message.includes("apps/tui") && error.message.includes("apps/site"))
  assertFilter(packages, targets, directories)
  const names = installArguments(packages, directories).filter((value) => value.endsWith("..."))
  assert.ok(names.includes("smithers..."))
  assert.ok(names.includes("smithers-tui..."))
  assert.ok(names.includes("@smithers/site..."))
  assert.ok(names.includes("@smthrs/mvp..."))
})
test("missing installs fail with the repair command before the deploy builds", () => {
  const entries = [packageAt("apps/web", "web", { external: "1.0.0" })]
  entries[0].manifest.devDependencies = { compiler: "1.0.0" }
  assert.throws(() => assertInstalled(entries, ["apps/web"], () => false), /deploy:install/)
  assert.doesNotThrow(() => assertInstalled(entries, ["apps/web"], () => true))
  assert.doesNotThrow(() => assertInstalled(entries, [], () => false))
})
test("install and build use the same dependency gate on plan and deploy", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "apps/mvp/package.json")))
  assert.equal(scripts["deploy:install"], "node infra/deploy/filter.mjs --install")
  assert.equal(scripts.plan, "node infra/deploy/run.mjs plan")
  assert.equal(scripts.deploy, "node infra/deploy/run.mjs deploy")
  assert.ok(scripts.test.includes("test:deploy"))
})


test("seeded workspace graphs retain every reachable bundle and dependency", () => {
  // Small deterministic graph generator: retain the seed in a failure.
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const entries = Array.from({ length: 8 }, (_, i) => packageAt(`packages/p${i}`, `p${i}`))
    const edges = entries.map(() => [])
    const bundles = entries.map(() => [])
    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < entries.length; j++) {
        if (next() % 7 === 0) {
          entries[i].manifest.dependencies[`p${j}`] = "workspace:*"
          edges[i].push(j)
        }
        if (next() % 11 === 0) bundles[i].push(j)
      }
    }
    const declarations = entries.map((entry, i) => ({
      label: `//${entry.dir}:lib`, package: entry.dir, kinds: ["build"], outputs: ["dist"],
      inputs: bundles[i].map((j) => ({ path: `packages/p${j}/src/index.ts` })), dependencies: []
    }))
    const expected = new Set([0])
    const pending = [0]
    while (pending.length) {
      const i = pending.pop()
      for (const j of [...edges[i], ...bundles[i]]) {
        if (!expected.has(j)) { expected.add(j); pending.push(j) }
      }
    }
    assert.deepEqual(requiredWorkspaces(entries, declarations, ["packages/p0"]),
      [...expected].map((i) => `packages/p${i}`).sort(), `seed ${seed}`)
  }
})
