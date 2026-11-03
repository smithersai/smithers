import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { jj } from "./numbering.mjs"
import { runAffectedGate, requireAffectedReceipt } from "./affected-receipt.mjs"
import { acquireLock, landWorkspace } from "./workspace.mjs"
import { AffectedIncomplete } from "./affected.mjs"
import { logLanding, overrideInbox } from "./review.mjs"

function fixture(t, withMvp = false) {
  const directory = mkdtempSync(join(tmpdir(), "affected-receipt-")), root = join(directory, "root")
  mkdirSync(root)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  jj(root, ["git", "init", "."])
  jj(root, ["config", "set", "--repo", "user.name", "Receipt fixture"])
  jj(root, ["config", "set", "--repo", "user.email", "receipt@example.invalid"])
  const write = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes) }
  write(".smithers/target-index.json", JSON.stringify(["a", "b"].map((name) => ({ label: `//packages/${name}:test`, package: `packages/${name}`, kinds: ["test"], inputs: [{kind:"glob",pattern:`packages/${name}/**/*.ts`}], dependencies: [] }))))
  for (const name of ["a", "b"]) { write(`packages/${name}/package.json`, JSON.stringify({ name })); write(`packages/${name}/x.ts`, "before\n") }
  if (withMvp) {
    write("apps/mvp/package.json", '{"name":"mvp","dependencies":{"a":"workspace:*"}}')
    write("apps/mvp/vitest.config.ts", 'export default { test: { include: ["src/**/*.test.ts"] } }')
    write("apps/mvp/src/proof.test.ts", "// completed file\n")
  }
  jj(root, ["commit", "-m", "base"])
  const base = jj(root, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
  jj(root, ["bookmark", "set", "main", "-r", base])
  const remote = join(directory, "remote")
  jj(directory, ["git", "clone", root, remote])
  jj(root, ["git", "remote", "add", "origin", remote])
  jj(root, ["git", "fetch"])
  write("packages/a/x.ts", "change\n")
  const advance = (name, update) => {
    const change = jj(root, ["log", "-r", "@", "--no-graph", "-T", "change_id"])
    jj(root, ["new", base])
    write(`packages/${name}/other.ts`, "intervening\n")
    update?.(write)
    jj(root, ["describe", "-m", `intervening ${name}`])
    const main = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
    jj(root, ["rebase", "-r", change, "-d", main])
    jj(root, ["edit", change])
    return main
  }
  jj(root, ["status"])
  return { root, directory, base, write, advance }
}
const passing = async (_root, request) => ({ targets: { results: request.labels.map((label) => ({ label, status: "ran" })) } })

