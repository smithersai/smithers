import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, matchesGlob } from "node:path"
import { test } from "node:test"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { readBoxReceipts, affectedHosts, affectedPlan, affectedTargets, affectedTests, assertComplete, vitestShards, gitSource, globRegExp, jjSource, vitestIncludes, workspaceGlobs } from "./affected.mjs"
import { jj } from "./numbering.mjs"
import { landWorkspace } from "./workspace.mjs"
import { overrideInbox } from "./review.mjs"

const target = (label, { kinds = ["test"], inputs = [], dependencies = [] } = {}) => ({
  label, package: label.slice(2, label.indexOf(":")), name: label.slice(label.indexOf(":") + 1), kinds, inputs, dependencies
})
const index = [
  target("//packages/core:lib", { kinds: ["build"], inputs: [{ kind: "glob", pattern: "packages/core/src/**/*.ts", exclude: [] }] }),
  target("//packages/core:test", { inputs: [{ kind: "glob", pattern: "packages/core/test/**/*.test.ts", exclude: [] }], dependencies: ["//packages/core:lib"] }),
  target("//packages/app:lib", { kinds: ["build"], dependencies: ["//packages/core:lib"] }),
  target("//packages/app:test", { dependencies: ["//packages/app:lib"] }),
  target("//packages/other:test", { inputs: [{ kind: "file", path: "packages/other/a.ts" }] }),
  target("//packages/lint:rules", { inputs: [{ kind: "glob", pattern: "apps/mvp/worker/!(*.test).ts", exclude: [] }] }),
  target("//packages/lint:test", { inputs: [{ kind: "glob", pattern: "packages/lint/**/*.ts", exclude: [] }] })
]

test("cfbox has one box route and never masquerades as a Latitude host", () => {
  const hosts = affectedHosts()
  assert.equal(hosts.filter((host) => host.box).length, 1)
  assert.deepEqual(hosts.filter((host) => !host.box).map(({ kind, platform, docker }) => ({ kind, platform, docker })), [
    { kind: "latitude", platform: "linux", docker: true }
  ])
  assert.equal(new Set(hosts.map((host) => host.client)).size, 2)
})

test("a change affects its package's tests and every test that depends on that package, transitively", () => {
  assert.deepEqual(affectedTargets(index, ["packages/core/src/x.ts"]), ["//packages/app:test", "//packages/core:test"])
  assert.deepEqual(affectedTargets(index, ["packages/other/a.ts"]), ["//packages/other:test"])
  // A target in another package that reads the path, and not the rest of that package; an extglob widens rather than misses.
  assert.deepEqual(affectedTargets(index, ["apps/mvp/worker/Chat.ts"]), ["//packages/lint:rules"])
  assert.deepEqual(affectedTargets(index, ["packages/lint/x.ts"]), ["//packages/lint:test"])
  assert.deepEqual(affectedTargets(index, []), [])
  assert.equal(globRegExp("src/**/*.test.{ts,vibe}").test("src/features/chat/chat.test.ts"), true)
  assert.equal(globRegExp("src/**/*.test.{ts,vibe}").test("src/chat.ts"), false)
})

test("extglob exclusions never drop an explicit reader or its dependent tests", () => {
  for (const [pattern, file] of [
    ["!(*.test).ts", "Chat.test.ts"],
    ["@(Chat|Other).ts", "View.ts"],
    ["+(Chat).ts", "View.ts"],
    ["?(Chat).ts", "View.ts"],
    ["*(Chat).ts", "View.ts"],
    ["@(!(Chat|Other)).ts", "Chat.ts"]
  ]) {
    const path = `apps/mvp/worker/${file}`, exclude = `apps/mvp/worker/${pattern}`
    assert.equal(matchesGlob(path, exclude), false, exclude)
    const rows = [
      target("//checks:reader", { kinds: ["build"], inputs: [{ kind: "glob", pattern: "apps/mvp/worker/*.ts", exclude: [exclude] }] }),
      target("//checks:testReader", { dependencies: ["//checks:reader"] })
    ]
    assert.deepEqual(affectedTargets(rows, [path]), ["//checks:testReader"], exclude)
    assert.deepEqual(affectedTargets(rows, ["apps/mvp/worker/Chat.js"]), [], exclude)
    assert.deepEqual(affectedTargets(rows, ["apps/mvp/other/Chat.test.ts"]), [], exclude)
  }
})

test("ordinary exclusions still apply beside an omitted extglob exclusion", () => {
  const rows = [target("//checks:testReader", { inputs: [{
    kind: "glob", pattern: "apps/mvp/worker/**/*.ts", exclude: ["apps/mvp/worker/!(*.test).ts", "apps/mvp/worker/generated/**", "apps/mvp/worker/Skip.test.ts"]
  }] })]
  assert.deepEqual(affectedTargets(rows, ["apps/mvp/worker/Chat.test.ts"]), ["//checks:testReader"])
  assert.deepEqual(affectedTargets(rows, ["apps/mvp/worker/generated/Chat.test.ts"]), [])
  assert.deepEqual(affectedTargets(rows, ["apps/mvp/worker/Skip.test.ts"]), [])
  assert.deepEqual(affectedTargets(rows, ["apps/mvp/worker/generated/Chat.test.ts", "apps/mvp/worker/Chat.test.ts"]), ["//checks:testReader"])
})

// A package with one bin in a tree's node_modules, as an install leaves it: the runner runs bins by node.
const fakeBin = (root, name, source) => {
  const dir = join(root, name === "vitest" ? "apps/mvp" : "", "node_modules", name), command = name === "vitest" ? "vitest" : "smthrs"
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, bin: { [command]: "./bin.cjs" } }))
  writeFileSync(join(dir, "bin.cjs"), source.replace(/^#![^\n]*\n/, ""))
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, "root")
  mkdirSync(root)
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  write("apps/mvp/vitest.config.ts", 'export default { test: { include: [\n  "src/**/*.test.{ts,vibe}",\n  "worker/**/*.test.{ts,vibe}"\n] } }\n')
  write("apps/mvp/package.json", '{"name":"mvp","dependencies":{"core":"workspace:*"}}\n')
  write("packages/core/package.json", '{"name":"core"}\n')
  write("packages/core/src/x.ts", "export const x = 1\n")
  write("packages/elsewhere/package.json", '{"name":"elsewhere"}\n')
  write("packages/elsewhere/y.ts", "export const y = 1\n")
  write("apps/mvp/src/features/chat/chat.test.ts", "// chat\n")
  write("apps/mvp/src/features/pins/pins.test.ts", "// pins\n")
  write("apps/mvp/worker/Chat.ts", "export const chat = 1\n")
  write(".smithers/flows/land/affected-run.mjs", "// the runner\n")
  write(".smithers/target-index.json", JSON.stringify([target("//apps/mvp:importRules", { inputs: [{ kind: "glob", pattern: "apps/mvp/**/*.ts", exclude: [] }] })]))
  jj(root, ["commit", "-m", "base"])
  jj(root, ["bookmark", "set", "main", "-r", "@-"])
  return { root, write, source: jjSource(root, "main") }
}

// Head runs read the land's snapshot of the head; base runs, the base tree it builds.
const shardNames = Array.from({ length: vitestShards }, (_, i) => `${i + 1}/${vitestShards}`)
const isBase = (tree) => tree !== undefined && basename(tree).startsWith("smithers-affected-base-")
const allFiles = ["src/features/chat/chat.test.ts", "src/features/pins/pins.test.ts"]
const passing = (request) => ({
  targets: { results: request.labels.map((label) => ({ label, status: "ran" })) },
  vitest: request.vitest ? { exit: 0, files: request.vitestFiles ?? allFiles, failed: [] } : undefined
})

test("a worker change owes apps/mvp's whole Vitest suite and the index targets that read it", (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const plan = affectedPlan(root, jjSource(root, "main"))
  assert.deepEqual(plan.labels, ["//apps/mvp:importRules"])
  assert.equal(plan.reachesMvp, true)
  assert.deepEqual(plan.vitestFiles, allFiles)
})

test("a change to a package apps/mvp depends on reaches its suite; an unrelated package doesn't", (t) => {
  const { root, write, source } = fixture(t)
  write("packages/core/src/x.ts", "export const x = 2\n")
  assert.equal(affectedPlan(root, jjSource(root, "main")).reachesMvp, true)
  jj(root, ["restore", "packages/core/src/x.ts"])
  write("packages/elsewhere/y.ts", "export const y = 2\n")
  const plan = affectedPlan(root, jjSource(root, "main"))
  assert.equal(plan.reachesMvp, false)
  assert.deepEqual(plan.labels, [])
})

test("a run that omits src/features/chat is refused as incomplete, naming the missing suite", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const run = async (_root, request) => ({ ...passing(request), vitest: { exit: 0, files: ["src/features/pins/pins.test.ts"], failed: [] } })
  await assert.rejects(affectedTests(root, { source, run }), (error) => {
    assert.match(error.message, /test run is incomplete: 1 affected suites did not run; nothing pushed/)
    assert.match(error.message, /apps\/mvp\/src\/features\/chat\/chat\.test\.ts/)
    return true
  })
})

