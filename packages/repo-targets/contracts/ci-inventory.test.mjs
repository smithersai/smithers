import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createPlanner, requestPlan } from "./ci-planner.mjs"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"
import { planned, plannedInProcess, resolveInventory, root, runnerFor, targetInvocation } from "./ci-inventory.mjs"
import { openPackageIndex } from "@smthrs/build-cli/Cli"
import * as Target from "@smthrs/targets/Target"
import * as Exec from "@smthrs/targets/Exec"
import { parseWorkflow } from "../../../.smithers/flows/release/release-rehearsal.mjs"
import * as PackageExec from "@smthrs/build-cli/PackageExec"

// Every case reads the same declarations, so they share one index instead of
// loading every PACKAGE.ts again per case.
let opened
const packageIndex = () => opened ??= openPackageIndex({ workspace: root })

const durableBrowser = "//packages/smithers/flows/platform-browser:browserTest"
const browserProbes = new Map([
  ["//packages/smithers/ui:browserProbes", "generated-view.browser.test.ts"],
  ["//packages/smithers/ui/terminal-frame:browserProbes", "terminal-frame.browser.test.ts"]
])

test("terminal unit tests select their directory rather than matching browser test filenames", async () => {
  const index = await packageIndex()
  const declaration = index.targets().find((target) => target.label === "//packages/smithers/ui/terminal-frame:unitTests")
  assert.ok(declaration)
  assert.deepEqual(runnerFor(Target.metadata(declaration.target), index.workspace, "test"),
    ["bun", "test", "--isolate", "./test"])
})

test("jobs selecting UI browser probes install the packages' pinned Chromium", () => {
  const jobs = { ...workflowJobs(".github/workflows/ci.yml"), release: workflowJobs(".github/workflows/release.yml").publish }
  for (const job of ["test", "packages", "release"]) {
    const steps = jobs[job].steps
    const install = steps.findIndex((step) => step.name === "Install Playwright browsers")
    assert.ok(install >= 0, `${job}: install Playwright's browser before running probes`)
    assert.match(steps[install].run, /cd 'packages\/smithers\/ui'\npnpm exec playwright install --with-deps 'chromium'/)
    assert.ok(install < steps.findIndex((step) => targetInvocation(step.run)))
  }
  const version = (cwd) => JSON.parse(readFileSync(join(root, cwd, "package.json"), "utf8")).devDependencies.playwright
  assert.equal(version("packages/smithers/ui"), version("packages/smithers/ui/terminal-frame"))
  assert.match(jobs["apps-e2e"].steps.find((step) => step.name === "Install system packages").run, /'tmux'/)
})

const assertE2eRunner = (row) => {
  const { label } = row
  const name = label.split(":").at(-1)
  if (/^browser|^e2e|faults$/i.test(name)) {
    assert.ok(name === "faults" || label === "//apps/tui:e2eTests" || label === durableBrowser || browserProbes.has(label),
      `${label}: classify and verify this suite's E2E runner`)
  }
  if (label === durableBrowser) {
    assert.equal(row.rule, "Shell.Test")
    assert.deepEqual(row.runner, ["/bin/sh", "-c",
      "cd packages/smithers/flows/platform-browser && npx vitest run --config vitest.browser.config.ts"])
    assert.ok(row.inputs.some((input) => input.path === "vitest.browser.config.ts"), "the browser config must be a declared input")
    const config = readFileSync(join(root, "packages/smithers/flows/platform-browser/vitest.browser.config.ts"), "utf8")
    assert.match(config, /include: \["test\/browser\/\*\*\/\*\.test\.\{ts,vibe\}"\]/)
    const harness = readFileSync(join(root, "packages/smithers/flows/platform-browser/test/browser/Harness.ts"), "utf8")
    assert.match(harness, /import \{[^}]*\bchromium\b[^}]*\} from "playwright"/)
    assert.match(harness, /chromium\.launchPersistentContext\(/)
  }
  if (browserProbes.has(label)) {
    const cwd = label.slice(2).split(":")[0]
    assert.equal(row.rule, "NodeTest")
    assert.equal(row.cwd, cwd)
    assert.deepEqual(row.runner, ["bun", "test", "browser"])
    assert.ok(row.inputs.some((input) => input.pattern === `//${cwd}/browser/**/*.ts`), "the browser probes must be declared inputs")
    const probe = readFileSync(join(root, cwd, "browser", browserProbes.get(label)), "utf8")
    assert.match(probe, /import \{[^}]*\bchromium\b[^}]*\} from "playwright"/)
    assert.match(probe, /chromium\.launch\(/)
  }
}