const revision = (root, rev = "@") => jj(root, ["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", "commit_id"])
const operation = root => jj(root, ["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'])
const counts = { targets: 2, files: 3, sharedFailures: 1 }

for (const kind of ["assertion", "hook", "module"]) test(`a new failing ${kind} with an unrelated unhandled rejection refuses the land`, async t => {
  const { root, write } = fixture(t, true)
  write("packages/a/x.ts", "before\n")
  write("apps/mvp/src/proof.test.ts", 'import { it } from "vitest"; it("passes", () => {})\n')
  for (let i = 0; i < 6; i++) write(`apps/mvp/src/passing-${i}.test.ts`, 'import { it } from "vitest"; it("passes", () => {})\n')
  jj(root, ["commit", "-m", "healthy baseline with enough files for six shards"])
  const base = revision(root, "@-")
  write("apps/mvp/src/new.test.ts", kind === "module" ? `Promise.reject(new Error("independent unhandled rejection"))
throw new Error("new module failure")
` : `import { afterAll, expect, it } from "vitest"
it("${kind === "hook" ? "passes" : "new failure"}", () => expect(1).toBe(${kind === "hook" ? 1 : 2}))
${kind === "hook" ? 'afterAll(() => { throw new Error("new hook failure") })' : ""}
it("unrelated rejection", async () => {
  Promise.reject(new Error("independent unhandled rejection"))
  await new Promise(resolve => setTimeout(resolve, 30))
})
`)
  jj(root, ["describe", "-m", `candidate with a failing ${kind} and unrelated rejection`])
  const installed = dirname(createRequire(join(import.meta.dirname, "../../../apps/mvp/package.json")).resolve("vitest/package.json"))
  let sawBoth = false
  const run = async (tree, request) => {
    assert.equal(request.labels.length, 0)
    const modules = join(tree, "apps/mvp/node_modules")
    mkdirSync(modules, { recursive: true })
    if (!existsSync(join(modules, "vitest"))) symlinkSync(installed, join(modules, "vitest"))
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, "affected-run.mjs"), Buffer.from(JSON.stringify(request)).toString("base64")], { cwd: join(tree, "apps/mvp"), encoding: "utf8" })
    assert.equal(ran.status, 0, ran.stderr)
    const result = JSON.parse(Buffer.from(ran.stdout.match(/^SMITHERS_AFFECTED (\S+)$/m)[1], "base64").toString("utf8"))
    if (result.vitest.failed.some(test => test.file === "src/new.test.ts" && (kind === "assertion" ? test.name === "new failure" : test.name.includes(`new ${kind} failure`)))) {
      assert.match(result.vitest.error, /errors outside any test:[\s\S]*independent unhandled rejection/)
      sawBoth = true
    }
    return result
  }
  let failure
  try { await runAffectedGate(root, { base, run }) } catch (error) { failure = error }
  assert.equal(sawBoth, true)
  assert.equal(failure?.status, "refused")
  assert.ok(failure.regressions.some(name => kind === "assertion" ? name === "apps/mvp/src/new.test.ts > new failure" : name.includes(`new ${kind} failure`)))
})

test("passed receipt on the same diff and main stays passed", async t => {
  const { root, base } = fixture(t)
  const file = await runAffectedGate(root, { run: passing })
  const gate = await requireAffectedReceipt(root, file)
  assert.equal(gate.status, "passed")
  assert.equal(gate.base, base)
})

