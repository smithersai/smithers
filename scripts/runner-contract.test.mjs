/** Sentinel failures travel through the real CLI, target interpreter and test runtimes. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { repoRoot as root } from "./workspace-packages.mjs"

const cli = join(root, "packages/smithers/src/bin.ts")
const scratchRoots = new Map()
function write(directory, path, body) {
  mkdirSync(dirname(join(directory, path)), { recursive: true })
  writeFileSync(join(directory, path), body)
}
function fixture(modules = "node_modules") {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "smithers-runner-contract-")))
  // Preserve pnpm's relative .bin layout while reusing only existing links.
  const directory = join(scratch, dirname(modules))
  mkdirSync(directory, { recursive: true })
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir")
  if (directory !== scratch) symlinkSync(join(root, modules), join(directory, "node_modules"), "dir")
  scratchRoots.set(directory, scratch)
  write(directory, "package.json", '{"type":"module"}\n')
  // Reuse the installed tools without pnpm 11's implicit dependency install.
  write(directory, "pnpm-workspace.yaml", "verifyDepsBeforeRun: false\n")
  write(directory, ".gitignore", ".flows/\nnode_modules/\n")
  write(directory, "WORKSPACE.ts", `import { Smithers as S } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@smthrs/targets")))}
export const Workspace = S.Workspace("runner-contract", {
  repository: "git+https://example.invalid/runner-contract.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=22.19.0" }),
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime: S.Runtime.Node({ version: ">=22.19.0" }) }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  ${modules === "node_modules" ? "" : "sandboxes: S.Sandboxes({ default: S.Sandbox.None() })"}
})
`)
  return directory
}
function removeFixture(directory) {
  rmSync(scratchRoots.get(directory), { recursive: true, force: true })
  scratchRoots.delete(directory)
}
function declaration(directory, target) {
  write(directory, "PACKAGE.ts", `import { Smithers as S } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@smthrs/targets")))}
export const Package = S.Package({ targets: { sentinel: ${target} } })\n`)
}
function run(directory, name) {
  // Failure sentinels need the complete diagnostic tail: Playwright can emit
  // installation output before the assertion that this contract must observe.
  const result = spawnSync(process.execPath, [cli, "test", "//:sentinel", "--workspace", directory, "--json", "--verbose"], {
    cwd: directory, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" }
  })
  const log = join(tmpdir(), `smithers-runner-${process.pid}-${name}.log`)
  writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`)
  assert.ifError(result.error)
  console.log(`${name}: exit ${result.status}; ${log}`)
  return { ...result, text: result.stdout + result.stderr }
}

test("server Bun assertion failure reaches the selected NodeTest runner", () => {
  const directory = fixture()
  try {
    declaration(directory, 'S.NodeTest({ runtime: S.Runtime.Bun({ version: ">=1.4.0" }), runner: S.testSuite(["src", "scripts"]), srcs: [S.glob("src/**"), S.glob("scripts/**")], deps: [] })')
    write(directory, "src/sentinel.test.ts", 'import { test, expect } from "bun:test"; test("server sentinel", () => expect(2 + 2).toBe(5))\n')
    write(directory, "scripts/fixture.ts", "export {}\n")
    const result = run(directory, "server")
    assert.equal(result.status, 1, result.text)
    assert.match(result.text, /server sentinel/)
    assert.match(result.text, /Expected: 5/)
    assert.match(result.text, /targets_failed/)
  } finally { removeFixture(directory) }
})

test("coverage failure reaches Vitest and the real target runner despite passing assertions", () => {
  const directory = fixture("packages/smithers/gateway/node_modules")
  try {
    declaration(directory, 'S.Vitest({ tests: [S.glob("test/**")], sources: [S.glob("src/**")], deps: [], config: S.file("vitest.config.mjs"), environment: "node", passWithNoTests: false })')
    write(directory, "src/classify.mjs", 'export const classify = value => value ? "yes" : "no"\n')
    write(directory, "test/sentinel.test.mjs", 'import { expect, test } from "vitest"; import { classify } from "../src/classify.mjs"; test("coverage sentinel assertion passes", () => expect(classify(true)).toBe("yes"))\n')
    write(directory, "vitest.config.mjs", 'export default { test: { maxWorkers: 1, coverage: { enabled: true, provider: "v8", include: ["src/**"], thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 } } } }\n')
    const result = run(directory, "coverage")
    assert.equal(result.status, 1, result.text)
    assert.match(result.text, /1 passed/)
    assert.match(result.text, /Coverage for branches.*does not meet/)
    assert.match(result.text, /targets_failed/)
  } finally { removeFixture(directory) }
})

test("browser assertion failure travels through the PR entrypoint, Playwright and NodeTest", () => {
  const directory = fixture("apps/ui/node_modules")
  try {
    declaration(directory, 'S.NodeTest({ runner: S.entrypoint(S.file("scripts/run-pr-e2e.mjs")), srcs: [S.glob("tests/**"), S.file("playwright.config.ts")], deps: [] })')
    write(directory, "scripts/run-pr-e2e.mjs", readFileSync(join(root, "apps/ui/scripts/run-pr-e2e.mjs")))
    write(directory, "playwright.config.ts", 'export default { testDir: "tests", workers: 1, retries: 0, reporter: [["list"], ["json", { outputFile: "browser-results.json" }]], use: { headless: true } }\n')
    write(directory, "tests/sentinel.spec.ts", 'import { test, expect } from "@playwright/test"; test("browser sentinel", async ({ page }) => { await page.setContent("<h1>actual page</h1>"); await expect(page.locator("h1")).toHaveText("wrong page", { timeout: 100 }); })\n')
    const result = run(directory, "browser")
    assert.equal(result.status, 1, result.text)
    assert.match(result.text, /browser sentinel/)
    const report = readFileSync(join(directory, "browser-results.json"), "utf8")
    writeFileSync(join(tmpdir(), `smithers-runner-${process.pid}-browser.json`), report)
    assert.equal(JSON.parse(report).stats.unexpected, 1)
    assert.match(report, /actual page/)
    assert.match(report, /wrong page/)
    assert.match(result.text, /targets_failed/)
  } finally { removeFixture(directory) }
})

test("warmed build-result cache invalidates helper, config and declared property seed inputs", () => {
  const directory = fixture()
  try {
    const declare = (seed) => declaration(directory, `S.Shell.Test({ script: S.file("sentinel.mjs"), data: [S.file("helper.mjs"), S.file("fixture.json"), S.file("config.json")], env: { PROPERTY_SEED: ${JSON.stringify(seed)} } })`)
    write(directory, "sentinel.mjs", 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import { value } from "./helper.mjs"; assert.equal(value, 4, "helper sentinel"); assert.equal(JSON.parse(readFileSync("config.json")).allowed, true, "config sentinel"); assert.equal(JSON.parse(readFileSync("fixture.json")).expected, 4, "fixture sentinel"); assert.equal(process.env.PROPERTY_SEED, "7", "seed sentinel"); console.log("performed assertion work")\n')
    write(directory, "helper.mjs", "export const value = 4\n")
    write(directory, "config.json", '{"allowed":true}\n')
    write(directory, "fixture.json", '{"expected":4}\n')
    declare("7")
    assert.equal(run(directory, "cache-cold").status, 0)
    const warm = run(directory, "cache-warm")
    assert.equal(warm.status, 0, warm.text)
    assert.match(warm.text, /"hit":\s*1/, "must prove a real cache hit, not merely two successful runs")
    for (const [name, path, bad, good] of [
      ["helper", "helper.mjs", "export const value = 5\n", "export const value = 4\n"],
      ["config", "config.json", '{"allowed":false}\n', '{"allowed":true}\n'],
      ["fixture", "fixture.json", '{"expected":5}\n', '{"expected":4}\n']
    ]) {
      write(directory, path, bad)
      const result = run(directory, `cache-${name}`)
      assert.equal(result.status, 1, result.text)
      assert.match(result.text, new RegExp(`${name} sentinel`))
      write(directory, path, good)
      assert.equal(run(directory, `cache-restored-${name}`).status, 0)
    }
    declare("8")
    const result = run(directory, "cache-seed")
    assert.equal(result.status, 1, result.text)
    assert.match(result.text, /seed sentinel/)
  } finally { removeFixture(directory) }
})