test("the durable browser suite has a classified real Chromium runner", async () => {
  const index = await packageIndex()
  const label = durableBrowser
  const declaration = index.targets().find((target) => target.label === label)
  assert.ok(declaration, "the browser durability suite must remain declared")
  const metadata = Target.metadata(declaration.target)
  assertE2eRunner({ label, rule: metadata.target,
    runner: runnerFor(metadata, index.workspace, "test"), inputs: metadata.attrs.data })
  assert.throws(() => assertE2eRunner({ label: "//packages/unknown:browserTest" }), /classify and verify/)
})

for (const label of browserProbes.keys()) {
  test(`${label} has a classified real Chromium runner`, async () => {
    const index = await packageIndex()
    const declaration = index.targets().find((target) => target.label === label)
    assert.ok(declaration, "the browser probe suite must remain declared")
    const metadata = Target.metadata(declaration.target)
    assertE2eRunner({ label, rule: metadata.target, cwd: metadata.attrs.cwd,
      runner: runnerFor(metadata, index.workspace, "test"), inputs: metadata.attrs.srcs })
  })
}

test("the CI host-size suite always plans a fresh bundle", async () => {
  const index = await packageIndex()
  const label = "//.smithers/flows:codingHostSize"
  const plan = await PackageExec.plan({
    index, verb: "test", patterns: [label], cacheDirectory: index.workspace.cache.directory
  })
  assert.deepEqual(plan.roots, [label])
  assert.equal(plan.nodes.get(label).cacheable, false, "the host bundle must be measured by a fresh execution")
})

test("CI command discovery retains diagnostic options and refuses unknown selection syntax", () => {
  for (const options of ["--jobs 2 --verbose", "--verbose --jobs 2"]) {
    assert.deepEqual(targetInvocation(`pnpm exec smthrs ci '//packages/...' ${options}`), {
      verb: "ci", pattern: "//packages/...", jobs: 2, verbose: true
    })
  }
  assert.deepEqual(targetInvocation("pnpm exec smthrs build '//apps/tui:check' --verbose"), {
    verb: "build", pattern: "//apps/tui:check", jobs: undefined, verbose: true
  })
  assert.deepEqual(targetInvocation("pnpm exec smthrs ci '//apps/...' --known-red '.github/ci-known-red.json' --verbose"), {
    verb: "ci", pattern: "//apps/...", jobs: undefined, knownRed: ".github/ci-known-red.json", verbose: true
  })
  assert.equal(targetInvocation("node scripts/generate-ci.mjs"), undefined)
  for (const options of ["--include-exclusive", "--jobs", "--jobs 0", "--jobs 2 --jobs 3", "--plan", "--known-red", "--known-red list.json"])
    assert.throws(() => targetInvocation(`pnpm exec smthrs test '//packages/...' ${options}`), /Unrecognized CI target/)
  assert.throws(() => targetInvocation("pnpm exec smthrs test //packages/..."), /Unrecognized CI target/)
})

test("CI inventory plans without building packages or the site", async () => {
  const plan = planned("test", "//packages/repo-targets:ciInventory")
  assert.deepEqual(plan.roots, ["//packages/repo-targets:ciInventory"])
  assert.deepEqual(plan.targets.map((target) => target.label), plan.roots)
  assert.equal(plan.targets[0].cacheable, false, "inventory always executes fresh planner checks")
  assert.deepEqual(await plannedInProcess("test", "//packages/repo-targets:ciInventory"), plan,
    "the serial CLI host emits the same complete plan as the source executable")
  const planner = createPlanner()
  try {
    for (let selection = 0; selection < 2; selection++)
      assert.deepEqual(await planner.plan("test", "//packages/repo-targets:ciInventory", root), plan,
        "the supervised persistent child emits the same complete plan on reuse")
  } finally { await planner.close() }
})