for (const path of [".smithers/flows", ".smithers/flows/land", ".smithers/flows/land/affected-run.mjs"]) test(`committed runner symlink ${path} writes nothing outside the snapshot`, async t => {
  const { root, directory } = fixture(t), outside = join(directory, "outside"), marker = join(directory, "client-ran")
  mkdirSync(outside)
  const leaf = path.endsWith(".mjs"), destination = leaf ? join(outside, "runner.mjs") : outside
  if (leaf) writeFileSync(destination, "preserve these bytes\n")
  mkdirSync(dirname(join(root, path)), { recursive: true })
  symlinkSync(destination, join(root, path))
  jj(root, ["describe", "-m", "candidate with committed runner symlink"])
  const previous = process.env.SMITHERS_CFBOX, client = join(directory, "client")
  writeFileSync(client, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1)\n`, { mode: 0o755 })
  process.env.SMITHERS_CFBOX = client
  t.after(() => { if (previous === undefined) delete process.env.SMITHERS_CFBOX; else process.env.SMITHERS_CFBOX = previous })
  const receipt = JSON.parse(readFileSync(await runAffectedGate(root, { timeoutMs: 5000 }), "utf8"))
  assert.deepEqual(readdirSync(outside, { recursive: true }), leaf ? ["runner.mjs"] : [])
  if (leaf) assert.equal(readFileSync(destination, "utf8"), "preserve these bytes\n")
  assert.equal(existsSync(marker), false)
  assert.equal(receipt.status, "incomplete")
  assert.equal(receipt.stage, "execution")
  assert.deepEqual(receipt.proven, { targets: 0, files: 0, sharedFailures: 0 })
})

for (const path of [".smithers/flows", ".smithers/flows/land"]) test(`base runner ancestor symlink ${path} writes nothing outside the comparison tree and cleans up`, async t => {
  const { root, directory, write } = fixture(t), outside = join(directory, "outside"), scratch = join(directory, "scratch")
  const destination = join(outside, path.endsWith("/land") ? "affected-run.mjs" : "land/affected-run.mjs")
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, "preserve these bytes\n")
  mkdirSync(dirname(join(root, path)), { recursive: true })
  symlinkSync(outside, join(root, path))
  jj(root, ["commit", "-m", "base with runner ancestor symlink"])
  const base = revision(root, "@-")
  unlinkSync(join(root, path))
  write(".smithers/flows/land/affected-run.mjs", "head runner\n")
  write("packages/a/x.ts", "candidate change\n")
  jj(root, ["describe", "-m", "candidate replaces runner ancestor symlink"])
  const before = readdirSync(outside, { recursive: true }), requests = [], previous = process.env.TMPDIR
  mkdirSync(scratch)
  process.env.TMPDIR = scratch
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous })
  const file = await runAffectedGate(root, { base, run: async (tree, request) => {
    requests.push(tree)
    return { targets: { results: request.labels.map(label => ({ label, status: "failed" })) } }
  } })
  const receipt = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(readFileSync(destination, "utf8"), "preserve these bytes\n")
  assert.deepEqual(readdirSync(outside, { recursive: true }), before)
  assert.equal(requests.length, 1)
  assert.equal(receipt.status, "incomplete")
  assert.equal(receipt.stage, "execution")
  assert.deepEqual(receipt.proven, { targets: 1, files: 0, sharedFailures: 0 })
  assert.deepEqual(readdirSync(scratch), [])
})

test("ordinary comparison tree errors retain completed head counters in the persisted receipt", async t => {
  const { root } = fixture(t, true), requests = []
  const file = await runAffectedGate(root, { run: async (tree, request) => {
    requests.push(request)
    // Removing an unchanged exported file makes baseTree's real lstat fail after head suites finish.
    if (request.labels.length) rmSync(join(tree, "packages/b/x.ts"))
    return {
      targets: { results: request.labels.map(label => ({ label, status: "failed" })) },
      vitest: request.vitest ? { exit: 0, files: ["src/proof.test.ts"], failed: [] } : undefined,
    }
  } })
  const receipt = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(requests.length, 7)
  assert.equal(receipt.status, "incomplete")
  assert.equal(receipt.stage, "execution")
  assert.deepEqual(receipt.proven, { targets: 1, files: 1, sharedFailures: 0 })
  assert.deepEqual((await requireAffectedReceipt(root, file)).proven, receipt.proven)
})

test("receipt refusal and proven regressions block even after main or source moves", async t => {
  const { root, base, advance } = fixture(t)
  const file = await runAffectedGate(root, { run: passing })
  const original = JSON.parse(readFileSync(file, "utf8")), main = advance("a")
  for (const proof of [{ status: "refused" }, { status: "incomplete", regressions: ["new assertion failed"] }]) {
    writeFileSync(file, JSON.stringify({ ...original, ...proof }))
    await assert.rejects(requireAffectedReceipt(root, file, { base: main }), /refused|regression/i)
  }
  assert.notEqual(main, base)
})

test("main advances proceed incomplete even when the affected suites overlap", async t => {
  const { root, advance } = fixture(t)
  const file = await runAffectedGate(root, { run: passing }), main = advance("a")
  const gate = await requireAffectedReceipt(root, file, { base: main })
  assert.equal(gate.status, "incomplete")
  assert.equal(gate.stage, "main-advanced")
})

for (const shared of [false, true]) test(`passed receipt retains completed counts in stale audits (shared failure: ${shared})`, async t => {
  const { root, directory, advance } = fixture(t, true)
  const previous = { inbox: overrideInbox.path, reviews: process.env.SMITHERS_REVIEWS_DIR }
  overrideInbox.path = join(directory, "inbox.md")
  process.env.SMITHERS_REVIEWS_DIR = join(directory, "reviews")
  writeFileSync(overrideInbox.path, "")
  t.after(() => { overrideInbox.path = previous.inbox; if (previous.reviews === undefined) delete process.env.SMITHERS_REVIEWS_DIR; else process.env.SMITHERS_REVIEWS_DIR = previous.reviews })
  const file = await runAffectedGate(root, { run: async (_root, request) => ({
    targets: { results: request.labels.map(label => ({ label, status: shared ? "failed" : "ran" })) },
    vitest: request.vitest ? { exit: 0, files: ["src/proof.test.ts"], failed: [] } : undefined,
  }) })
  const expected = { targets: 1, files: 1, sharedFailures: Number(shared) }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).proven, expected)
  const gate = await requireAffectedReceipt(root, file, { base: advance("b") })
  assert.equal(gate.status, "incomplete")
  assert.equal(gate.stage, "main-advanced")
  assert.deepEqual(gate.proven, expected)
  logLanding(root, revision(root), { reviewed: [], overridden: [], gate })
  const row = JSON.parse(readFileSync(join(process.env.SMITHERS_REVIEWS_DIR, "land-log.jsonl"), "utf8"))
  assert.equal(row.stage, "main-advanced")
  assert.deepEqual(row.proven, expected)
  assert.match(readFileSync(overrideInbox.path, "utf8"), /gate: incomplete, stage=main-advanced/)
})

test("changed content, modes, symlinks and suite membership proceed source-changed", async t => {
  const { root, write } = fixture(t)
  const edits = [
    () => write("packages/a/x.ts", "changed again\n"),
    () => chmodSync(join(root, "packages/a/x.ts"), 0o755),
    () => symlinkSync("x.ts", join(root, "packages/a/link")),
    () => { unlinkSync(join(root, "packages/a/link")); symlinkSync("../b/x.ts", join(root, "packages/a/link")) },
    () => write(".smithers/target-index.json", "[]"),
  ]
  for (const edit of edits) {
    const file = await runAffectedGate(root, { run: passing })
    edit(); jj(root, ["status"])
    const gate = await requireAffectedReceipt(root, file)
    assert.equal(gate.status, "incomplete")
    assert.equal(gate.stage, "source-changed")
  }
})

test("missing, unreadable and malformed receipts proceed receipt-unreadable", async t => {
  const { root } = fixture(t), file = join(root, ".jj/bad-receipt")
  for (const contents of [undefined, "{", "null", "{}", '{"version":1,"status":"passed"}']) {
    if (contents !== undefined) writeFileSync(file, contents)
    const gate = await requireAffectedReceipt(root, file)
    assert.equal(gate.status, "incomplete")
    assert.equal(gate.stage, "receipt-unreadable")
  }
  assert.equal((await requireAffectedReceipt(root, root)).stage, "receipt-unreadable")
})

test("incomplete stages preserve counts and use both existing audit destinations", async t => {
  const { root, directory } = fixture(t)
  const previous = { inbox: overrideInbox.path, reviews: process.env.SMITHERS_REVIEWS_DIR }
  overrideInbox.path = join(directory, "inbox.md")
  process.env.SMITHERS_REVIEWS_DIR = join(directory, "reviews")
  writeFileSync(overrideInbox.path, "")
  t.after(() => { overrideInbox.path = previous.inbox; if (previous.reviews === undefined) delete process.env.SMITHERS_REVIEWS_DIR; else process.env.SMITHERS_REVIEWS_DIR = previous.reviews })
  for (const stage of ["pg-admission", "browser-setup", "suite-completeness", "execution-deadline", "main-advanced", "source-changed", "receipt-unreadable"]) {
    const file = await runAffectedGate(root, { run: async () => { const error = new AffectedIncomplete(stage, "no execution proof"); error.proven = counts; throw error } })
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), proven: counts }))
    const gate = await requireAffectedReceipt(root, file)
    assert.equal(gate.status, "incomplete")
    assert.equal(gate.stage, stage)
    assert.deepEqual(gate.proven, counts)
    logLanding(root, revision(root), { reviewed: [], overridden: [], gate })
    const row = JSON.parse(readFileSync(join(process.env.SMITHERS_REVIEWS_DIR, "land-log.jsonl"), "utf8").trim().split("\n").at(-1))
    assert.equal(row.gate, "incomplete")
    assert.equal(row.stage, stage)
    assert.deepEqual(row.proven, counts)
    assert.match(readFileSync(overrideInbox.path, "utf8").trim().split("\n").at(-1), new RegExp(`gate: incomplete, stage=${stage}`))
  }
})

test("a gate reads only the pinned commit, with no jj operation or workspace change", async t => {
  const { root, write } = fixture(t), head = revision(root)
  write("packages/a/x.ts", "unsnapshotted editor bytes\n")
  const before = operation(root), bytes = readFileSync(join(root, "packages/a/x.ts"))
  const file = await runAffectedGate(root, { run: passing })
  assert.equal(JSON.parse(readFileSync(file, "utf8")).head, head)
  assert.equal((await requireAffectedReceipt(root, file)).status, "passed")
  assert.equal(operation(root), before)
  assert.deepEqual(readFileSync(join(root, "packages/a/x.ts")), bytes)
  assert.equal(revision(root), head)
})

test("a change behind main is tested at its fork point without rebasing", async t => {
  const { root, directory, base } = fixture(t), head = revision(root), remote = join(directory, "remote")
  jj(remote, ["new", "main"])
  writeFileSync(join(remote, "packages/b/x.ts"), "main only\n")
  jj(remote, ["describe", "-m", "main advanced"])
  jj(remote, ["bookmark", "set", "main", "-r", "@"])
  jj(root, ["git", "fetch"])
  const main = revision(root, "main@origin"), before = operation(root)
  const file = await runAffectedGate(root, { run: async (tree, request) => {
    assert.deepEqual(request.labels, ["//packages/a:test"])
    assert.equal(readFileSync(join(tree, "packages/b/x.ts"), "utf8"), "before\n")
    return passing(tree, request)
  } })
  const receipt = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(receipt.base, main)
  assert.notEqual(main, base)
  assert.equal(receipt.head, head)
  assert.equal((await requireAffectedReceipt(root, file)).status, "passed")
  assert.equal(operation(root), before)
})

// Run the real target-index generator in the installed test host. The invoking
// checkout stays source-only; this fixture runs only in the remote land suite.
function landingFixture(t) {
  const f = fixture(t), { root, directory, write } = f
  jj(root, ["bookmark", "track", "main@origin"])
  const lock = join(directory, "landing.lock"), projected = join(directory, "projected.json")
  const cli = join(import.meta.dirname, "../../../packages/smithers/build/build-cli/src/main.ts")
  const runner = join(directory, "mini-run.mjs"), inbox = join(directory, "inbox.md"), reviews = join(directory, "reviews")
  const previous = { mini: process.env.SMITHERS_MINI_RUN, reviews: process.env.SMITHERS_REVIEWS_DIR, inbox: overrideInbox.path }
  process.env.SMITHERS_MINI_RUN = runner
  process.env.SMITHERS_REVIEWS_DIR = reviews
  overrideInbox.path = inbox
  writeFileSync(inbox, "")
  t.after(() => {
    for (const [key, value] of [["SMITHERS_MINI_RUN", previous.mini], ["SMITHERS_REVIEWS_DIR", previous.reviews]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    overrideInbox.path = previous.inbox
  })
  write(".gitignore", "node_modules/\n.flows/\n")
  symlinkSync(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  write(".smithers/WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("landing", {
  repository: "git+https://example.invalid/landing.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime: S.Runtime.Node({ version: ">=26.4.0" }) }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`)
  write("package.json", '{"name":"landing-fixture","private":true}\n')
  write("PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { targetIndex: S.TargetIndex({}) } })
`)
  for (const name of ["a", "b"]) write(`packages/${name}/PACKAGE.ts`, `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { test: S.NodeTest({ runner: S.testRunner([S.file("x.ts")]), srcs: [S.glob("**/*.ts")], deps: [] }) } })