test("a missing index target, or a target run that reported nothing, is refused", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  await assert.rejects(affectedTests(root, { source, run: async (_root, request) => ({ ...passing(request), targets: { results: [] } }) }), /incomplete[\s\S]*\/\/apps\/mvp:importRules/)
  await assert.rejects(affectedTests(root, { source, run: async (_root, request) => ({ ...passing(request), targets: { results: [], error: "smthrs test exited 1" } }) }), /affected targets did not run/)
})

test("a failure that passes on the base refuses the land by test name; one the base shares doesn't", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const failure = { file: "src/features/chat/chat.test.ts", name: "chat shows the question at once" }
  const shared = { file: "src/features/pins/pins.test.ts", name: "pins already red on main" }
  const requests = []
  const run = async (_root, request, { source: tree, clients } = {}) => {
    requests.push({ request, base: isBase(tree), clients })
    // Shard 1 ran both files, on Latitude; the others found none of their own, on the mini.
    if (!isBase(tree)) return request.shard === `1/${vitestShards}`
      ? { ...passing(request), vitest: { exit: 1, files: allFiles, failed: [failure, shared] }, client: "lat" }
      : { ...passing(request), vitest: request.vitest ? { exit: 0, files: [], failed: [] } : undefined, client: "mini" }
    // The base tree holds the base's bytes for every changed path, and no VCS directory.
    assert.equal(existsSync(join(tree, ".jj")), false)
    return { ...passing(request), vitest: { exit: 1, files: request.vitestFiles, failed: [shared] } }
  }
  await assert.rejects(affectedTests(root, { source, run }), (error) => {
    assert.match(error.message, /fails 1 tests that pass on main; nothing pushed/)
    assert.match(error.message, /apps\/mvp\/src\/features\/chat\/chat\.test\.ts > chat shows the question at once/)
    assert.doesNotMatch(error.message, /pins already red/)
    return true
  })
  // The head ran the index targets and four Vitest shards at once; the base reran only the failing files, and
  // only on the client that saw them fail.
  assert.deepEqual(requests.slice(0, 1 + vitestShards).map(({ request }) => request.shard ?? request.labels.join()), ["//apps/mvp:importRules", ...shardNames])
  assert.deepEqual(requests.slice(1 + vitestShards), [{ request: { labels: [], vitest: true, vitestFiles: allFiles }, base: true, clients: ["lat"] }])
})

test("an index target smthrs skipped or cancelled never ran: the run is incomplete, whatever the base says", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  for (const status of ["skipped", "cancelled"]) {
    const run = async (_root, request) => ({ ...passing(request), targets: { results: request.labels.map((label) => ({ label, status })) } })
    await assert.rejects(affectedTests(root, { source, run }), /test run is incomplete: 1 affected suites did not run; nothing pushed\.\n\/\/apps\/mvp:importRules/)
  }
})

test("apps/mvp's include list is read as string literals, and any other form refuses", () => {
  const config = (list) => `export default { test: { include: [${list}], coverage: { include: ["src/**"] } } }`
  assert.deepEqual(vitestIncludes(config(`\n  // tabs [decision 0017]\n  "src/**/*.test.ts", 'worker/**/*.test.ts', \`db/**/*.test.ts\`,\n`)), ["src/**/*.test.ts", "worker/**/*.test.ts", "db/**/*.test.ts"])
  assert.throws(() => vitestIncludes(config(`"src/**/*.test.ts", ...extra`)), /more than string literals/)
  assert.throws(() => vitestIncludes(config(`\`\${dir}/**/*.test.ts\``)), /more than string literals/)
  assert.throws(() => vitestIncludes(config("")), /test\.include is empty/)
  // test.include, wherever coverage.include sits, and not a bracket in a comment.
  assert.deepEqual(vitestIncludes(`export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] }, /* include: ["x"] */ include: ["src/**/*.test.ts"] } })`), ["src/**/*.test.ts"])
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })`), /no test\.include list/)
  // Only the whole value, set once: a longer expression, a second include or a spread refuses.
  assert.throws(() => vitestIncludes(config(`"src/a.test.ts"].concat(["src/b.test.ts"`)), /test\.include is an expression, not a list \(\.\)/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["a"], include: ["b"] } })`), /test sets include twice/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["a"], ...base } })`), /test object spreads another object/)
  // Nor may the config around it: a spread, a second test, a merge or projects.
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["src/a.test.ts"] }, ...sharedConfig })`), /config object spreads another object, which could set test/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["a"] }, test: { include: ["b"] } })`), /the config sets test twice/)
  assert.throws(() => vitestIncludes(`export default mergeConfig(defineConfig({ test: { include: ["a"] } }), shared)`), /mergeConfig could change test\.include/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["a"], projects: ["b"] } })`), /test declares projects/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["src/a.test.ts"], ["include"]: ["src/a.test.ts", "src/b.test.ts"] } })`), /test has a computed key, which could be include/)
  // A getter or a method can override include too, and refuses before any farm run.
  for (const member of ['get include() { return ["src/a.test.ts", "src/b.test.ts"] }', "include() { return [] }", "async include() {}"]) {
    assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["src/a.test.ts"], ${member} } })`), /test has a member that isn't `name: value`/, member)
  }
  assert.throws(() => vitestIncludes(`export default defineConfig({ get test() { return { include: ["b"] } }, test: { include: ["a"] } })`), /the config has a member that isn't `name: value`/)
  // Only the default export counts, and only if it is the one config.
  assert.throws(() => vitestIncludes(`const smoke = defineConfig({ test: { include: ["src/a.test.ts"] } })\nexport default defineConfig({ test: { include: ["src/**/*.test.ts"] } })`), /more than one defineConfig call/)
  assert.throws(() => vitestIncludes(`const config = defineConfig({ test: { include: ["src/a.test.ts"] } })\nexport default config`), /no export default defineConfig/)
  assert.throws(() => vitestIncludes(`export default { test: { include: ["PACKAGE.test.ts"] } && { include: ["PACKAGE.test.ts", "src/**/*.test.ts"] } }`), /test is an expression, not an object/)
  assert.throws(() => vitestIncludes(`export default defineConfig({ test: { include: ["a"] } }).merge(other)`), /the default export continues past its object/)
  assert.deepEqual(vitestIncludes(`export default defineConfig({ test: { include: ["a"] } });\n`), ["a"])
  // The real config, with another named import after defineConfig's, still reads its eleven patterns.
  const real = readFileSync(join(import.meta.dirname, "../../../apps/mvp/vitest.config.ts"), "utf8")
  assert.equal(vitestIncludes(real.replace('import { defineConfig } from "vitest/config"', 'import { defineConfig } from "vitest/config"\nimport { other } from "./other"')).length, 11)
})

test("an include pattern with glob syntax the land can't expand refuses rather than matching too little", (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/vitest.config.ts", 'export default { test: { include: ["src/**/[a-z]*.test.ts"] } }\n')
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /test\.include pattern src\/\*\*\/\[a-z\]\*\.test\.ts uses glob syntax the land can't expand/)
  for (const glob of ["src/case{1..3}.test.ts", "src/{a,{b,c}}.test.ts"]) {
    write("apps/mvp/vitest.config.ts", `export default { test: { include: ["${glob}"] } }\n`)
    assert.throws(() => affectedPlan(root, jjSource(root, "main")), /uses glob syntax the land can't expand/, glob)
  }
})

test("a change to a shared root file owes every package's tests and apps/mvp's suite; deleting the Vitest config refuses", (t) => {
  const { root, write, source } = fixture(t)
  write("packages/flow/package.json", '{"name":"@x/flow"}\n')
  write(".smithers/target-index.json", JSON.stringify([target("//packages/flow:test"), target("//apps/mvp:importRules")]))
  write("pnpm-lock.yaml", "lockfileVersion: 9\n")
  jj(root, ["commit", "-m", "lock"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("pnpm-lock.yaml", "lockfileVersion: 9\n# a new resolution\n")
  const plan = affectedPlan(root, jjSource(root, "main"))
  assert.deepEqual(plan.labels, ["//apps/mvp:importRules", "//packages/flow:test"])
  assert.equal(plan.reachesMvp, true)
  // So do the install hook and .smithers/WORKSPACE.ts, every target's runtime.
  jj(root, ["restore", "pnpm-lock.yaml"])
  for (const path of [".pnpmfile.mjs", ".smithers/WORKSPACE.ts"]) {
    write(path, "export default {}\n")
    const shared = affectedPlan(root, jjSource(root, "main"))
    assert.deepEqual([shared.labels, shared.reachesMvp], [["//apps/mvp:importRules", "//packages/flow:test"], true], path)
    rmSync(join(root, path))
  }
  // A root file nothing installs through owes nothing.
  jj(root, ["restore", "pnpm-lock.yaml"])
  write("README.md", "docs\n")
  assert.deepEqual(affectedPlan(root, jjSource(root, "main")).labels, [])
  rmSync(join(root, "apps/mvp/vitest.config.ts"))
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /vitest\.config\.ts is missing; cannot compute the affected suites/)
})

test("the runner refuses a target run that was killed after writing a green results file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-runner-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "repo/apps/mvp"), { recursive: true })
  mkdirSync(join(directory, "bin"))
  // smthrs writes every target green, then dies.
  fakeBin(join(directory, "repo"), "@smthrs/cli", `const args = process.argv.slice(2), file = args[args.indexOf("--results-file") + 1]
require("node:fs").writeFileSync(file, JSON.stringify({ results: [{ label: "//a:test", status: "ran" }] }))
// The inventory the land sent reaches the tests that need checkout metadata.
require("node:fs").writeFileSync(process.env.ENV_OUT, JSON.stringify({ mirror: process.env.SMITHERS_TEST_SOURCE_MIRROR, tracked: require("node:fs").readFileSync(process.env.SMITHERS_TEST_TRACKED_SOURCE_FILE, "utf8"), pg: process.env.SMITHERS_TEST_PG_URL ?? null, pool: process.env.SMITHERS_TEST_PGBOUNCER_URL ?? null }))
process.kill(process.pid, process.env.FAKE_SIGNAL ?? "SIGKILL")
`)
  for (const path of [".smithers/WORKSPACE.ts", ".smithers/flows/x.ts", ".smithers/flows/node_modules/dep/index.js"]) {
    mkdirSync(dirname(join(directory, "repo", path)), { recursive: true })
    writeFileSync(join(directory, "repo", path), "")
  }
  const request = Buffer.from(JSON.stringify({ labels: ["//a:test"], vitest: false, tracked: true })).toString("base64")
  const envOut = join(directory, "env.json")
  const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: join(directory, "repo/apps/mvp"), encoding: "utf8", env: { ...process.env, ENV_OUT: envOut, PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    // The farm's slot Postgres, as cfbox's pg image and the mini set it: with a password, and without one.
    SMITHERS_TEST_PG_URL: "postgresql://smithers:smithers@127.0.0.1:54321/smithers", SMITHERS_TEST_PGBOUNCER_URL: "postgresql://smithers@127.0.0.1:6432/smithers" } })
  // The workspace refuses a declared PostgreSQL URL holding a password, so smthrs gets none of those.
  assert.deepEqual(JSON.parse(readFileSync(envOut, "utf8")), { mirror: "1", tracked: ".smithers/WORKSPACE.ts\n.smithers/flows/x.ts\n", pg: null, pool: "postgresql://smithers@127.0.0.1:6432/smithers" })
  const result = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8"))
  assert.match(result.targets.error, /smthrs test ended SIGKILL and no failed target/)
  assert.throws(() => assertComplete({ labels: ["//a:test"], reachesMvp: false, vitestFiles: [] }, result), /INCOMPLETE stage=target-execution/)
})

