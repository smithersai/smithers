/**
 * Every suite in this workspace is reachable from a command CI runs.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/test-script-wiring-gate`
 * suite. The defect it guards is the quiet one: a package with a `test/`
 * directory and no `scripts.test` never runs, and every config-level assertion
 * about it stays green while it does. The 0.x version drove a standalone
 * `check-smithers-test-script.mjs` against synthetic fixtures; the script is
 * gone, so what survives is the claim itself, checked against the real tree.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, delimiter, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { parseWorkflow } from "../release-rehearsal.mjs"
import { fileURLToPath } from "node:url"
import { verifySignalCampaign } from "../check-signal-campaign.mjs"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

/** Every workspace member the root manifest's globs name. */
const members = rootManifest.workspaces.flatMap((glob) => {
  if (!glob.endsWith("/*")) return existsSync(join(root, glob, "package.json")) ? [glob] : []
  const parent = glob.slice(0, -2)
  if (!existsSync(join(root, parent))) return []
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}`)
})

const hasTests = (directory) => {
  const candidates = ["test", "tests", "src/test"]
  return candidates.some((name) => {
    const path = join(root, directory, name)
    return existsSync(path) && statSync(path).isDirectory()
  })
}

describe("test-script wiring", () => {
  it("finds the workspace members the root manifest declares", () => {
    assert.ok(members.length > 20, `expected a populated workspace, found ${members.length}`)
  })

  it("gives every member with a test directory a test script", () => {
    for (const directory of members) {
      if (!hasTests(directory)) continue
      const manifest = readManifest(join(root, directory, "package.json"))
      assert.ok(
        manifest.scripts?.test,
        `${directory} has tests and no scripts.test, so nothing in CI runs them`
      )
    }
  })

  it("keeps the root aggregators fanning out recursively", () => {
    assert.equal(rootManifest.scripts.test, "pnpm --recursive --if-present run test")
    assert.equal(rootManifest.scripts.check, "pnpm --recursive --if-present run check")
    assert.equal(rootManifest.scripts.lint, "pnpm --recursive --if-present run lint")
  })

  it("keeps the pnpm workspace globs and the root manifest globs identical", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    const block = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.ok(block, "pnpm-workspace.yaml must declare a packages block")
    const globs = block
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4).replaceAll("\"", ""))
    assert.deepEqual(
      globs,
      rootManifest.workspaces,
      "pnpm installs what pnpm-workspace.yaml names and the recursive scripts fan out over the same set; "
        + "a member in one and not the other is installed but never tested, or tested and never installed"
    )
  })
})

/** Every `*.test.*` file under `directory`, repository-relative. */
const testFiles = (directory, extension) =>
  readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(`.test${extension}`) && !entry.parentPath.includes("node_modules"))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort()

/**
 * Test files deliberately outside every target, with the reason. A suite that
 * no target names never runs, so the default is an owner, not an entry here.
 */
const unownedTests = new Map([])

describe("test-file ownership", () => {
  const declarations = ["PACKAGE.ts", "scripts/PACKAGE.ts", "scripts/repo-contract/PACKAGE.ts"]
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("\n")
  const suites = [...testFiles("scripts", ".mjs"), ...testFiles("factory", ".ts")]

  it("finds the script and factory suites", () => {
    assert.ok(suites.includes("scripts/pack-release.test.mjs"))
    assert.ok(suites.includes("factory/flows/harness.test.ts"))
  })

  it("names every script and factory suite in a target's test runner", () => {
    const orphans = suites.filter((path) => !unownedTests.has(path) && !declarations.includes(`Smithers.file("//${path}")`))
    assert.deepEqual(orphans, [], "each suite needs a Smithers.testRunner entry or a reasoned unownedTests entry")
  })

  it("keeps the exclusion list free of owned or deleted suites", () => {
    for (const path of unownedTests.keys()) assert.ok(suites.includes(path) && !declarations.includes(`//${path}"`), path)
  })

  it("selects the owning targets in the required test job", () => {
    const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))
    assert.notEqual(workflow.jobs.test["continue-on-error"], true)
    const main = workflow.jobs.test.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    assert.match(main, /smthrs test '\/\/scripts\/\.\.\.'/)
    assert.match(main, /smthrs test '\/\/:factoryHarness'/)
  })
})