`)
  const generate = () => {
    const result = spawnSync(process.execPath, [cli, "target", "//:targetIndex", "--write"], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "" } })
    assert.equal(result.status, 0, result.stderr + result.stdout)
  }
  generate()
  writeFileSync(runner, `#!${process.execPath}
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
assert.equal(existsSync(${JSON.stringify(lock)}), true, "projection must run under the lease")
for (const args of [["target", "//:targetIndex", "--write"], ["lint", "//:targetIndex"]]) {
  const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...args], { encoding: "utf8", env: { ...process.env, CI: "" } })
  if (result.status !== 0) throw new Error(result.stderr + result.stdout)
}
writeFileSync(${JSON.stringify(projected)}, readFileSync(".smithers/target-index.json"))
console.log("SMITHERS_TARGET_INDEX " + readFileSync(".smithers/target-index.json").toString("base64"))
`, { mode: 0o755 })
  jj(root, ["describe", "-m", "test: candidate"])
  return { ...f, lock, projected, inbox, reviews, generate }
}

function publishRemote(f, path, bytes) {
  const remote = join(f.directory, "remote")
  jj(remote, ["new", "main"])
  mkdirSync(dirname(join(remote, path)), { recursive: true })
  writeFileSync(join(remote, path), bytes)
  jj(remote, ["describe", "-m", "another land"])
  jj(remote, ["bookmark", "set", "main", "-r", "@"])
  return revision(remote, "main")
}

test("a behind-main land syncs and regenerates under the lease after main moves during the gate", async t => {
  const f = landingFixture(t), { root, lock, projected, reviews, inbox } = f
  publishRemote(f, "already-main.txt", "earlier land\n")
  const before = operation(root), head = revision(root), index = readFileSync(join(root, ".smithers/target-index.json"))
  const holder = await acquireLock(lock)
  let held = true
  t.after(async () => { if (held) await holder() })
  let main, receipt, queued
  const admitted = Promise.withResolvers()
  const pending = landWorkspace(root, {
    lockPath: lock, message: "test: behind main", tests: ["true"],
    affectedRun: async (...args) => {
      assert.equal(readdirSync(`${lock}.queue`).filter(name => /^\d+$/.test(name)).length, 1)
      assert.equal(operation(root), before)
      main = publishRemote(f, "during-gate.txt", "concurrent land\n")
      return passing(...args)
    },
    afterAffectedGate: file => {
      receipt = JSON.parse(readFileSync(file, "utf8"))
      assert.equal(receipt.status, "passed")
      assert.equal(operation(root), before)
      assert.equal(existsSync(projected), false)
    },
    lockOptions: { log: line => { if (line.includes("position 2")) { queued = true; admitted.resolve() } } },
  })
  // Attach rejection handling immediately, including failures before queue admission.
  pending.catch(error => admitted.reject(error))
  await admitted.promise
  assert.equal(queued, true)
  assert.equal(operation(root), before)
  assert.equal(revision(root), head)
  assert.deepEqual(readFileSync(join(root, ".smithers/target-index.json")), index)
  assert.equal(readFileSync(join(root, "packages/a/x.ts"), "utf8"), "change\n")
  assert.equal(existsSync(join(root, "already-main.txt")), false)
  assert.equal(existsSync(join(root, "during-gate.txt")), false)
  assert.equal(existsSync(projected), false)
  await holder(); held = false
  const landed = await pending
  assert.ok(landed)
  assert.notEqual(landed, head)
  assert.notEqual(main, receipt.base)
  assert.equal(revision(root, `${main} & ::main@origin`), main)
  assert.equal(readFileSync(join(root, "already-main.txt"), "utf8"), "earlier land\n")
  assert.equal(readFileSync(join(root, "during-gate.txt"), "utf8"), "concurrent land\n")
  assert.equal(readFileSync(join(root, "packages/a/x.ts"), "utf8"), "change\n")
  assert.deepEqual(readFileSync(projected), readFileSync(join(root, ".smithers/target-index.json")))
  const row = JSON.parse(readFileSync(join(reviews, "land-log.jsonl"), "utf8"))
  assert.equal(row.gate, "incomplete")
  assert.equal(row.stage, "main-advanced")
  assert.deepEqual(row.proven, receipt.proven)
  assert.match(readFileSync(inbox, "utf8"), /gate: incomplete, stage=main-advanced/)
  assert.equal(existsSync(lock), false)
})

test("a conflicting rebase stops land under the lease with author bytes intact", async t => {
  const f = landingFixture(t), { root, lock, projected } = f
  const author = "author first\nauthor second\n"
  f.write("packages/a/x.ts", author)
  f.write("author.txt", "unsnapshotted author bytes\n")
  const before = operation(root)
  let head, main
  await assert.rejects(landWorkspace(root, {
    lockPath: lock, message: "test: conflict", tests: ["true"], affectedRun: passing,
    afterAffectedGate: () => {
      assert.equal(operation(root), before)
      main = publishRemote(f, "packages/a/x.ts", "remote first\nremote second\n")
      head = revision(root)
    },
  }), /conflict/i)
  assert.ok(revision(root, "@ & conflicts()"))
  assert.equal(jj(root, ["file", "show", "--ignore-working-copy", "-r", head, "packages/a/x.ts"]), "change")
  const conflicted = readFileSync(join(root, "packages/a/x.ts"), "utf8")
  for (const line of author.trimEnd().split("\n")) assert.ok(conflicted.includes(line), conflicted)
  assert.match(conflicted, /remote first/)
  assert.equal(readFileSync(join(root, "author.txt"), "utf8"), "unsnapshotted author bytes\n")
  assert.equal(revision(root, "main@origin"), main)
  assert.equal(existsSync(projected), false)
  assert.equal(existsSync(lock), false)
})

test("commit entrypoint leaves author bytes and jj operations untouched until FIFO admission", async t => {
  const { root, directory, write } = fixture(t)
  write(".smithers/target-index.json", "[]")
  jj(root, ["bookmark", "set", "main", "-r", "@"])
  write("packages/a/x.ts", "editor bytes\n")
  const before = operation(root), lock = join(directory, "landing.lock")
  mkdirSync(lock); writeFileSync(join(lock, "owner"), "test holder\n")
  const child = spawn(process.execPath, [join(import.meta.dirname, "commit.mjs"), "--push", "--test", "exit 23"], {
    cwd: root, env: { ...process.env, HOME: directory, SMITHERS_LAND_LOCK: lock },
  })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  let stderr = ""
  const queued = Promise.withResolvers(), closed = new Promise(resolve => child.once("close", resolve))
  child.stdout.resume()
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.includes("WAITING landing queue")) queued.resolve() })
  child.once("close", () => queued.reject(new Error(stderr)))
  await queued.promise
  assert.equal(operation(root), before)
  assert.equal(readFileSync(join(root, "packages/a/x.ts"), "utf8"), "editor bytes\n")
  rmSync(lock, { recursive: true })
  assert.equal(await closed, 1, stderr)
  assert.match(stderr, /Test command failed: exit 23/)
  assert.equal(readFileSync(join(root, "packages/a/x.ts"), "utf8"), "editor bytes\n")
})

test("an unexpected gate error proceeds with its stage instead of blocking land", async t => {
  const { root } = fixture(t)
  const file = await runAffectedGate(root, { run: async () => { throw new Error("transport failed") } })
  assert.equal((await requireAffectedReceipt(root, file)).status, "incomplete")
})

test("a proven target regression still refuses before FIFO admission", async t => {
  const { root } = fixture(t)
  let calls = 0
  await assert.rejects(runAffectedGate(root, { run: async (_, request) => ({ targets: { results: request.labels.map(label => ({ label, status: ++calls === 1 ? "failed" : "ran" })) }, client: "pg" }) }), error => error.status === "refused" && error.regressions.includes("//packages/a:test (failed target)"))
  assert.equal(existsSync(join(root, ".jj/affected-receipts")), false)
})

test("the whole gate deadline proceeds incomplete", async t => {
  const { root } = fixture(t), start = Date.now()
  const file = await runAffectedGate(root, { timeoutMs: 1000, run: async (_, request, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  } })
  assert.equal((await requireAffectedReceipt(root, file)).stage, "execution-deadline")
  assert.ok(Date.now() - start < 3000)
})

test("unwritable receipt storage proceeds without a persisted receipt", async t => {
  const { root } = fixture(t)
  writeFileSync(join(root, ".jj/affected-receipts"), "not a directory")
  const file = await runAffectedGate(root, { run: passing })
  assert.equal(file, undefined)
  assert.equal((await requireAffectedReceipt(root, file)).stage, "receipt-unreadable")
})

function divergentMain(t) {
  const f = fixture(t), remote = join(f.directory, "remote")
  f.write(".smithers/target-index.json", "[]")
  jj(f.root, ["status"])
  jj(remote, ["new", "main"])
  writeFileSync(join(remote, "packages/b/upstream.txt"), "preserve upstream\n")
  jj(remote, ["describe", "-m", "divergent remote main"])
  jj(remote, ["bookmark", "set", "main", "-r", "@"])
  jj(f.root, ["git", "fetch"])
  jj(f.root, ["bookmark", "set", "main", "-r", "@"])
  return { ...f, remote, main: revision(f.root, "main@origin") }
}

test("workspace publication preserves remote main that advances after leased validation", async t => {
  const f = landingFixture(t), { root, directory } = f
  let main
  await assert.rejects(landWorkspace(root, {
    lockPath: f.lock, message: "test: preserve remote", affectedRun: passing,
    tests: [`${JSON.stringify(process.execPath)} ${JSON.stringify(join(directory, "advance.mjs"))}`],
    afterAffectedGate: () => {
      writeFileSync(join(directory, "advance.mjs"), `import { jj } from ${JSON.stringify(new URL("./numbering.mjs", import.meta.url).href)}