test("a shard no farm client answers refuses the land and stops the shards still running", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const stopped = []
  const run = (_root, request, { signal }) => request.shard === `2/${vitestShards}`
    ? Promise.reject(new Error("Cannot run the affected tests: no farm client answered"))
    : new Promise((_, reject) => signal.addEventListener("abort", () => { stopped.push(request.shard ?? "targets"); reject(signal.reason) }, { once: true }))
  await assert.rejects(affectedTests(root, { source, run }), /no farm client answered/)
  assert.deepEqual(stopped.sort(), [...shardNames.filter((name) => name !== `2/${vitestShards}`), "targets"].sort())
})

test("targets that declare hosts run only on that platform, and Docker dependency targets go to Latitude", async (t) => {
  const { root, write, source } = fixture(t)
  write(".smithers/target-index.json", JSON.stringify([target("//apps/mvp:importRules", { inputs: [{ kind: "glob", pattern: "apps/mvp/**/*.ts", exclude: [] }] }), { ...target("//apps/mvp:postgres", { inputs: [{ kind: "glob", pattern: "apps/mvp/**/*.ts", exclude: [] }] }), hosts: ["linux"] }]))
  jj(root, ["commit", "-m", "hosts"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const calls = []
  const run = async (_root, request, { clients } = {}) => { calls.push([request.labels.join() || request.shard, clients]); return passing(request) }
  await affectedTests(root, { source, run })
  assert.deepEqual(calls.slice(0, 2), [["//apps/mvp:importRules", undefined], ["//apps/mvp:postgres", affectedHosts().filter((host) => !host.box && host.platform === "linux").map((host) => host.client)]])

  write(".smithers/target-index.json", JSON.stringify([
    target("//apps/mvp:postgres", { inputs: [{ kind: "glob", pattern: "apps/mvp/**/*.ts", exclude: [] }], dependencies: ["//apps/mvp:database"] }),
    { ...target("//apps/mvp:database", { kinds: ["build"] }), rule: "Docker.Service" }
  ]))
  jj(root, ["commit", "-m", "docker target"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("apps/mvp/worker/Chat.ts", "export const chat = 3\n")
  const dockerCalls = []
  await affectedTests(root, { source: jjSource(root, "main"), run: async (_root, request, { clients } = {}) => { dockerCalls.push([request.labels.join(), clients]); return passing(request) } })
  assert.deepEqual(dockerCalls[0], ["//apps/mvp:postgres", affectedHosts().filter((host) => host.docker).map((host) => host.client)])
})

test("a proven regression refuses even when an index target did not run", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const failure = { file: "src/features/chat/chat.test.ts", name: "chat" }
  const run = async (_root, request, { source: tree } = {}) => isBase(tree)
    ? { ...passing(request), vitest: { exit: 0, files: request.vitestFiles, failed: [] } }
    : { ...passing(request), targets: { results: request.labels.map((label) => ({ label, status: "skipped" })) }, vitest: request.shard === `1/${vitestShards}` ? { exit: 1, files: allFiles, failed: [failure] } : request.vitest ? { exit: 0, files: [], failed: [] } : undefined }
  await assert.rejects(affectedTests(root, { source, run }), error => error.status === "refused" && error.regressions.includes("apps/mvp/src/features/chat/chat.test.ts > chat"))
})

test("a change the index and apps/mvp don't reach runs nothing on the farm", async (t) => {
  const { root, write, source } = fixture(t)
  write("packages/elsewhere/y.ts", "export const y = 2\n")
  assert.equal(await affectedTests(root, { source, run: async () => assert.fail("no farm run expected") }), undefined)
})

test("a change owes the tests of every workspace package that depends on it, by package.json, not only index edges", (t) => {
  const { root, write, source } = fixture(t)
  write("packages/flow/package.json", '{"name":"@x/flow"}\n')
  write("packages/flow/src/make.ts", "export const make = 1\n")
  write("packages/agent/package.json", '{"name":"@x/agent","dependencies":{"@x/flow":"^1.0.0"}}\n')
  write("packages/cli/package.json", '{"name":"@x/cli","devDependencies":{"@x/agent":"workspace:*"}}\n')
  write("packages/other/package.json", '{"name":"@x/other"}\n')
  // The index has no edge from agent's or cli's targets to flow's, as for //packages/smithers/agent:test.
  write(".smithers/target-index.json", JSON.stringify(["//packages/flow:test", "//packages/agent:test", "//packages/cli/sub:test", "//packages/other:test"].map((label) => target(label))))
  jj(root, ["commit", "-m", "packages"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("packages/flow/src/make.ts", "export const make = 2\n")
  // A version range links the local package too (linkWorkspacePackages), and a nested target belongs to its package.
  assert.deepEqual(affectedPlan(root, jjSource(root, "main")).labels, ["//packages/agent:test", "//packages/cli/sub:test", "//packages/flow:test"])
  // The root manifest is a package too: its targets, at "", are owed when it depends on the change.
  write("package.json", '{"name":"root","devDependencies":{"@x/flow":"workspace:*"}}\n')
  write(".smithers/target-index.json", JSON.stringify(["//:jsdocRules", "//packages/flow:test", "//packages/other:test"].map((label) => target(label))))
  jj(root, ["commit", "-m", "root"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("packages/flow/src/make.ts", "export const make = 3\n")
  assert.deepEqual(affectedPlan(root, jjSource(root, "main")).labels, ["//:jsdocRules", "//packages/flow:test"])
})

test("a change to a file the farm never receives refuses, since no farm test could see it", (t) => {
  const { root, write, source } = fixture(t)
  write(".npmrc", "registry=https://example.invalid\n")
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /The farm never receives \.npmrc, so no test there can see this change; nothing pushed/)
  // Latitude's own exclusions count too.
  jj(root, ["restore", ".npmrc"])
  write("evals/swebench/logs/run.json", "{}\n")
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /The farm never receives evals\/swebench\/logs\/run\.json/)
})

test("a nested manifest pnpm-workspace.yaml doesn't declare can't take apps/mvp's paths or its suite", (t) => {
  const { root, write } = fixture(t)
  write("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n')
  write("apps/mvp/plugins/demo/package.json", '{"name":"demo-plugin"}\n')
  jj(root, ["commit", "-m", "plugin"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("apps/mvp/plugins/demo/src/demo.ts", "export const demo = 1\n")
  assert.equal(affectedPlan(root, jjSource(root, "main")).reachesMvp, true)
})

test("the farm tests the pinned head commit's bytes, not a checkout edited since", async (t) => {
  const { root, write } = fixture(t)
  write("apps/mvp/src/features/chat/chat.test.ts", "// the candidate\n")
  const source = jjSource(root, "main", jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).trim())
  write("apps/mvp/src/features/chat/chat.test.ts", "// a later edit\n")
  const seen = []
  const run = async (_root, request, { source: tree } = {}) => { if (request.shard === `1/${vitestShards}`) seen.push(readFileSync(join(tree, "apps/mvp/src/features/chat/chat.test.ts"), "utf8")); return passing(request) }
  await affectedTests(root, { source, run })
  assert.deepEqual(seen, ["// the candidate\n"])
})

test("pnpm-workspace.yaml's packages list reads past comments, and an entry it can't read refuses", () => {
  assert.deepEqual(workspaceGlobs('packages:\n  - "packages/*"\n  # applications\n\n  - apps/*\n  - \'./evals/*\'\ncatalog:\n  x: 1\n'), ["packages/*", "apps/*", "evals/*"])
  assert.throws(() => workspaceGlobs('packages:\n  - "packages/*"\n  - { glob: apps }\n'), /cannot read the packages entry/)
  assert.equal(workspaceGlobs(undefined), undefined)
})

test("an include written ./src/** expects the same files as src/**", (t) => {
  const { root, write } = fixture(t)
  write("apps/mvp/vitest.config.ts", 'export default { test: { include: ["./src/**/*.test.{ts,vibe}", "./worker/**/*.test.{ts,vibe}"] } }\n')
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  assert.deepEqual(affectedPlan(root, jjSource(root, "main")).vitestFiles, allFiles)
  write("apps/mvp/vitest.config.ts", 'export default { test: { include: ["../mvp/src/**/*.test.ts"] } }\n')
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /uses glob syntax the land can't expand/)
})

test("a change the index carries to an apps/mvp target owes apps/mvp's whole suite", (t) => {
  const { root, write } = fixture(t)
  write(".smithers/target-index.json", JSON.stringify([target("//apps/mvp:importRules", { inputs: [{ kind: "glob", pattern: "packages/rules/src/**/*.ts", exclude: [] }] })]))
  jj(root, ["commit", "-m", "rules"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("packages/rules/src/ImportRulesCheck.ts", "export const check = 2\n")
  const plan = affectedPlan(root, jjSource(root, "main"))
  assert.deepEqual([plan.labels, plan.reachesMvp, plan.vitestFiles], [["//apps/mvp:importRules"], true, allFiles])
})

test("a rename counts both its paths: a test moved out of apps/mvp still owes apps/mvp's suite", (t) => {
  const { root } = fixture(t)
  mkdirSync(join(root, "docs/archive"), { recursive: true })
  jj(root, ["file", "track", "."])
  renameSync(join(root, "apps/mvp/src/features/chat/chat.test.ts"), join(root, "docs/archive/chat.test.ts"))
  const plan = affectedPlan(root, jjSource(root, "main"))
  assert.deepEqual(plan.changed.sort(), ["apps/mvp/src/features/chat/chat.test.ts", "docs/archive/chat.test.ts"])
  assert.equal(plan.reachesMvp, true)
})

test("a change that deletes or breaks the target index refuses rather than dropping its tests", (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  rmSync(join(root, ".smithers/target-index.json"))
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /target-index\.json is missing; cannot compute the affected suites/)
  write(".smithers/target-index.json", "{ not json")
  assert.throws(() => affectedPlan(root, jjSource(root, "main")), /target-index\.json is not a JSON list/)
})

test("the base tree restores each changed path's base type and mode, and holds nothing the change added", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/run.sh", "#!/bin/sh\necho base\n")
  chmodSync(join(root, "apps/mvp/worker/run.sh"), 0o755)
  symlinkSync("Chat.ts", join(root, "apps/mvp/worker/link.ts"))
  jj(root, ["commit", "-m", "modes"]); jj(root, ["bookmark", "set", "main", "-r", "@-"])
  write("apps/mvp/worker/run.sh", "#!/bin/sh\necho head\n")
  chmodSync(join(root, "apps/mvp/worker/run.sh"), 0o644)
  rmSync(join(root, "apps/mvp/worker/link.ts"))
  write("apps/mvp/worker/link.ts", "export const notALink = 1\n")
  write("apps/mvp/plugins/new/entry.ts", "export const added = 1\n")
  const failure = { file: "src/features/chat/chat.test.ts", name: "chat" }
  let checked = false
  const run = async (_root, request, { source: tree } = {}) => {
    if (!isBase(tree)) return { ...passing(request), vitest: request.shard === `1/${vitestShards}` ? { exit: 1, files: allFiles, failed: [failure] } : request.vitest ? { exit: 0, files: [], failed: [] } : undefined }
    assert.equal(statSync(join(tree, "apps/mvp/worker/run.sh")).mode & 0o777, 0o755)
    assert.equal(readFileSync(join(tree, "apps/mvp/worker/run.sh"), "utf8"), "#!/bin/sh\necho base\n")
    assert.equal(lstatSync(join(tree, "apps/mvp/worker/link.ts")).isSymbolicLink(), true)
    assert.equal(readlinkSync(join(tree, "apps/mvp/worker/link.ts")), "Chat.ts")
    // Nothing the change added, file or directory, and the head's runner.
    assert.equal(existsSync(join(tree, "apps/mvp/plugins")), false)
    assert.equal(existsSync(join(tree, ".smithers/flows/land/affected-run.mjs")), true)
    checked = true
    return { ...passing(request), vitest: { exit: 1, files: request.vitestFiles, failed: [failure] } }
  }
  await affectedTests(root, { source, run })
  assert.equal(checked, true)
})

test("a shard that reports it couldn't run refuses at once and stops its siblings", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const stopped = []
  const run = (_root, request, { signal }) => request.shard === `3/${vitestShards}`
    ? Promise.resolve({ ...passing(request), vitest: { exit: 1, files: [], failed: [], error: "vitest exited 1 and ran no test files: globalSetup failed" } })
    : new Promise((_, reject) => signal.addEventListener("abort", () => { stopped.push(request.shard ?? "targets"); reject(signal.reason) }, { once: true }))
  await assert.rejects(affectedTests(root, { source, run }), /INCOMPLETE stage=vitest-execution/)
  assert.deepEqual(stopped.sort(), [...shardNames.filter((name) => name !== `3/${vitestShards}`), "targets"].sort())
})

test("a base rerun that crashed or skipped a suite excuses nothing; a failing file new to the change is its failure", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  write("apps/mvp/src/features/new/new.test.ts", "// new\n")
  const failed = { label: "//apps/mvp:importRules", status: "failed", failureDigest: "sha256:a" }
  const head = (request, newFailure) => ({
    ...passing(request),
    targets: { results: request.labels.map(() => failed) },
    vitest: request.shard === `1/${vitestShards}` ? { exit: 1, files: [...allFiles, "src/features/new/new.test.ts"], failed: newFailure ? [{ file: "src/features/new/new.test.ts", name: "new" }] : [] } : request.vitest ? { exit: 0, files: [], failed: [] } : undefined,
    client: "mini"
  })
  const requests = []
  const runWith = (base, newFailure = false) => async (_root, request, { source: tree } = {}) => !isBase(tree) ? head(request, newFailure) : (requests.push(request), base(request))
  // smthrs wrote the failed row, then was killed: the runner reports it, and the base can't excuse the failure.
  await assert.rejects(affectedTests(root, { source, run: runWith(() => ({ targets: { results: [failed], error: "smthrs test ended SIGKILL" } })) }), /INCOMPLETE stage=target-execution/)
  // The new file isn't asked of the base, and is named as the change's failure.
  assert.deepEqual(requests[0].vitestFiles, [])
  await assert.rejects(affectedTests(root, { source, run: runWith(() => ({ targets: { results: [failed] } }), true) }), (error) => {
    assert.match(error.message, /fails 1 tests that pass on main; nothing pushed\.\napps\/mvp\/src\/features\/new\/new\.test\.ts > new/)
    return true
  })
  await assert.rejects(affectedTests(root, { source, run: runWith(() => ({ targets: { results: [] } })) }), /INCOMPLETE stage=parent-suite-completeness[\s\S]*\/\/apps\/mvp:importRules/)
})

test("a failed index target reruns on the base and is excused only when the same target fails", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const runWith = (headRow, baseRow) => async (_root, request, { source: tree } = {}) => ({
    ...passing(request),
    targets: { results: request.labels.map((label) => ({ label, ...(!isBase(tree) ? headRow : baseRow) })) },
    client: "mini"
  })
  assert.ok(await affectedTests(root, { source, run: runWith({ status: "failed" }, { status: "failed" }) }))
  assert.ok(await affectedTests(root, { source, run: runWith({ status: "failed", failureDigest: "sha256:b" }, { status: "failed", failureDigest: "sha256:a" }) }))
  await assert.rejects(affectedTests(root, { source, run: runWith({ status: "failed" }, { status: "ran" }) }), /fails 1 tests that pass on main; nothing pushed\.\n\/\/apps\/mvp:importRules \(failed target\)/)
})

test("a zero-test file is excused only when its skip reason matches on the base and the receipt lists it", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const skip = { file: "src/features/chat/chat.test.ts", name: "chat skips without pg", skipped: true }
  const run = async (_root, request, { source: tree } = {}) => {
    return { ...passing(request), vitest: request.vitest && (!isBase(tree) ? request.shard === `1/${vitestShards}` : true)
      ? { exit: 0, files: isBase(tree) ? request.vitestFiles : allFiles, failed: [{ ...skip, name: "(skipped: Postgres unavailable)" }] }
      : request.vitest ? { exit: 0, files: [], failed: [] } : undefined }
  }
  const result = await affectedTests(root, { source, run })
  assert.deepEqual(result.excusedSkippedFiles, ["apps/mvp/src/features/chat/chat.test.ts"])
  await assert.rejects(affectedTests(root, { source, run: async (_root, request, { source: tree } = {}) => {
    if (!request.vitest || (!isBase(tree) && request.shard !== `1/${vitestShards}`)) return passing(request)
    return { ...passing(request), vitest: { exit: 0, files: isBase(tree) ? request.vitestFiles : allFiles, failed: [{ ...skip, name: `(skipped: ${isBase(tree) ? "base reason" : "head reason"})` }] } }
  } }), /fails 1 tests that pass on main/)
})

test("a failed base rerun cancels and settles its sibling before deleting either snapshot", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  let head, base, settled = false, aborted = false
  const run = async (_root, request, { source: tree, signal } = {}) => {
    if (!isBase(tree)) {
      head = tree
      return {
        ...passing(request), client: request.labels.length ? "targets" : "vitest",
        targets: { results: request.labels.map((label) => ({ label, status: "failed" })) },
        vitest: request.vitest ? { exit: 1, files: allFiles, failed: request.shard === `1/${vitestShards}` ? [{ file: allFiles[0], name: "broken" }] : [] } : undefined
      }
    }
    base = tree
    if (request.labels.length) { await new Promise(setImmediate); throw new Error("base target host failed") }
    await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; setTimeout(resolve, 20) }, { once: true }))
    assert.ok(existsSync(join(head, "apps/mvp/worker/Chat.ts")))
    assert.ok(existsSync(join(base, "apps/mvp/worker/Chat.ts")))
    settled = true
    throw signal.reason
  }
  await assert.rejects(affectedTests(root, { source, run }), /base target host failed/)
  assert.ok(aborted && settled)
  assert.equal(existsSync(base), false)
  assert.equal(existsSync(head), false)
})

