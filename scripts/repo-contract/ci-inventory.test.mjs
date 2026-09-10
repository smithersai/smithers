import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planned, resolveInventory, root, runnerFor, targetInvocation } from "../ci-inventory.mjs"
import { openPackageIndex } from "@smthrs/build-cli/Cli"
import * as Target from "@smthrs/targets/Target"

test("CI command discovery retains diagnostic options and refuses unknown selection syntax", () => {
  for (const options of ["--jobs 2 --verbose", "--verbose --jobs 2"]) {
    assert.deepEqual(targetInvocation(`pnpm exec smthrs ci '//packages/...' ${options}`), {
      verb: "ci", pattern: "//packages/...", jobs: 2, verbose: true
    })
  }
  assert.deepEqual(targetInvocation("pnpm exec smthrs build '//apps/ui:check' --verbose"), {
    verb: "build", pattern: "//apps/ui:check", jobs: undefined, verbose: true
  })
  assert.equal(targetInvocation("node scripts/generate-ci.mjs"), undefined)
  for (const options of ["--include-exclusive", "--jobs", "--jobs 0", "--jobs 2 --jobs 3", "--plan"])
    assert.throws(() => targetInvocation(`pnpm exec smthrs test '//packages/...' ${options}`), /Unrecognized CI target/)
  assert.throws(() => targetInvocation("pnpm exec smthrs test //packages/..."), /Unrecognized CI target/)
})

test("UI typecheck plans strict devkit preparation as an uncached prerequisite", async () => {
  const plan = planned("build", "//apps/ui:check")
  assert.deepEqual(plan.roots, ["//apps/ui:check"])
  const check = plan.targets.find((target) => target.label === "//apps/ui:check")
  const devkit = plan.targets.find((target) => target.label === "//apps/ui:devkit")
  assert.ok(check)
  assert.ok(devkit, "a clean checkout has no ignored devkit for TypeScript to extend")
  assert.ok(check.dependencies.includes(devkit.label))
  assert.equal(devkit.rule, "NodeBinary")
  assert.equal(devkit.cacheable, false, "a previous result cannot restore the SDK projection")
  assert.equal(check.cacheable, false)
  const index = await openPackageIndex({ workspace: root })
  const declaration = index.targets().find((target) => target.label === devkit.label)
  assert.ok(declaration)
  assert.deepEqual(runnerFor(Target.metadata(declaration.target), index.workspace, "build"), [
    "node", "scripts/ensure-devkit.mjs"
  ], "the CI prerequisite must use Node and strict preparation, without --soft")
})