describe("required PR selection", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))
  const runs = (job) => workflow.jobs[job].steps.flatMap((step) => step.run ? [step.run] : [])
  it("keeps server CI required while selecting the UI tiers once in their earlier Ubuntu job", () => {
    const main = runs("test").join("\n")
    assert.doesNotMatch(main, /\/\/apps\/ui:(?:check|unitTests)/)
    assert.match(main, /(?:smthrs|smithers-build) ci '\/\/apps\/server\/\.\.\.'/)
    assert.notEqual(workflow.jobs.test["continue-on-error"], true)
    const ui = workflow.jobs["apps-e2e"]
    assert.equal(ui["runs-on"], "ubuntu-latest")
    assert.equal(ui.needs, undefined, "UI diagnostics must not wait behind the workspace graph")
    const targets = ui.steps.filter((step) => /(?:smthrs|smithers-build) (?:build|test) /.test(step.run ?? ""))
    assert.deepEqual(targets.map((step) => step.run), [
      "pnpm exec smthrs build '//apps/ui:check' --verbose",
      "pnpm exec smthrs test '//apps/ui:unitTests' --verbose",
      "pnpm exec smthrs test '//apps/ui:browserE2e' --verbose"
    ])
    for (const step of targets) {
      assert.equal(step.if, undefined)
      assert.equal(step["continue-on-error"], undefined)
      const occurrences = Object.values(workflow.jobs).flatMap((job) => job.steps)
        .filter((entry) => entry.run === step.run)
      assert.equal(occurrences.length, 1, `${step.name} must run once in required CI`)
    }
    for (const tool of ["jj-cli@0.39.0", "ripgrep@14.1.1"])
      assert.ok(ui.steps.some((step) => step.with?.tool === tool), `preserve ${tool}`)
    assert.ok(runs("apps-e2e").some((run) => run.includes("'bubblewrap'")))
  })
  it("the browser job selects the target that executes actual Playwright", () => {
    assert.match(runs("apps-e2e").join("\n"), /(?:smthrs|smithers-build) test '\/\/apps\/ui:browserE2e'/)
    assert.notEqual(workflow.jobs["apps-e2e"]["continue-on-error"], true)
    const declaration = readFileSync(join(root, "apps/ui/PACKAGE.ts"), "utf8")
    assert.match(declaration, /browserE2e = Smithers\.NodeTest/)
    assert.match(declaration, /entrypoint\(Smithers\.file\("scripts\/run-pr-e2e\.mjs"\)/)
    const executable = readFileSync(join(root, "apps/ui/scripts/run-pr-e2e.mjs"), "utf8")
    assert.match(executable, /\["exec", "playwright", "test"\]/)
    assert.match(executable, /SMITHERS_CHAT_STUB: "1"/)
  })
})


it("the selected browser executable installs its matching browser then runs Playwright and propagates failure", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-pr-browser-"))
  try {
    const fake = join(temporary, "pnpm")
    const calls = join(temporary, "calls")
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BROWSER_TEST_CALLS"\nif [ "$3" = "test" ]; then exit 23; fi\n')
    chmodSync(fake, 0o755)
    assert.throws(() => execFileSync(process.execPath, [join(root, "apps/ui/scripts/run-pr-e2e.mjs")], {
      cwd: join(root, "apps/ui"), env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, BROWSER_TEST_CALLS: calls }, stdio: "pipe"
    }), (error) => error.status === 23)
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["exec playwright install --with-deps chromium", "exec playwright test"])
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