test("the runner refuses a Vitest run killed after its report, even one naming failures", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-runner-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "repo/apps/mvp"), { recursive: true })
  mkdirSync(join(directory, "bin"))
  fakeBin(join(directory, "repo"), "vitest", `const args = process.argv.slice(2), file = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length)
const name = require("node:path").join(process.cwd(), "src/a.test.ts")
require("node:fs").writeFileSync(file, JSON.stringify({ testResults: [{ name, status: "failed", assertionResults: [{ fullName: "a", status: "failed" }] }] }))
process.kill(process.pid, "SIGKILL")
`)
  const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
  const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: join(directory, "repo/apps/mvp"), encoding: "utf8", env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}` } })
  const result = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8"))
  assert.match(result.vitest.error, /vitest ended SIGKILL/)
})

test("the runner refuses an error outside any test, even beside a failing one, and reports a file that ran no test", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-runner-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "repo/apps/mvp"), { recursive: true })
  mkdirSync(join(directory, "bin"))
  // Vitest as the runner calls it: a JSON report, and the land's reporter told how the run ended.
  fakeBin(join(directory, "repo"), "vitest", `const { readFileSync, writeFileSync } = require("node:fs"), { join } = require("node:path")
const args = process.argv.slice(2), file = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length)
const results = [
  { name: join(process.cwd(), "src/a.test.ts"), status: "failed", assertionResults: [{ fullName: "a", status: "failed" }] },
  { name: join(process.cwd(), "src/skipped.test.ts"), status: "passed", assertionResults: [{ fullName: "s", status: "skipped" }] }
]
writeFileSync(file, JSON.stringify({ testResults: results }))
const reporter = readFileSync(args.find((arg) => arg.startsWith("--reporter=/")).slice("--reporter=".length), "utf8")
writeFileSync(JSON.parse(reporter.match(/writeFileSync\\(("[^"]+")/)[1]), JSON.stringify({ reason: "failed", errors: process.env.UNHANDLED ? ["Error: teardown failed"] : [] }))
process.exit(1)
`)
  const run = (env) => {
    const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: join(directory, "repo/apps/mvp"), encoding: "utf8", env: { ...process.env, ...env, PATH: `${join(directory, "bin")}:${process.env.PATH}` } })
    return JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest
  }
  assert.match(run({ UNHANDLED: "1" }).error, /vitest caught 1 errors outside any test:\nError: teardown failed/)
  const clean = run({})
  assert.equal(clean.error, undefined)
  assert.deepEqual(clean.failed, [{ file: "src/a.test.ts", name: "a" }, { file: "src/skipped.test.ts", name: "(ran no tests)", unexcused: true }])
})

test("the runner names each failure apart: a repeated title by its place, a file that failed by its error", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-runner-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, "repo/apps/mvp"), { recursive: true })
  mkdirSync(join(directory, "bin"))
  fakeBin(join(directory, "repo"), "vitest", `const { readFileSync, writeFileSync } = require("node:fs"), { join } = require("node:path")
const args = process.argv.slice(2), file = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length)
const results = JSON.parse(process.env.RESULTS).map((result) => ({ ...result, name: join(process.cwd(), result.name), message: result.message?.replace("APP", process.cwd()) }))
writeFileSync(file, JSON.stringify({ testResults: results }))
const reporter = readFileSync(args.find((arg) => arg.startsWith("--reporter=/")).slice("--reporter=".length), "utf8")
writeFileSync(JSON.parse(reporter.match(/writeFileSync\\(("[^"]+")/)[1]), JSON.stringify({ reason: "failed", errors: [], modules: JSON.parse(process.env.MODULE_ERRORS ?? '[]').map(module => ({ ...module, moduleId: join(process.cwd(), module.moduleId) })) }))
process.exit(1)
`)
  const failedOf = (results, modules = []) => {
    const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: join(directory, "repo/apps/mvp"), encoding: "utf8", env: { ...process.env, RESULTS: JSON.stringify(results), MODULE_ERRORS: JSON.stringify(modules), PATH: `${join(directory, "bin")}:${process.env.PATH}` } })
    return JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest.failed
  }
  const cases = (first, second) => [{ name: "src/each.test.ts", status: "failed", assertionResults: [{ fullName: "row", status: first }, { fullName: "row", status: second }] }]
  assert.deepEqual(failedOf(cases("failed", "passed")).map((test) => test.name), ["row [1 of 2]"])
  assert.deepEqual(failedOf(cases("passed", "failed")).map((test) => test.name), ["row [2 of 2]"])
  const broken = (message) => failedOf([{ name: "src/import.test.ts", status: "failed", message, assertionResults: [] }])[0]
  const missingA = broken("SyntaxError: APP/src/x.ts does not export A"), missingB = broken("SyntaxError: APP/src/x.ts does not export B")
  assert.notEqual(missingA.name, missingB.name)
  assert.match(missingA.name, /^\(the file failed: [0-9a-f]{16}\) SyntaxError: <app>\/src\/x\.ts does not export A$/)
  assert.deepEqual(broken(undefined), { file: "src/import.test.ts", name: "(the file failed, with no error)", unexcused: true })
  // A hook's error stands beside a test that already failed, so the base failing that test can't excuse it.
  const both = failedOf([{ name: "src/hooks.test.ts", status: "failed", message: "Error: afterAll broke", assertionResults: [{ fullName: "old", status: "failed" }] }]).map((test) => test.name)
  assert.equal(both.length, 2)
  assert.equal(both[0], "old")
  assert.match(both[1], /^\(the file failed: [0-9a-f]{16}\) Error: afterAll broke$/)
  const message = "browserType.launch: Executable doesn't exist"
  const collision = `(the file failed: ${createHash("sha256").update(message).digest("hex").slice(0, 16)}) ${message}`
  const distinct = failedOf([{ name: "src/collision.test.ts", status: "failed", assertionResults: [{ fullName: collision, status: "failed" }] }], [{ moduleId: "src/collision.test.ts", errors: [message] }])
  assert.equal(distinct.length, 2, "an identically named assertion must not suppress a module error")
  assert.deepEqual(distinct.map(row => row.assertion === true), [true, false])
})

test("a failure with no identity to compare is never excused, though the base fails the same way", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const opaque = { file: "src/features/chat/chat.test.ts", name: "(the file failed, with no error)", unexcused: true }
  const run = async (_root, request, { source: tree } = {}) => ({ ...passing(request), vitest: request.vitest && (isBase(tree) || request.shard === `1/${vitestShards}`) ? { exit: 1, files: request.vitestFiles ?? allFiles, failed: [opaque] } : request.vitest ? { exit: 0, files: [], failed: [] } : undefined, client: "mini" })
  await assert.rejects(affectedTests(root, { source, run }), /fails 1 tests that pass on main; nothing pushed\.\napps\/mvp\/src\/features\/chat\/chat\.test\.ts > \(the file failed, with no error\)/)
})

test("with real Vitest, a nested afterAll that breaks beside a test already failing is a failure of its own", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-vitest-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const app = join(directory, "repo/apps/mvp")
  mkdirSync(join(app, "node_modules"), { recursive: true })
  // The installed Vitest, linked in as an install would leave it.
  symlinkSync(dirname(createRequire(join(import.meta.dirname, "../../../apps/mvp/package.json")).resolve("vitest/package.json")), join(app, "node_modules/vitest"))
  writeFileSync(join(app, "package.json"), '{"name":"mvp","type":"module"}\n')
  const file = (afterAll) => writeFileSync(join(app, "hooks.test.js"), `import { afterAll, describe, expect, it } from "vitest"
describe("outer", () => {
  it("was already failing", () => expect(1).toBe(2))
  describe("inner", () => {
    it("passes", () => expect(1).toBe(1))
    ${afterAll ? 'afterAll(() => { throw new Error("inner afterAll broke") })' : ""}
  })
})
`)
  const failed = () => {
    const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: app, encoding: "utf8" })
    const vitest = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest
    assert.equal(vitest.error, undefined, vitest.error)
    return vitest.failed.map((test) => test.name)
  }
  file(false)
  const before = failed()
  file(true)
  const after = failed()
  assert.deepEqual(before, ["outer was already failing"])
  assert.equal(after.length, 2, after.join("\n"))
  assert.match(after.find((name) => name !== "outer was already failing"), /^\(the file failed: [0-9a-f]{16}\) .*inner afterAll broke/)
})

test("real Vitest skip notes become hashed identities without printing the note", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-skipped-vitest-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const app = join(directory, "repo/apps/mvp")
  mkdirSync(join(app, "node_modules"), { recursive: true })
  symlinkSync(dirname(createRequire(join(import.meta.dirname, "../../../apps/mvp/package.json")).resolve("vitest/package.json")), join(app, "node_modules/vitest"))
  writeFileSync(join(app, "package.json"), '{"name":"mvp","type":"module"}\n')
  writeFileSync(join(app, "skipped.test.js"), `import { it } from "vitest"\nit("database suite", (context) => context.skip("database unavailable"))\n`)
  const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
  const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: app, encoding: "utf8" })
  const output = ran.stdout + ran.stderr
  const vitest = JSON.parse(Buffer.from(output.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest
  assert.equal(vitest.error, undefined, vitest.error)
  assert.match(vitest.failed[0].name, /^\(skipped reason sha256:[a-f0-9]{64}\)$/)
  assert.doesNotMatch(output, /database unavailable/)
})

test("a Git checkout's head is the validated tree: no file it deleted, no edit made after", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-git-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (...args) => spawnSync("git", ["-c", "user.name=Devx", "-c", "user.email=devx@example.invalid", ...args], { cwd: directory, encoding: "utf8" })
  git("init", "-q", ".")
  writeFileSync(join(directory, "kept.test.ts"), "// kept\n")
  writeFileSync(join(directory, "gone.test.ts"), "// gone\n")
  git("add", "."); git("commit", "-qm", "base")
  // git archive would drop the first and rewrite the second; the snapshot keeps both as stored.
  writeFileSync(join(directory, ".gitattributes"), "optional.json export-ignore\nversion.txt export-subst\n")
  writeFileSync(join(directory, "optional.json"), "{}\n")
  writeFileSync(join(directory, "version.txt"), "$Format:%H$\n")
  rmSync(join(directory, "gone.test.ts"))
  writeFileSync(join(directory, "new.test.ts"), "// new\n")
  // The tree commit.mjs validated: everything staged into a private index, as its snapshot() does.
  const index = join(directory, ".git/private-index")
  spawnSync("git", ["add", "--all"], { cwd: directory, env: { ...process.env, GIT_INDEX_FILE: index } })
  const tree = spawnSync("git", ["write-tree"], { cwd: directory, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: index } }).stdout.trim()
  const source = gitSource(directory, "HEAD", tree)
  assert.deepEqual(source.files().sort(), [".gitattributes", "kept.test.ts", "new.test.ts", "optional.json", "version.txt"])
  // Changed paths come from the base and the validated tree, whatever the checkout says now.
  const changed = [".gitattributes", "gone.test.ts", "new.test.ts", "optional.json", "version.txt"]
  assert.deepEqual(source.changed().sort(), changed)
  writeFileSync(join(directory, "gone.test.ts"), "// gone\n")
  assert.deepEqual(source.changed().sort(), changed)
  // An edit after the snapshot doesn't reach what the farm is sent.
  writeFileSync(join(directory, "kept.test.ts"), "// edited later\n")
  const out = mkdtempSync(join(tmpdir(), "land-affected-git-out-"))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  source.materialize(out)
  assert.equal(readFileSync(join(out, "kept.test.ts"), "utf8"), "// kept\n")
  assert.equal(existsSync(join(out, "gone.test.ts")), false)
  assert.equal(readFileSync(join(out, "optional.json"), "utf8"), "{}\n")
  assert.equal(readFileSync(join(out, "version.txt"), "utf8"), "$Format:%H$\n")
})

// A land, end to end: a lane, a remote main, and a farm client that runs the land's own runner in a synced tree.
// Its `pnpm exec vitest` runs each apps/mvp test file found, and a test file reading `absent <word> <path>`
// fails when <path> holds <word>. FAKE_VITEST_SKIP names a directory that vitest silently doesn't run.
const fakePnpm = `#!${process.execPath}
const { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs"), { join } = require("node:path")
// One script, two parts: as pnpm, \`install\` puts itself in node_modules as vitest's bin; as that bin it is
// vitest, logged as the \`pnpm exec vitest\` it stands for.
const asVitest = __filename.endsWith("bin.cjs")
const args = asVitest ? ["exec", "vitest", ...process.argv.slice(2)] : process.argv.slice(2)
appendFileSync(process.env.PNPM_LOG, "pnpm " + args.filter((arg) => !arg.startsWith("--outputFile") && !arg.startsWith("--reporter=/")).join(" ") + "\\n")
if (args[0] === "install") {
  const dir = join(process.cwd(), "node_modules/vitest")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "vitest", bin: { vitest: "./bin.cjs" } }))
  copyFileSync(__filename, join(dir, "bin.cjs"))
}
if (args[0] !== "exec" || args[1] !== "vitest") process.exit(0)
const walk = (dir) => readdirSync(dir).flatMap((name) => statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)])
const shard = args.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length)
// FAKE_SHARD_HANG: that shard runs a minute, past any refusal; FAKE_SHARD_BROKEN: that shard's global setup fails, so no file runs.
if (shard && shard === process.env.FAKE_SHARD_HANG) setTimeout(() => process.exit(1), 60000)
else if (shard && shard === process.env.FAKE_SHARD_BROKEN) setTimeout(() => {
  writeFileSync(args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length), JSON.stringify({ testResults: [] }))
  process.stderr.write("Error: globalSetup failed\\n")
  process.exit(1)
}, 300)
else {
const named = args.slice(3).filter((arg) => !arg.startsWith("-"))
const skip = process.env.FAKE_VITEST_SKIP
const [index, count] = (args.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length) ?? "1/1").split("/").map(Number)
const files = (named.length ? named : walk("src").filter((path) => path.endsWith(".test.ts")).sort().filter((_, i) => i % count === index - 1))
  .filter((path) => !skip || !path.startsWith(skip))
const testResults = files.map((file) => {
  const [, word, path] = readFileSync(file, "utf8").match(/absent (\\S+) (\\S+)/)
  const status = readFileSync(path, "utf8").includes(word) ? "failed" : "passed"
  return { name: join(process.cwd(), file), status, assertionResults: [{ fullName: file + " has no " + word, status }] }
})
writeFileSync(args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length), JSON.stringify({ testResults }))
// The land's own reporter records how the run ended; FAKE_VITEST_UNHANDLED is an error outside any test.
const reporter = args.find((arg) => arg.startsWith("--reporter=/")).slice("--reporter=".length)
const ending = readFileSync(reporter, "utf8").match(/writeFileSync\\(("[^"]+")/)[1]
writeFileSync(JSON.parse(ending), JSON.stringify({ reason: "passed", errors: process.env.FAKE_VITEST_UNHANDLED ? [process.env.FAKE_VITEST_UNHANDLED] : [] }))
// FAKE_VITEST_EXIT: a run whose every test passed and that still failed, as on an unhandled error.
process.exit(Number((testResults.length && process.env.FAKE_VITEST_EXIT) || (testResults.some((file) => file.status === "failed") ? 1 : 0)))
}
`

const shards = Array.from({ length: vitestShards }, (_, i) => `pnpm exec vitest run --coverage.enabled=false --reporter=json --shard=${i + 1}/${vitestShards}`).sort()

function landFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-e2e-"))
  const names = ["SMITHERS_AFFECTED_LOCK", "SMITHERS_MINI_RUN", "SMITHERS_LAT_RUN", "SMITHERS_CFBOX", "FAKE_BOX_EXIT", "FAKE_BOX_CRASH", "FAKE_SHARD_HANG", "FAKE_SHARD_BROKEN", "PATH", "PNPM_LOG", "SMITHERS_REVIEWS_DIR", "FAKE_VITEST_SKIP", "FAKE_VITEST_EXIT", "FAKE_CLIENT_EXIT", "FAKE_VITEST_UNHANDLED"]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const savedInbox = overrideInbox.path
  t.after(() => {
    overrideInbox.path = savedInbox
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, "root")
  const put = (base, path, text, mode) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text, { mode }) }
  mkdirSync(root)
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  put(root, ".smithers/flows/land/affected-run.mjs", readFileSync(join(import.meta.dirname, "affected-run.mjs"), "utf8"))
  put(root, ".gitignore", "node_modules/\n")
  put(root, "apps/mvp/package.json", '{"name":"mvp"}\n')
  put(root, "apps/mvp/vitest.config.ts", 'export default { test: { include: ["src/**/*.test.ts"] } }\n')
  put(root, "apps/mvp/worker/questions.ts", 'export const role = "Viewer"\n')
  put(root, "apps/mvp/src/questions.test.ts", "// absent Member worker/questions.ts\n")
  put(root, "apps/mvp/src/features/chat/chat.test.ts", "// absent Broken worker/questions.ts\n")
  put(root, "apps/mvp/src/features/pins/pins.test.ts", "// absent Broken worker/questions.ts\n")
  jj(root, ["commit", "-m", "base"])
  jj(root, ["bookmark", "set", "main", "-r", "@-"])
  const remote = join(directory, "remote")
  jj(directory, ["git", "clone", root, remote])
  jj(root, ["git", "remote", "add", "origin", remote])
  jj(root, ["git", "fetch", "--remote", "origin"])
  jj(root, ["bookmark", "track", "main@origin"])
  const lane = join(directory, "lane")
  jj(directory, ["git", "clone", remote, lane])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(lane, ["config", "set", "--repo", key, value])
  put(directory, "bin/pnpm", fakePnpm, 0o755)
  process.env.PATH = `${join(directory, "bin")}:${process.env.PATH}`
  process.env.SMITHERS_AFFECTED_LOCK = join(directory, "affected-pg.lock")
  process.env.PNPM_LOG = join(directory, "pnpm.log")
  process.env.SMITHERS_REVIEWS_DIR = join(directory, "reviews")
  overrideInbox.path = join(directory, "inbox.md")
  writeFileSync(overrideInbox.path, "")
  // Each client drops `<dir> --` and runs the command in that directory of the tree it was handed.
  for (const name of ["SMITHERS_MINI_RUN", "SMITHERS_LAT_RUN"]) {
    process.env[name] = join(directory, name)
    // FAKE_CLIENT_EXIT: the client fails after the command printed its receipt.
    put(directory, name, `#!/bin/sh\necho "[lat-run] nyc-test slot 1" >&2\nenv | grep -E '^(MINI|LAT)_RUN_(TIMEOUT|WAIT)_SECONDS=' | sort >> "${join(directory, "client.env")}"\ndir=$1; shift 2; (cd "$MINI_RUN_SRC/$dir" && pnpm install >/dev/null && "$@") || exit $?\ncase \"$*\" in *affected-run.mjs*) exit \${FAKE_CLIENT_EXIT:-0};; esac\n`, 0o755)
  }
  // cfbox: `run|parallel <options> --cwd <sub> <tree> -- <command> [::: <command>...]`, each command in that
  // subdirectory of the tree; parallel prefixes each job's lines `[n] ` and ends with cfbox's exit table.
  // FAKE_BOX_EXIT fails before any command, as cfbox's 125 does.
  process.env.SMITHERS_CFBOX = join(directory, "cfbox")
  put(directory, "cfbox", `#!${process.execPath}
const { appendFileSync } = require("node:fs"), { spawn, spawnSync } = require("node:child_process"), { join } = require("node:path")
const args = process.argv.slice(2), verb = args[0], cut = args.indexOf("--")
appendFileSync(${JSON.stringify(join(directory, "box.log"))}, args.slice(0, cut).join(" ") + "\\n")
if (process.env.FAKE_BOX_EXIT) process.exit(Number(process.env.FAKE_BOX_EXIT))
const cwd = args[args.indexOf("--cwd") + 1], tree = args[cut - 1], jobs = [[]]
for (const arg of args.slice(cut + 1)) arg === ":::" ? jobs.push([]) : jobs.at(-1).push(arg)
const exit = (code) => Number(process.env.FAKE_CLIENT_EXIT ?? 0) || code
if (verb === "run") {
  const ran = spawnSync(jobs[0][0], jobs[0].slice(1), { cwd: join(tree, cwd), stdio: "inherit" })
  process.exit(ran.status || exit(0))
}
// The jobs run at once and stream, each line prefixed; SIGTERM stops them, as cfbox stops its boxes.
const children = []
process.on("SIGTERM", () => { for (const child of children) child.kill("SIGKILL"); process.exit(143) })
Promise.all(jobs.map((job, i) => new Promise((done) => {
  const child = spawn(job[0], job.slice(1), { cwd: join(tree, cwd) })
  children.push(child)
  let pending = ""
  const out = (chunk) => { pending += chunk; const lines = pending.split("\\n"); pending = lines.pop(); for (const line of lines) process.stdout.write("[" + (i + 1) + "] " + line + "\\n") }
  child.stdout.on("data", out); child.stderr.on("data", out)
  child.on("close", (code) => { if (!process.env.FAKE_BOX_CRASH) process.stderr.write("cfbox: [" + (i + 1) + "] exit " + (code || exit(0)) + "; command 1.0s, wall 1.0s\\n"); done(code || exit(0)) })
}))).then((codes) => {
  process.stderr.write("cfbox: job  exit  command_s  wall_s  command\\n")
  codes.forEach((code, i) => process.stderr.write("cfbox: " + String(i + 1).padStart(3) + "  " + String(code).padStart(4) + "        1.0     1.0  job\\n"))
  // FAKE_BOX_CRASH: cfbox dies with its jobs' receipts printed but no job's end reported, as a killed client.
  process.exit(Number(process.env.FAKE_BOX_CRASH ?? 0) || (codes.find((code) => code !== 0) ?? 0))
})
`, 0o755)
  const onMain = () => { jj(remote, ["git", "import", "--ignore-working-copy"]); return jj(remote, ["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "description.first_line()"]) }
  // A lane that says its tests already ran: the gate runs them anyway.
  const landing = () => landWorkspace(lane, { message: "fix: a lane", validation: "lane receipt: ran src/features/pins only", lockPath: join(directory, "main-push.lock") })
  const vitestRuns = () => readFileSync(process.env.PNPM_LOG, "utf8").split("\n").filter((line) => line.startsWith("pnpm exec vitest"))
  const clientEnv = () => [...new Set(readFileSync(join(directory, "client.env"), "utf8").trim().split("\n"))]
  const boxRuns = () => readFileSync(join(directory, "box.log"), "utf8").trim().split("\n")
  const audit = (stage) => {
    const row = JSON.parse(readFileSync(join(directory, "reviews/land-log.jsonl"), "utf8").trim().split("\n").at(-1))
    assert.equal(row.gate, "incomplete")
    assert.equal(row.stage, stage)
    assert.match(readFileSync(overrideInbox.path, "utf8"), new RegExp(`\\[land-override\\].*gate: incomplete, stage=${stage}`))
  }
  return { lane: (path, text) => { put(lane, path, text); jj(lane, ["status"]) }, onMain, landing, vitestRuns, clientEnv, boxRuns, audit }
}

test("a land whose change turns an apps/mvp test red is refused, even with --validated, naming the test", async (t) => {
  const { lane, onMain, landing, vitestRuns } = landFixture(t)
  lane("apps/mvp/worker/questions.ts", 'export const role = "Member"\n')
  await assert.rejects(landing(), (error) => {
    assert.match(error.message, /fails 1 tests that pass on [0-9a-f]{40}; nothing pushed/)
    assert.match(error.message, /apps\/mvp\/src\/questions\.test\.ts > src\/questions\.test\.ts has no Member/)
    return true
  })
  assert.equal(onMain(), "base")
  // The whole suite on the head in six shards, then only the failing file on the base.
  const runs = vitestRuns()
  assert.deepEqual(runs.slice(0, vitestShards).sort(), shards)
  assert.deepEqual(runs.slice(vitestShards), ["pnpm exec vitest run --coverage.enabled=false --reporter=json src/questions.test.ts"])
})

test("a --validated land whose run misses affected suites proceeds with both incomplete audits", async (t) => {
  const { lane, onMain, landing, audit } = landFixture(t)
  lane("apps/mvp/worker/questions.ts", 'export const role = "Viewer" as const\n')
  process.env.FAKE_VITEST_SKIP = "src/features/chat"
  await landing()
  assert.equal(onMain(), "fix: a lane")
  audit("suite-completeness")
})

test("a clean apps/mvp change runs every affected suite in parallel pg boxes and lands", async (t) => {
  const { lane, onMain, landing, vitestRuns, boxRuns } = landFixture(t)
  lane("apps/mvp/worker/questions.ts", 'export const role = "Viewer" as const\n')
  await landing()
  assert.equal(onMain(), "fix: a lane")
  assert.deepEqual(vitestRuns().sort(), shards)
  // One cfbox parallel for every shard, one box each, on the pg image through nyc-01, installing first.
  const boxes = boxRuns()
  assert.equal(boxes.length, 1)
  assert.match(boxes[0], /^parallel --image pg --cpu 4 --via nyc-01 --with-deps --cwd apps\/mvp \/\S+smithers-affected-head-\S+$/)
  assert.equal(readFileSync(process.env.PNPM_LOG, "utf8").split("\n").filter((line) => line === "pnpm install --frozen-lockfile --prefer-offline").length, vitestShards)
})

test("a cfbox that dies after its jobs reported green is incomplete with no fallback", async (t) => {
  const { lane, onMain, landing, audit } = landFixture(t)
  lane("apps/mvp/worker/questions.ts", 'export const role = "Viewer" as const\n')
  process.env.FAKE_BOX_CRASH = "137"
  await landing()
  assert.equal(onMain(), "fix: a lane")
  audit("farm-transport")
})

test("an incomplete shard waits for final acknowledgments only within the wall bound", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  const client = join(dirname(root), "cfbox"), marker = join(dirname(root), "reported")
  const keys = ["SMITHERS_CFBOX", "SMITHERS_AFFECTED_LOCK"], previous = keys.map(key => process.env[key])
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }))
  process.env.SMITHERS_CFBOX = client; process.env.SMITHERS_AFFECTED_LOCK = join(dirname(root), "pg.lock")
  writeFileSync(client, `#!${process.execPath}\nconst fs=require('node:fs');const r={targets:{results:[]},vitest:{files:[],failed:[],stage:'global-setup',error:'setup incomplete'}};console.log('[1] SMITHERS_AFFECTED '+Buffer.from(JSON.stringify(r)).toString('base64'));fs.writeFileSync(${JSON.stringify(marker)},'reported');setInterval(()=>{},1000);\n`, { mode: 0o755 })
  const started = Date.now()
  await assert.rejects(affectedTests(root, { source, timeoutMs: 3000 }), error => error.status === "incomplete" && error.stage === "execution-deadline")
  assert.equal(existsSync(marker), true)
  assert.ok(Date.now() - started < 5000)
})