test("CI planning hard-kills a child that ignores SIGTERM and blocks synchronously", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    process.on("SIGTERM", () => process.send("ignored", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }))
    process.on("message", () => {
      process.send("planning")
    })
    process.send("ready")
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  assert.equal((await once(child, "message"))[0], "ready")
  const timers = new Map()
  const result = requestPlan(child, { verb: "test", pattern: "//:stubborn" }, {
    setTimer: (callback, ms) => { timers.set(ms, callback); return ms },
    clearTimer: (timer) => { timers.delete(timer) }
  })
  const rejected = assert.rejects(result, /Planning test \/\/:stubborn timed out after 120000ms/)
  assert.equal((await once(child, "message"))[0], "planning")
  const ignored = once(child, "message")
  timers.get(120_000)()
  assert.equal((await ignored)[0], "ignored", "SIGTERM reaches the real child first")
  assert.ok(timers.has(1_000), "a separate grace timer must enforce SIGKILL")
  const exited = once(child, "exit")
  timers.get(1_000)()
  assert.deepEqual(await exited, [null, "SIGKILL"])
  await rejected
  assert.equal(timers.size, 0, "completion releases both timers")
})

test("CI planning cancels the hard deadline after cooperative SIGTERM completion", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    process.on("SIGTERM", () => process.send({ type: "plan", value: null }))
    process.on("message", () => process.send("planning"))
    process.send("ready")
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  assert.equal((await once(child, "message"))[0], "ready")
  const timers = new Map()
  const result = requestPlan(child, { verb: "lint", pattern: "//:cooperative" }, {
    setTimer: (callback, ms) => { timers.set(ms, callback); return ms },
    clearTimer: (timer) => { timers.delete(timer) }
  })
  const rejected = assert.rejects(result, /timed out after 120000ms/)
  assert.equal((await once(child, "message"))[0], "planning")
  timers.get(120_000)()
  await rejected
  assert.equal(timers.size, 0, "cooperative completion clears the grace timer")
  assert.equal(child.signalCode, null, "cooperative completion does not need SIGKILL")
})

test("release smoke retains packing, fresh execution and its measured Exec deadline", async () => {
  const index = await packageIndex()
  const plan = await PackageExec.plan({
    index, verb: "test", patterns: ["//.smithers/flows:releaseSmoke"], cacheDirectory: index.workspace.cache.directory
  })
  const smoke = plan.nodes.get("//.smithers/flows:releaseSmoke")
  assert.ok(smoke)
  const declaration = index.targets().find((target) => target.label === smoke.label)
  assert.ok(declaration)
  const call = Target.plan(declaration.target, smoke.attrs).ast
  assert.equal(call._tag, "ActionCall", "the smoke plans its actual Exec invocation")
  assert.equal(call.action, "smithers-build/exec")
  assert.equal(Exec.Payload.make(call.payload).timeoutMs, 1_800_000,
    "the inner Exec must receive the declared 30m bound, not its 10m default")
  assert.equal(smoke.timeoutMs, 1_800_000, "the outer executor must honor the 30m deadline too")
  assert.equal(smoke.cacheable, false, "a successful receipt never substitutes for a fresh smoke")
  assert.ok(smoke.dependencies.includes("//.smithers/flows:releasePack"), "source qualification still rebuilds candidate bytes")
})

/**
 * Where the resolved inventory is written: the operator's SMITHERS_CI_INVENTORY,
 * else a file in a fresh private directory. A predictable name under a shared
 * tmpdir() lets another local user pre-plant a symlink the write follows.
 * The default directory is removed once every assertion passes and kept on a
 * failure, so the logged path is there to read when it matters.
 */
const inventoryArtifact = (environment = process.env) =>
  environment.SMITHERS_CI_INVENTORY ?? join(mkdtempSync(join(tmpdir(), "smithers-ci-inventory-")), "inventory.json")

test("the default inventory artifact lives in a fresh private directory", () => {
  const first = inventoryArtifact({})
  const second = inventoryArtifact({})
  try {
    assert.notEqual(dirname(first), dirname(second))
    assert.ok(!existsSync(first), "the artifact path is new, so nothing pre-planted sits there")
    if (process.platform !== "win32") assert.equal(statSync(dirname(first)).mode & 0o777, 0o700)
    assert.equal(inventoryArtifact({ SMITHERS_CI_INVENTORY: "chosen.json" }), "chosen.json")
  } finally {
    rmSync(dirname(first), { recursive: true, force: true })
    rmSync(dirname(second), { recursive: true, force: true })
  }
})

