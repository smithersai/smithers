/**
 * Recursive scripts must run through intentional package test dependencies.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const require = createRequire(import.meta.url)
const { parse, stringify } = require("yaml")
const workspace = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"))
const packageManager = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).packageManager

const run = (root, script) => spawnSync("pnpm", ["--recursive", "--if-present", "run", script], {
  cwd: root,
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, CI: "true", FORCE_COLOR: "0" }
})

test("recursive scripts can select the real workspace through its test dependency cycles", () => {
  const result = run(repoRoot, "__workspace_cycle_contract_absent__")
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test("recursive scheduling runs every package once for generated cyclic and acyclic graphs", () => {
  const fc = require("fast-check")
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 6 }),
    fc.boolean(),
    fc.array(fc.boolean(), { minLength: 0, maxLength: 12 }),
    (count, cyclic, extras) => {
      const root = mkdtempSync(join(tmpdir(), "workspace-cycle-contract-"))
      try {
        writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager }))
        writeFileSync(join(root, "pnpm-workspace.yaml"), stringify({
          packages: ["packages/*"],
          verifyDepsBeforeRun: false,
          ignoreWorkspaceCycles: workspace.ignoreWorkspaceCycles ?? false
        }))
        const names = Array.from({ length: count }, (_, index) => "cycle-contract-" + index)
        for (let index = 0; index < count; index++) {
          const dir = join(root, "packages", names[index])
          mkdirSync(dir, { recursive: true })
          const dependencies = {}
          if (cyclic || index + 1 < count) dependencies[names[(index + 1) % count]] = "workspace:*"
          for (let other = index + 2; other < count; other++) {
            if (extras[(index + other) % Math.max(extras.length, 1)]) dependencies[names[other]] = "workspace:*"
          }
          const code = 'const fs = require("node:fs"); const count = fs.existsSync("execution.json") ? ' +
            'JSON.parse(fs.readFileSync("execution.json", "utf8")).count : 0; ' +
            'fs.writeFileSync("execution.json", JSON.stringify({ name: ' + JSON.stringify(names[index]) +
            ', count: count + 1 }))'
          writeFileSync(join(dir, "package.json"), JSON.stringify({
            name: names[index],
            private: true,
            version: "1.0.0",
            devDependencies: dependencies,
            scripts: { probe: "node -e " + "'" + code + "'" }
          }))
        }
        const result = run(root, "probe")
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0, result.stdout + result.stderr)
        for (const name of names) {
          assert.deepEqual(JSON.parse(readFileSync(join(root, "packages", name, "execution.json"), "utf8")), { name, count: 1 })
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  ), { numRuns: 50, examples: [[2, true, []], [3, false, []]] })
})