test("when no box starts, the land proceeds and audits incomplete transport", async (t) => {
  const { lane, onMain, landing, audit } = landFixture(t)
  lane("apps/mvp/worker/questions.ts", 'export const role = "Viewer" as const\n')
  process.env.FAKE_BOX_EXIT = "125"
  await landing()
  assert.equal(onMain(), "fix: a lane")
  audit("farm-transport")
})

test("an unexplained Vitest exit or a lost client acknowledgment proceeds with incomplete audits", async (t) => {
  for (const [variable, value, stage] of [["FAKE_VITEST_EXIT", "1", "vitest-execution"], ["FAKE_CLIENT_EXIT", "137", "farm-transport"]]) {
    await t.test(variable, async (t) => {
      const { lane, onMain, landing, audit } = landFixture(t)
      lane("apps/mvp/worker/questions.ts", 'export const role = "Viewer" as const\n')
      process.env[variable] = value
      await landing()
      assert.equal(onMain(), "fix: a lane")
      audit(stage)
    })
  }
})


test("box receipt polling ignores partial records and reports malformed complete records", () => {
  const seen = new Set(), got = []
  const row = { targets: { results: [] } }
  const record = `[1] SMITHERS_AFFECTED ${Buffer.from(JSON.stringify(row)).toString("base64")}`
  for (let i = 1; i <= record.length; i++) readBoxReceipts(record.slice(0, i), seen, (_, value) => got.push(value))
  assert.deepEqual(got, [])
  assert.equal(seen.size, 0)
  readBoxReceipts(record + "\n", seen, (_, value) => got.push(value))
  readBoxReceipts(record + "\n", seen, (_, value) => got.push(value))
  assert.deepEqual(got, [row])
  assert.throws(() => readBoxReceipts("[2] SMITHERS_AFFECTED ewo=\n", seen, () => {}), /Invalid affected-tests receipt from box 2/)
  assert.equal(seen.has("2"), false)
})