test("required CI resolves package, app, script and evaluation suites to real runners", async () => {
  const inventory = await resolveInventory()
  const artifact = inventoryArtifact()
  writeFileSync(artifact, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(`Resolved CI inventory: ${artifact}`)
  assert.deepEqual(inventory.selectionErrors, [], "every required command must successfully plan")
  const selected = (label, job) => inventory.rows.filter((row) => row.label === label && row.job === job && row.required && row.selectedRoot)
  for (const [label, job] of [
    ["//apps/tui:check", "apps-e2e"], ["//apps/tui:unitTests", "apps-e2e"], ["//apps/tui:e2eTests", "apps-e2e"],
    ["//.smithers/flows/review:unitTests", "repository"], ["//apps/bug-worker:unitTests", "repository"],
    ["//.smithers/flows/review:check", "repository"], ["//.smithers/flows/review:checkTests", "repository"],
    ["//apps/bug-worker:check", "repository"],
    ["//packages/smithers/agent/regression:test", "repository"], ["//evals/authoring:test", "repository"],
    ["//packages/smithers/agent/regression:check", "repository"], ["//evals/authoring:check", "repository"], ["//packages/smithers/agent/harness/benchmarks/swebench:check", "repository"],
    ["//.smithers/flows/review/seeded-bugs:suite", "repository"], ["//.smithers/flows/review/seeded-bugs:test", "repository"],
    ["//.smithers/flows/review/seeded-bugs:check", "repository"],
    ["//packages/repo-targets:ciInventory", "test"], ["//.smithers/flows:mutationGate", "scripts"], ["//.smithers/flows:benchmarkGate", "scripts"],
    ["//.smithers/flows:campaignVerifiers", "scripts"], ["//.smithers/flows:signalCampaign", "scripts"],
    ["//.smithers/flows:checkRunner", "scripts"],
    ["//packages/repo-targets:webBundleContract", "browser"],
    [durableBrowser, "test"], [durableBrowser, "packages"],
    ...[...browserProbes.keys()].flatMap((label) => [[label, "test"], [label, "packages"]]),
    ["//packages/smithers/gateway:test", "test"], ["//packages/smithers/flows/jj:test", "packages"]
  ]) assert.ok(selected(label, job).length, `${label} must be a required root of ${job}`)
  const inventoryRunner = selected("//packages/repo-targets:ciInventory", "test")[0].runner
  assert.equal(basename(inventoryRunner[0]), "node")
  assert.deepEqual(inventoryRunner.slice(1), ["--import=vibelang/register", "--test", "packages/repo-targets/contracts/ci-inventory.test.mjs"])
  const packageTests = inventory.rows.filter((row) => row.job === "packages" && row.required && row.selectedRoot)
  assert.ok(packageTests.length > 100, "the complete package test graph must resolve")
  for (const row of packageTests) assert.ok(selected(row.label, "test").length, `${row.label} must also be selected by ci //packages/...`)
  assert.deepEqual(inventory.rows.filter((row) => row.job === "e2e-faults"), [],
    "ordinary CI must not run the nightly fault matrix")
  const native = selected("//packages/smithers/flows/jj-wasm:cargoTest", "rust")
  assert.equal(native.length, 1)
  assert.equal(basename(native[0].runner[0]), "cargo")
  assert.deepEqual(native[0].runner.slice(1), ["test", "-p", "flows-jj", "--locked"])
  assert.equal(native[0].cwd, ".")
  assert.ok(native[0].inputs.some((input) => input.path === "//Cargo.lock"))
  const nodeRelease = readFileSync(join(root, ".node-version"), "utf8").trim()
  const jobs = workflowJobs(".github/workflows/ci.yml")
  for (const row of inventory.rows) {
    if (jobs[row.job].steps.some((step) => step.with?.["node-version-file"] === ".node-version"))
      assert.ok(row.runtimes.includes(`Node ${nodeRelease}`), row.job + " must report the pinned Node release")
    assertE2eRunner(row)
    if (/unitTests$/.test(row.label)) {
      // Each unit step must name and execute a unit runner, never claim
      // browser coverage.
      assert.doesNotMatch(row.step, /e2e|end.to.end/i)
      if (row.job === "apps-e2e") assert.equal(row.label, "//apps/tui:unitTests")
    }
    if (row.label === "//apps/tui:e2eTests") {
      // The terminal tier types raw keys into the production entry inside a private tmux server.
      assert.equal(row.rule, "NodeTest")
      assert.deepEqual(row.runner, ["bun", "test", "./e2e"])
      const driver = readFileSync(join(root, row.cwd, "e2e/tmux.ts"), "utf8")
      assert.match(driver, /process\.env\.TMUX_BIN \?\? "tmux"/)
      assert.match(driver, /spawnSync\(binary\(\), \["-S", this\.socket/)
      assert.match(readFileSync(join(root, row.cwd, "e2e/tui.test.ts"), "utf8"),
        /Tui\.start\(\{[^}]*command: `bun \$\{join\(app, "src", "main\.tsx"\)\}/)
    }
    // Ambient helper/fixture/config/dependency/runtime/seed inputs are safe only
    // while the general NodeTest/Vitest runners always execute fresh work.
    if (["NodeTest", "Vitest"].includes(row.rule)) assert.equal(row.cacheable, false, `${row.label}: review all effective inputs before enabling result reuse`)
  }
  for (const app of ["bug-worker"]) {
    assert.match(readFileSync(join(root, `apps/${app}/PACKAGE.ts`), "utf8"), /Coverage policy: assertion-only/)
  }
  assert.match(readFileSync(join(root, ".smithers/flows/review/PACKAGE.ts"), "utf8"), /Coverage policy: assertion-only/)
  if (process.env.SMITHERS_CI_INVENTORY === undefined) rmSync(dirname(artifact), { recursive: true, force: true })
})

test("nightly faults resolve through the public CLI to every declared serial runner", async () => {
  const workflow = workflowJobs(".github/workflows/reliability.yml")
  const commands = workflow["e2e-faults"].steps.map((step) => step.run).filter((run) => run?.includes("//packages/...:faults"))
  assert.equal(commands.length, 1)
  const invocation = targetInvocation(commands[0])
  assert.equal(invocation.verb, "test")
  assert.equal(invocation.pattern, "//packages/...:faults")
  assert.equal(invocation.jobs, 1)
  assert.equal(invocation.knownRed, undefined)
  const plan = planned(invocation.verb, invocation.pattern)
  assert.ok(plan.roots.length >= 3, "the complete library and production fault matrix must resolve")
  const index = await packageIndex()
  const native = await PackageExec.plan({ index, verb: invocation.verb, patterns: [invocation.pattern], cacheDirectory: index.workspace.cache.directory })
  for (const label of plan.roots) {
    const node = native.nodes.get(label)
    assert.equal(node.target, "Vitest", label)
    assert.ok(runnerFor(node, index.workspace, invocation.verb).includes("vitest.faults.config.ts"), label)
    const inputs = [...(node.attrs.srcs ?? []), ...(node.attrs.sources ?? []), ...(node.attrs.tests ?? []), ...(node.attrs.data ?? [])]
    assert.ok(inputs.some((input) => input.pattern?.includes("test/faults/")), label)
  }
})

test("public project copy keeps the support contract out of the short description", () => {
  const description = "Smithers maintains your codebase. It turns issues into tested changes for you to review and, when enabled, keeps the project wiki current. Flows beside your code define how."
  const project = JSON.parse(readFileSync(join(root, "apps/site/src/data/project.json"), "utf8"))
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  assert.equal(project.description, description)
  assert.equal(manifest.description, description)
  for (const text of [project.description, manifest.description]) {
    assert.doesNotMatch(text, /\breviewed\b|ready to merge/i, "the public description never says a change was reviewed or is ready to merge for the user")
  }
  assert.deepEqual(project.support, {
    summary: "Smithers needs Node.js 22.19 or later. The release candidate is certified on Linux with Node 26.4.0."
  })
  const readme = readFileSync(join(root, "README.md"), "utf8")
  const docs = readFileSync(join(root, "apps/site/docs/installation.mdx"), "utf8")
  assert.ok(readme.includes(`\n\n${description}\n\n`))
  assert.doesNotMatch(readme, /\u2014/)
  assert.equal(docs.match(/generated:project-description start[^\n]*\n\n([\s\S]*?)\n\n\{\/\* generated:project-description end/)?.[1], description)
  const readmeSupport = readme.match(/(?:^|\n)## Supported platforms\n\n([\s\S]*?)(?=\n## |$)/)?.[1]
  assert.equal(typeof readmeSupport, "string", "README must have a dedicated support section")
  assert.match(readmeSupport, /needs Node\.js 22\.19 or later\. The release candidate is certified on Linux with Node 26\.4\.0\./)
  assert.match(readmeSupport, /\[support matrix\]\(https:\/\/smithers\.sh\/docs\/reference\/support-matrix\/\)/)
})

// Read workflow semantics through the same YAML parser as release rehearsal.
// Generated CI quotes keys and values; the hand-written release workflow need not.
const workflowJobs = (workflow) => {
  const { jobs } = parseWorkflow(readFileSync(join(root, workflow), "utf8"))
  assert.ok(jobs && Object.keys(jobs).length > 0, workflow + " must declare jobs")
  return jobs
}

test("every CI job and the release publish job bound their runtime below GitHub's six-hour default", () => {
  const jobs = [...Object.entries(workflowJobs(".github/workflows/ci.yml")),
    ["release.publish", workflowJobs(".github/workflows/release.yml").publish]]
  for (const [id, job] of jobs) {
    const timeout = job["timeout-minutes"]
    assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout < 360,
      id + " must declare a positive timeout-minutes below the six-hour default")
  }
})

test("jobs that install the workspace restore the pnpm store", () => {
  for (const [id, job] of Object.entries(workflowJobs(".github/workflows/ci.yml"))) {
    if (job.steps.some((step) => step.run?.includes("pnpm install --frozen-lockfile"))) {
      const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
      assert.ok(setup, id + " must set up Node before installing the workspace")
      assert.equal(setup.with?.["node-version-file"], ".node-version", id + " must use the pinned Node release")
      assert.equal(setup.with?.cache, "pnpm", id + " installs the workspace from a cold store")
    }
  }
})

test("the root TypeScript project owns declarations, not package source or fixtures", () => {
  const { include } = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))
  for (const entry of [".smithers/flows/PACKAGE.ts",
    "packages/*/PACKAGE.ts", "packages/*/*/PACKAGE.ts", "packages/*/*/*/PACKAGE.ts"])
    assert.ok(include.includes(entry), `tsconfig.json include omits ${entry}`)
  assert.ok(include.every((entry) => !entry.includes("/src/") && !entry.includes("/test/") && !entry.includes("/examples/")),
    "package source, test fixtures, and examples must use their owning TypeScript projects")
})


test("CI discovery preserves a generated results path and rejects repeated flags", () => {
  const run = `pnpm exec smthrs test '//.smithers/flows:packageDocs' --results-file "$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json" --verbose`
  assert.deepEqual(targetInvocation(run), { verb: "test", pattern: "//.smithers/flows:packageDocs", jobs: undefined, verbose: true, resultsFile: "$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json" })
  assert.throws(() => targetInvocation(`${run} --results-file "other"`), /Unrecognized CI target option/)
})

test("the published documentation gate resolves through the public CLI with matching metadata", async () => {
  const index = await packageIndex()
  const metadata = await PackageExec.plan({ index, verb: "test", patterns: ["//.smithers/flows:packageDocs"], cacheDirectory: index.workspace.cache.directory })
  const cli = planned("test", "//.smithers/flows:packageDocs")
  const target = cli.targets.find(({ label }) => label === "//.smithers/flows:packageDocs")
  const node = metadata.nodes.get("//.smithers/flows:packageDocs")
  assert.ok(target)
  assert.ok(node)
  assert.equal(target.key ?? target.keyPreview, node.key ?? node.keyPreview)
  const runner = runnerFor(node, index.workspace)
  assert.deepEqual(runner.slice(1), ["--import=vibelang/register", "--test", "docs-sync/package-docs-redirect.test.mjs", "docs-sync/flow.test.ts"])
  assert.equal(node.attrs.cache, false)
})