it("UI typecheck skips TypeScript when strict devkit preparation fails in a clean projection", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-ui-devkit-refusal-"))
  const write = (path, contents) => {
    const destination = join(temporary, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
    return destination
  }
  try {
    write("package.json", JSON.stringify({
      name: "ui-devkit-refusal", private: true, type: "module", packageManager: rootManifest.packageManager
    }))
    copyFileSync(join(root, "pnpm-lock.yaml"), join(temporary, "pnpm-lock.yaml"))
    write("WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("ui-devkit-refusal", {
  repository: "git+https://example.invalid/ui-devkit-refusal.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=22.19.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`)
    // The declaration and strict preparer are the production files. The
    // fixture supplies no SDK and never compiles substitute SDK declarations.
    for (const path of ["PACKAGE.ts", "scripts/ensure-devkit.mjs", "package.json", "tsconfig.json", "electrobun.config.ts", "hutch.config.ts"]) {
      const destination = write(`apps/ui/${path}`, "")
      copyFileSync(join(root, "apps/ui", path), destination)
    }
    // These are declared inputs of the unreachable compiler, not test doubles
    // for its output. Only preparation is allowed to execute in this schedule.
    for (const path of ["vite.config.ts", "tailwind.config.js", "postcss.config.js", "playwright.config.ts"])
      write(`apps/ui/${path}`, "export {}\n")
    write("apps/ui/node_modules/electrobun/package.json", JSON.stringify({ version: "2.0.1" }))
    write("apps/ui/node_modules/electrobun/bin/electrobun.cjs", `const fs = require("node:fs")
fs.writeFileSync("preparer-called.json", JSON.stringify({ args: process.argv.slice(2), noUpdate: process.env.HUTCH_NO_UPDATE_CHECK }))
process.exit(23)
`)
    const tscMarker = join(temporary, "tsc-called")
    const pnpm = write("bin/pnpm", `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
if (process.argv[2] === "--version") console.log(${JSON.stringify(rootManifest.packageManager.split("@").at(-1))})
else { writeFileSync(${JSON.stringify(tscMarker)}, JSON.stringify(process.argv.slice(2))); process.exit(91) }
`)
    chmodSync(pnpm, 0o755)
    assert.equal(existsSync(join(temporary, "apps/ui/.hutch")), false)
    let failure
    try {
      execFileSync(process.execPath, [join(root, "packages/smithers/src/bin.ts"), "build", "//apps/ui:check", "--workspace", temporary, "--no-cache", "--verbose"], {
        cwd: temporary, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: `${join(temporary, "bin")}${delimiter}${process.env.PATH}`, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" },
        stdio: "pipe"
      })
    } catch (error) { failure = error }
    assert.ok(failure, "failed preparation must fail the selected build")
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
    assert.equal(failure.status, 1, output)
    assert.deepEqual(readManifest(join(temporary, "apps/ui/preparer-called.json")), { args: ["prepare"], noUpdate: "1" })
    assert.match(output, /electrobun prepare exited 23/)
    assert.match(output, /\/\/apps\/ui:devkit  failed/)
    assert.match(output, /\/\/apps\/ui:check  skipped/)
    assert.equal(existsSync(tscMarker), false, "the real scheduler must not launch TypeScript after preparation fails")
    assert.equal(existsSync(join(temporary, "apps/ui/.hutch")), false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})


it("scheduled durable histories retain reproducible seeds and operation artifacts", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/reliability.yml"), "utf8"))
  assert.ok(workflow.on.schedule[0].cron)
  const job = workflow.jobs["signal-state-machine"]
  const steps = job.steps
  const campaign = steps.find((step) => step.name === "Run generated durable histories")
  assert.match(campaign.run, /@smthrs\/control exec vitest run test\/SignalInboxModel\.test\.ts/)
  assert.match(campaign.env.SMITHERS_FUZZ_ARTIFACT_DIR, /reliability-artifacts/)
  const seed = steps.find((step) => step.name === "Select and record reproducible campaign").run
  assert.match(seed, /SMITHERS_FUZZ_SEED=/)
  assert.match(seed, /SMITHERS_FUZZ_CASES=50/)
  assert.match(seed, /SMITHERS_FUZZ_STEPS=500/)
  const artifact = steps.find((step) => step.name === "Preserve history and seed evidence")
  assert.equal(artifact.if, "always()")
  assert.match(artifact.with.path, /reliability-results\.json/)
  assert.match(artifact.with.path, /reliability-artifacts/)
  assert.equal(artifact.with["if-no-files-found"], "error")
  assert.match(steps.find((step) => step.name === "Verify complete campaign evidence").run, /check-signal-campaign\.mjs reliability-artifacts/)
  assert.match(steps.find((step) => step.name === "Prove signal transition mutation sensitivity").run, /check-signal-mutations\.mjs/)
  assert.notEqual(job["continue-on-error"], true)
})

it("campaign evidence refuses a missing case, truncated history, wrong seed and failed result", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-campaign-evidence-"))
  try {
    const first = { status: "passed", seed: 7, steps: 2, history: [{ kind: "reopen" }, { kind: "admit" }], reopenCount: 1, finalState: [] }
    const secondSeed = (7 + Math.imul(1, 0x9e3779b9)) >>> 0
    const second = { ...first, seed: secondSeed }
    const firstPath = join(temporary, "signal-inbox-7.json")
    const secondPath = join(temporary, `signal-inbox-${secondSeed}.json`)
    const configuration = { seed: 7, cases: 2, steps: 2 }
    writeFileSync(firstPath, JSON.stringify(first))
    await assert.rejects(verifySignalCampaign(temporary, configuration), /ENOENT/)
    writeFileSync(secondPath, JSON.stringify(second))
    assert.deepEqual(await verifySignalCampaign(temporary, configuration), configuration)
    for (const change of [{ history: [] }, { seed: 8 }, { status: "failed" }, { steps: 1 }, { reopenCount: 0 }]) {
      writeFileSync(firstPath, JSON.stringify({ ...first, ...change }))
      await assert.rejects(verifySignalCampaign(temporary, configuration), /Incomplete signal campaign evidence/)
    }
    await assert.rejects(verifySignalCampaign(temporary, { ...configuration, seed: 4294967296 }), /Invalid signal campaign configuration/)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