import { writeFileSync } from "node:fs"
const remote = ${JSON.stringify(join(directory, "remote"))}
jj(remote, ["new", "main"])
writeFileSync(remote + "/upstream.txt", "preserve upstream\\n")
jj(remote, ["describe", "-m", "concurrent publication"])
jj(remote, ["bookmark", "set", "main", "-r", "@"])
`)
    },
  }), /Main advanced during validation/)
  main = revision(join(directory, "remote"), "main")
  assert.equal(revision(root, "main@origin"), main)
  assert.equal(jj(join(directory, "remote"), ["file", "show", "--ignore-working-copy", "-r", "main", "upstream.txt"]), "preserve upstream")
})

test("commit entrypoint preserves divergent remote main after gating at the fork", t => {
  const { root, directory, remote, main } = divergentMain(t)
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "commit.mjs"), "--push", "--test", "exit 23"], {
    cwd: root, encoding: "utf8", timeout: 20000,
    env: { ...process.env, HOME: directory, SMITHERS_LAND_LOCK: join(directory, "landing.lock") },
  })
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr, /AFFECTED gate: passed/)
  assert.match(result.stderr, /Remote main.*ancestor/)
  assert.doesNotMatch(result.stderr, /Test command failed/)
  jj(remote, ["git", "import", "--ignore-working-copy"])
  assert.equal(revision(remote, "main"), main)
})