test("base target reruns retain the Latitude server selected for the head", async (t) => {
  const { root, write, source } = fixture(t)
  write("apps/mvp/worker/Chat.ts", "export const chat = 2\n")
  let reran = false
  const run = async (_root, request, options) => {
    if (isBase(options.source)) {
      reran = true
      assert.deepEqual(options.clients, ["lat"])
      assert.equal(options.host, "nyc-02")
    }
    return { ...passing(request), client: "lat", host: "nyc-02", targets: { results: request.labels.map((label) => ({ label, status: "failed" })) } }
  }
  await affectedTests(root, { source, run })
  assert.equal(reran, true)
})


test("real Vitest collection errors cannot excuse a file with zero executed tests", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-collection-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const app = join(directory, "repo/apps/mvp")
  mkdirSync(join(app, "node_modules"), { recursive: true })
  symlinkSync(dirname(createRequire(join(import.meta.dirname, "../../../apps/mvp/package.json")).resolve("vitest/package.json")), join(app, "node_modules/vitest"))
  writeFileSync(join(app, "package.json"), '{"name":"mvp","type":"module"}\n')
  writeFileSync(join(app, "collection.test.js"), 'throw new Error("collection failed before any assertion")\n')
  const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
  for (let tree = 0; tree < 2; tree++) {
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: app, encoding: "utf8" })
    const vitest = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest
    assert.equal(vitest.error, undefined, vitest.error)
    assert.ok(vitest.failed.some((test) => test.name.includes("collection failed before any assertion")))
    assert.deepEqual(vitest.failed.find((test) => test.unexcused), { file: "collection.test.js", name: "(ran no tests)", unexcused: true })
    assert.equal(vitest.failed.some((test) => test.skipped), false)
  }
})