test("required CI resolves package, app, script, evaluation and fault suites to real runners", async () => {
  const inventory = await resolveInventory()
  const artifact = process.env.SMITHERS_CI_INVENTORY ?? join(tmpdir(), `smithers-ci-inventory-${process.pid}.json`)
  writeFileSync(artifact, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(`Resolved CI inventory: ${artifact}`)
  assert.deepEqual(inventory.selectionErrors, [], "every required command must successfully plan")
  const selected = (label, job) => inventory.rows.filter((row) => row.label === label && row.job === job && row.required && row.selectedRoot)
  for (const [label, job] of [
    ["//apps/ui:check", "apps-e2e"], ["//apps/ui:unitTests", "apps-e2e"], ["//apps/ui:browserE2e", "apps-e2e"],
    ["//apps/server:check", "test"], ["//apps/server:unitTests", "test"],
    ["//apps/review:unitTests", "test"], ["//apps/bug-worker:unitTests", "test"], ["//apps/status-site:unitTests", "test"],
    ["//apps/review:check", "test"], ["//apps/review:checkTests", "test"],
    ["//apps/bug-worker:check", "test"], ["//apps/status-site:check", "test"],
    ["//evals/agent:test", "test"], ["//evals/authoring:test", "test"],
    ["//evals/agent:check", "test"], ["//evals/authoring:check", "test"], ["//evals/swebench:check", "test"],
    ["//evals/review-seeded-bugs:suite", "test"], ["//evals/review-seeded-bugs:test", "test"],
    ["//evals/review-seeded-bugs:check", "test"],
    ["//evals/recommend:suite", "test"], ["//evals/recommend:test", "test"], ["//evals/recommend:check", "test"],
    ["//scripts/repo-contract:ciInventory", "test"], ["//scripts:mutationGate", "test"], ["//scripts:benchmarkGate", "test"],
    ["//scripts:tierContracts", "test"],
    ["//scripts:webBundleContract", "browser"],
    ["//packages/smithers/gateway:test", "test"], ["//packages/smithers/flows/jj:test", "packages"]
  ]) assert.ok(selected(label, job).length, `${label} must be a required root of ${job}`)
  const uiUnits = inventory.rows.filter((row) => row.label === "//apps/ui:unitTests" && row.required && row.selectedRoot)
  assert.equal(uiUnits.length, 1, "the UI unit tier runs once in required CI")
  assert.deepEqual(uiUnits[0].runner, ["bun", "test", "src", "e2e/contracts", "scripts"])
  const packageTests = inventory.rows.filter((row) => row.job === "packages" && row.required && row.selectedRoot)
  assert.ok(packageTests.length > 100, "the complete package test graph must resolve")
  for (const row of packageTests) assert.ok(selected(row.label, "test").length, `${row.label} must also be selected by ci //packages/...`)
  const faults = inventory.rows.filter((row) => row.job === "e2e-faults" && row.selectedRoot)
  assert.ok(faults.length >= 3)
  for (const row of faults) {
    assert.equal(row.rule, "Vitest")
    assert.ok(row.runner.includes("vitest.faults.config.ts"), row.label)
    assert.ok(row.inputs.some((input) => input.pattern?.includes("test/faults/")), row.label)
  }
  const native = selected("//crates/flows-jj:cargoTest", "rust")
  assert.equal(native.length, 1)
  assert.deepEqual(native[0].runner, ["cargo", "test", "--workspace", "--locked"])
  assert.equal(native[0].cwd, ".")
  assert.ok(native[0].inputs.some((input) => input.path === "//Cargo.lock"))
  for (const row of inventory.rows) {
    const name = row.label.split(":").at(-1)
    if (/^browser|^e2e|faults$/i.test(name)) {
      assert.ok(name === "browserE2e" || name === "faults", `${row.label}: classify and verify this suite's E2E runner`)
    }
    if (/unitTests$/.test(row.label)) {
      // One required UI job owns three distinct tiers; its unit step must
      // still name and execute the unit runner, never claim browser coverage.
      assert.doesNotMatch(row.step, /e2e|end.to.end/i)
      if (row.job === "apps-e2e") assert.equal(row.label, "//apps/ui:unitTests")
    }
    if (/browserE2e$/.test(row.label)) {
      assert.equal(row.rule, "NodeTest")
      assert.ok(row.runner.includes("scripts/run-pr-e2e.mjs"))
      const entry = readFileSync(join(root, row.cwd, "scripts/run-pr-e2e.mjs"), "utf8")
      assert.match(entry, /\["exec", "playwright", "test"\]/)
    }
    // Ambient helper/fixture/config/dependency/runtime/seed inputs are safe only
    // while the general NodeTest/Vitest runners always execute fresh work.
    if (["NodeTest", "Vitest"].includes(row.rule)) assert.equal(row.cacheable, false, `${row.label}: review all effective inputs before enabling result reuse`)
  }
  for (const app of ["server", "ui", "review", "bug-worker", "status-site"]) {
    assert.match(readFileSync(join(root, `apps/${app}/PACKAGE.ts`), "utf8"), /Coverage policy: assertion-only/)
  }
})

test("public project copy keeps the support contract out of the short description", () => {
  const description = "Smithers instruments and automates a code repository so changes get cheaper, faster, and smarter. Agents plan, run, and review changes through flows declared beside the code."
  const project = JSON.parse(readFileSync(join(root, "apps/site/src/data/project.json"), "utf8"))
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  assert.equal(project.description, description)
  assert.equal(manifest.description, description)
  assert.deepEqual(project.support, {
    requiredPlatform: "The release candidate's required package platform is Linux with Node 22.19.0.",
    advisoryPlatforms: "macOS and Windows package checks are advisory and do not establish a support guarantee.",
    uiCoverage: "Offline Chromium tests cover the included web UI.",
    separateAcceptance: "Packaged desktop and hosted deployments require separate acceptance evidence."
  })
  const readme = readFileSync(join(root, "README.md"), "utf8")
  const docs = readFileSync(join(root, "apps/site/src/content/docs/docs/index.mdx"), "utf8")
  assert.ok(readme.includes(`\n\n${description}\n\n`))
  assert.doesNotMatch(readme, /\u2014/)
  assert.equal(JSON.parse(docs.match(/^description: (.*)$/m)?.[1] ?? "null"), description)
  assert.equal(docs.match(/generated:project-description start[^\n]*\n\n([\s\S]*?)\n\n\{\/\* generated:project-description end/)?.[1], description)
  const readmeSupport = readme.match(/(?:^|\n)## Supported platforms\n\n([\s\S]*?)(?=\n## |$)/)?.[1]
  const developers = readFileSync(join(root, "apps/site/src/content/docs/docs/developers.mdx"), "utf8")
  const docsSupport = developers.match(/generated:project-support start[^\n]*\n\n## Supported platforms\n\n([\s\S]*?)\n\n\{\/\* generated:project-support end/)?.[1]
  for (const [name, support] of [["README", readmeSupport], ["developer overview", docsSupport]]) {
    assert.equal(typeof support, "string", `${name} must have a dedicated support section`)
    assert.match(support, /required package platform is Linux with Node 22\.19\.0/)
    assert.match(support, /macOS and Windows.*advisory and do not establish a support guarantee/)
    assert.match(support, /Offline Chromium tests cover the included web UI/)
    assert.match(support, /Packaged desktop and hosted deployments require separate acceptance evidence/)
  }
})
