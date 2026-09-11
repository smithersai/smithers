/**
 * The apps/ui required CI tier selects, and actually executes, what it claims.
 *
 * Three claims: the required PR workflow runs the UI typecheck, units and
 * Playwright once each in their own Ubuntu job; the browser target's wrapper
 * installs its browser, runs Playwright and propagates its failure; and the
 * real scheduler skips TypeScript when strict devkit preparation fails.
 *
 * Run it with `node --test scripts/repo-contract/ui-ci-tier.test.mjs`.
 */
import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, delimiter, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { parseWorkflow } from "../release-rehearsal.mjs"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

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