test("real Vitest concurrent skip callbacks compare by name and reason independent of completion order", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-affected-concurrent-skips-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const app = join(directory, "repo/apps/mvp")
  mkdirSync(join(app, "node_modules"), { recursive: true })
  symlinkSync(dirname(createRequire(join(import.meta.dirname, "../../../apps/mvp/package.json")).resolve("vitest/package.json")), join(app, "node_modules/vitest"))
  writeFileSync(join(app, "package.json"), '{"name":"mvp","type":"module"}\n')
  const request = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
  const identities = []
  for (const delayFirst of [true, false]) {
    writeFileSync(join(app, "skips.test.js"), `import { it } from "vitest"
const delay = () => new Promise((resolve) => setTimeout(resolve, 40))
it.concurrent("first", async (context) => { ${delayFirst ? "await delay();" : ""} context.skip("first reason") })
it.concurrent("second", async (context) => { ${delayFirst ? "" : "await delay();"} context.skip("second reason") })
`)
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), request], { cwd: app, encoding: "utf8" })
    const vitest = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8")).vitest
    assert.equal(vitest.error, undefined, vitest.error)
    assert.equal(vitest.failed.length, 1)
    assert.equal(vitest.failed[0].skipped, true)
    identities.push(vitest.failed[0].name)
  }
  assert.equal(identities[0], identities[1])
})

test("runner browser setup plus derived zero tests remains incomplete for new and edited files", async (t) => {
  for (const kind of ["new", "edited", "module-only", "named-failure", "reserved-name", "browser-name"]) {
    const { root, write, source } = fixture(t)
    const file = kind === "edited" ? "src/features/chat/chat.test.ts" : "src/new.test.ts"
    write(`apps/mvp/${file}`, "// changed test\n")
    let receipt
    const run = async (snapshot, request, options) => {
      if (!request.vitest) return { ...passing(request), client: "pg" }
      if (request.shard !== "1/6") return { targets: { results: [] }, vitest: { exit: 0, files: allFiles.filter(name => name !== file), failed: [] }, client: "pg" }
      fakeBin(snapshot, "vitest", `const {readFileSync,writeFileSync}=require('node:fs'),{join}=require('node:path');const args=process.argv.slice(2),report=args.find(x=>x.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);writeFileSync(report,JSON.stringify({testResults:[{name:join(process.cwd(),${JSON.stringify(file)}),status:'failed',message:${JSON.stringify(kind === "module-only" ? undefined : "browserType.launch: Executable doesn't exist")},assertionResults:${JSON.stringify(["named-failure", "reserved-name", "browser-name"].includes(kind) ? [{ fullName: kind === "reserved-name" ? "(ran no tests)" : kind === "browser-name" ? "(the file failed: abcd1234) browserType.launch: Executable doesn't exist" : "independent failure", status: "failed" }] : [])}}]}));const reporter=readFileSync(args.find(x=>x.startsWith('--reporter=/')).slice('--reporter='.length),'utf8');writeFileSync(JSON.parse(reporter.match(/writeFileSync\\(("[^"]+")/)[1]),JSON.stringify({reason:'failed',errors:[],modules:${kind === "module-only" ? `[ {moduleId:join(process.cwd(),${JSON.stringify(file)}),errors:[\"browserType.launch: Executable doesn't exist\"]} ]` : "[]"}}));process.exit(1);`)
      const encoded = Buffer.from(JSON.stringify({ labels: [], vitest: true })).toString("base64")
      const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), encoded], { cwd: join(snapshot, "apps/mvp"), encoding: "utf8" })
      assert.equal(ran.status, 0, ran.stderr)
      receipt = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8"))
      assert.equal(receipt.vitest.error, undefined)
      assert.ok(receipt.vitest.failed.some(row => row.name.includes("browserType.launch")))
      if (!["named-failure", "browser-name"].includes(kind)) assert.ok(receipt.vitest.failed.some(row => row.name === "(ran no tests)"))
      return { ...receipt, client: "pg" }
    }
    await assert.rejects(affectedTests(root, { source, run }), error => ["named-failure", "reserved-name", "browser-name"].includes(kind)
      ? error.status === "refused" && error.regressions.includes(`apps/mvp/${file} > ${kind === "reserved-name" ? "(ran no tests)" : kind === "browser-name" ? "(the file failed: abcd1234) browserType.launch: Executable doesn't exist" : "independent failure"}`)
      : error.status === "incomplete" && error.stage === "browser-setup")
    assert.ok(receipt)
  }
})
