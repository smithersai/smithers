import { strict as assert } from "node:assert"
import { test } from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { dirname, join, basename } from "node:path"
import * as gate from "./affected.mjs"

const row = (label, kinds = ["test"], inputs = [], dependencies = []) => ({ label, package: label.slice(2, label.indexOf(":")), kinds, inputs, dependencies })
const index = [
  row("//:index", ["build"], [{ kind: "file", path: ".smithers/target-index.json" }]),
  row("//packages/cli:lib", ["build"], [{ kind: "file", path: "packages/cli/src/main.ts" }]),
  row("//packages/cli:test", ["test"], [], ["//packages/cli:lib"]),
  row("//apps/mvp:rules", ["test"], [{ kind: "glob", pattern: "apps/mvp/**/*.ts" }])
]
index.push({ ...row("//packages/repo-targets:repositoryInputs_root", [], [{ kind: "glob", pattern: "**/*" }]), rule: "Filegroup" })
index.find((row) => row.label === "//packages/cli:test").dependencies.push("//packages/repo-targets:repositoryInputs_root")
const files = {
  ".smithers/target-index.json": JSON.stringify(index),
  "packages/cli/package.json": '{"name":"cli"}',
  "packages/cli/src/main.ts": "export const main = 1",
  "packages/other/package.json": '{"name":"other"}',
  "packages/other/src/main.ts": "export const other = 1",
  "apps/mvp/package.json": '{"name":"app","dependencies":{"cli":"workspace:*"}}',
  "apps/mvp/vitest.config.ts": 'export default {test:{include:["src/**/*.test.ts"]}}',
  "apps/mvp/src/a.test.ts": "// test fixture",
  "apps/mvp/src/main.ts": "export const main = 1",
  "apps/mvp/docs/work/a.md": "notes"
}
function source(changed) {
  return { base: "parent", changed: () => changed, files: () => Object.keys(files), read: (path) => files[path],
    baseEntries: () => new Map(Object.keys(files).map((path) => [path, {}])),
    baseBytes: (path) => Buffer.from(files[path]),
    materialize: (root) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) } }
  }
}
const passing = (request) => ({ client: "pg", targets: { results: request.labels.map((label) => ({ label, status: "ran" })) },
  vitest: request.vitest ? { exit: 0, files: request.vitestFiles ?? ["src/a.test.ts"], failed: [] } : undefined })
const base = (options) => basename(options.source).startsWith("smithers-affected-base-")

test("policy: index-only and prose-only edits do not reach executable package tests", () => {
  for (const changed of [[".smithers/target-index.json"], ["apps/mvp/docs/work/a.md"], ["packages/cli/README.md"]]) {
    const plan = gate.affectedPlan("unused", source(changed))
    assert.deepEqual([plan.labels, plan.reachesMvp, plan.vitestFiles], [[], false, []], changed.join())
  }
  assert.equal(gate.affectedPlan("unused", source(["packages/cli/src/main.ts"])).reachesMvp, true)
  assert.deepEqual(gate.affectedTargets(index, ["packages/cli/src/main.ts"]), ["//packages/cli:test"])
})

test("policy: repository export inventory does not make app source execute CLI tests", () => {
  const inventory = { ...row("//packages/repo-targets:repositoryInputs_root", [], [{ kind: "glob", pattern: "**/*" }]), rule: "Filegroup" }
  const targets = [inventory, row("//packages/cli:test", ["test"], [{ kind: "glob", pattern: "packages/cli/**/*.ts" }], [inventory.label])]
  assert.deepEqual(gate.affectedTargets(targets, ["apps/mvp/src/main.ts"]), [])
  assert.deepEqual(gate.affectedTargets(targets, ["packages/cli/src/main.ts"]), ["//packages/cli:test"])
})

test("policy: app documentation and index readers do not expand into the full Vitest suite", () => {
  for (const path of ["apps/mvp/docs/work/a.md", ".smithers/target-index.json"]) {
    const input = source([path]), read = input.read
    input.read = (name) => name === ".smithers/target-index.json" ? JSON.stringify([row("//apps/mvp:reader", ["test"], [{ kind: "file", path }])]) : read(name)
    const plan = gate.affectedPlan("unused", input)
    assert.deepEqual([plan.labels, plan.reachesMvp, plan.vitestFiles], [["//apps/mvp:reader"], false, []])
  }
  assert.deepEqual(gate.affectedPlan("unused", source(["patches/README.md"])).labels, [])
})

test("policy: unrelated executable edits cannot promote documentation readers to app reach", () => {
  for (const path of ["apps/mvp/docs/work/a.md", ".smithers/target-index.json"]) {
    const input = source([path, "packages/other/src/main.ts"]), read = input.read
    input.read = (name) => name === ".smithers/target-index.json" ? JSON.stringify([
      row("//apps/mvp:reader", ["test"], [{ kind: "file", path }]),
      row("//packages/other:test", ["test"], [{ kind: "glob", pattern: "packages/other/**/*.ts" }])
    ]) : read(name)
    const plan = gate.affectedPlan("unused", input)
    assert.deepEqual([plan.labels, plan.reachesMvp, plan.vitestFiles], [["//apps/mvp:reader", "//packages/other:test"], false, []])
  }
})

test("policy: Markdown fixtures remain executable inputs while documentation stays scoped", () => {
  for (const path of ["packages/cli/test/fixtures/SKILL.md", "packages/cli/test/fixtures/README.md", "packages/cli/test/fixtures/docs/body.md", "packages/cli/test/fixtures/input.txt", "packages/cli/templates/body.rst"]) {
    const plan = gate.affectedPlan("unused", source([path]))
    assert.ok(plan.labels.includes("//packages/cli:test"), path)
    assert.equal(plan.reachesMvp, true)
  }
  assert.deepEqual(gate.affectedPlan("unused", source(["packages/cli/README.md"])).labels, [])
})

test("policy: cancellation before dispatch reaches neither injected nor farm work", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-pre-dispatch-")), marker = join(directory, "started"), client = join(directory, "cfbox")
  const previous = { box: process.env.SMITHERS_CFBOX, lock: process.env.SMITHERS_AFFECTED_LOCK }
  process.env.SMITHERS_CFBOX = client; process.env.SMITHERS_AFFECTED_LOCK = join(directory, "pg.lock")
  t.after(() => { for (const [key, value] of [["SMITHERS_CFBOX", previous.box], ["SMITHERS_AFFECTED_LOCK", previous.lock]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(client, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');process.exit(125);\n`, { mode: 0o755 })
  let dispatched = 0
  const canceled = new AbortController(); canceled.abort(new Error("before dispatch"))
  await gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), signal: canceled.signal, run: async (_, request) => { dispatched++; return passing(request) } }).catch(() => {})
  const duringExport = new AbortController(), input = source(["apps/mvp/src/main.ts"]), materialize = input.materialize
  input.materialize = (root) => { materialize(root); duringExport.abort(new Error("during export")) }
  await gate.affectedTests("unused", { source: input, signal: duringExport.signal }).catch(() => {})
  assert.deepEqual([dispatched, existsSync(marker)], [0, false])
})

test("policy: cancellation after head completion never dispatches parent work", async () => {
  const controller = new AbortController()
  let heads = 0, parents = 0
  const run = async (_, request, options) => {
    if (base(options)) parents++
    else if (++heads === gate.vitestShards + 1) queueMicrotask(() => controller.abort(new Error("before parent")))
    const result = passing(request)
    if (result.vitest) result.vitest.failed = [{ file: "src/a.test.ts", name: "existing failure" }]
    return result
  }
  await gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), signal: controller.signal, run }).catch(() => {})
  assert.equal(parents, 0)
})

test("policy: parent build dependencies use build and keep the same host", async () => {
  let reran = false
  await gate.affectedTests("unused", { source: source(["packages/cli/src/main.ts"]), run: async (_, request, options) => {
    const result = passing(request)
    if (!request.labels.length) return result
    if (base(options)) {
      reran = true
      assert.equal(request.verb, "build")
      assert.deepEqual(request.labels, ["//packages/cli:lib"])
      assert.deepEqual(options.clients, ["pg"])
    }
    result.targets.results.push({ label: "//packages/cli:lib", status: "failed" })
    return result
  } })
  assert.equal(reran, true)
})

test("policy: unchanged zero-test files are reported; touched or newly zero files block", async () => {
  for (const [touched, parentZero] of [[false, true], [true, true], [false, false]]) {
    const run = async (_, request, options) => {
      const result = passing(request)
      if (result.vitest && (!base(options) || parentZero)) result.vitest.failed = [{ file: "src/a.test.ts", name: "(ran no tests)", unexcused: true }]
      return result
    }
    const promise = gate.affectedTests("unused", { source: source([touched ? "apps/mvp/src/a.test.ts" : "apps/mvp/src/main.ts"]), run })
    if (touched || !parentZero) await assert.rejects(promise, /ran no tests/)
    else assert.deepEqual((await promise).unchangedZeroTestFiles, ["apps/mvp/src/a.test.ts"])
  }
})

test("policy: infrastructure is incomplete with a stage and retry, never a test verdict", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-infrastructure-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const client = join(directory, "client")
  for (const [stage, message, code] of [["pg-admission", "no pg 4-vCPU box became free", 125], ["integration-services", "[lat-run] integration-service setup", 5], ["global-setup", "CLI-pack global setup EACCES", 1]]) {
    writeFileSync(client, `#!/bin/sh\necho '${message}'\nexit ${code}\n`, { mode: 0o755 })
    await assert.rejects(gate.onFarm(directory, { labels: [], vitest: true }, { clients: [client] }), (error) => {
      assert.equal(error.status, "incomplete")
      assert.equal(error.stage, stage)
      assert.match(error.message, /INCOMPLETE/)
      assert.match(error.retry, /retry|rerun/i)
      assert.doesNotMatch(error.message, /REFUSED|change fails|land refuses/)
      return true
    })
  }
})

test("policy: two gates queue; each holds at most seven pg jobs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-admission-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "pg.lock"), events = []
  let release, entered
  const ready = new Promise((resolve) => { entered = resolve })
  const first = gate.withPgAdmission(async () => { events.push("first"); entered(); await new Promise((resolve) => { release = resolve }) }, { path })
  await ready
  const second = gate.withPgAdmission(async () => { events.push("second") }, { path })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(events, ["first"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ["first", "second"])
  const jobs = Array.from({ length: 19 }, (_, i) => i)
  const batches = gate.pgBatches(jobs)
  assert.deepEqual(batches.flat(), jobs)
  assert.ok(batches.every((batch) => batch.length <= 7))
})

test("policy: a gate ending incomplete releases admission immediately and preserves its stage", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-stage-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "pg.lock")
  writeFileSync(path, "unavailable")
  await assert.rejects(gate.withPgAdmission(() => assert.fail("must not enter"), { path }), (error) => error.status === "incomplete" && error.stage === "pg-admission")
  rmSync(path)
  const client = join(directory, "client")
  writeFileSync(client, "#!/bin/sh\necho 'no pg 4-vCPU box became free'\nexit 125\n", { mode: 0o755 })
  await assert.rejects(gate.withPgAdmission(() => gate.onFarm(directory, { labels: [], vitest: true }, { clients: [client] }), { path }), (error) => {
    assert.equal(error.stage, "pg-admission")
    assert.equal(error.status, "incomplete")
    assert.doesNotMatch(error.message, /admission retained/)
    assert.equal(existsSync(path), false)
    return true
  })
  const ticket = join(`${path}.queue`, "0000000000000001")
  const record = JSON.parse(readFileSync(join(ticket, "external-work.json"), "utf8"))
  assert.equal(record.clients[0].state, "stopped")
  assert.ok(existsSync(join(ticket, "external-work-stopped")))
  let entered = false
  await gate.withPgAdmission(() => { entered = true }, { path, timeoutMs: 1000 })
  assert.equal(entered, true)
})

test("policy: pg work has no mini fallback", () => {
  assert.equal(gate.affectedHosts().some((host) => host.kind === "mini"), false)
  assert.ok(gate.affectedHosts().some((host) => host.box))
})

test("policy: interruption before client launch cannot strand admission", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-prelaunch-stop-")), path = join(directory, "pg.lock")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  controller.abort(new Error("fixture before launch"))
  await assert.rejects(gate.withPgAdmission(() => gate.onFarm(directory, { labels: [] }, {
    clients: ["/nonexistent-fixture-client"], signal: controller.signal
  }), { path }), /fixture before launch/)
  assert.equal(existsSync(path), false)
  await gate.withPgAdmission(() => {}, { path, timeoutMs: 1000 })
})

test("policy: proven capacity non-launch releases admission for the next gate", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-capacity-")), path = join(directory, "pg.lock"), client = join(directory, "cfbox")
  const previous = process.env.SMITHERS_CFBOX
  process.env.SMITHERS_CFBOX = client
  t.after(() => { if (previous === undefined) delete process.env.SMITHERS_CFBOX; else process.env.SMITHERS_CFBOX = previous; rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(client, "#!/bin/sh\necho 'cfbox: no pg 4-vCPU box became free in 1s (CFBOX_WAIT_MAX=1): capacity exhausted'\nexit 125\n", { mode: 0o755 })
  await assert.rejects(gate.withPgAdmission(() => gate.onFarm(directory, { labels: [], vitest: true }, { clients: [client] }), { path }), (error) => error.stage === "pg-admission")
  assert.equal(existsSync(path), false, "a proven non-launch cannot strand admission")
  const receipt = Buffer.from(JSON.stringify({ targets: { results: [] } })).toString("base64")
  writeFileSync(client, `#!/bin/sh\necho 'SMITHERS_AFFECTED ${receipt}'\n`, { mode: 0o755 })
  await gate.withPgAdmission(() => gate.onFarm(directory, { labels: [], vitest: false }, { clients: [client] }), { path })
  assert.equal(existsSync(path), false, "normal completion also releases admission")
  writeFileSync(client, "#!/bin/sh\necho 'cfbox: exit 4; command 1s, wall 1s'\nexit 4\n", { mode: 0o755 })
  await assert.rejects(gate.withPgAdmission(() => gate.onFarm(directory, { labels: [], vitest: true }, { clients: [client] }), { path }), (error) => error.stage === "dependency-install")
  assert.equal(existsSync(path), false, "a failed single-box command has still terminated")
})

test("policy: an interrupted gate releases admission after its client exits, retaining recovery metadata", { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-handled-signal-")), path = join(directory, "pg.lock"), client = join(directory, "client"), ready = join(directory, "ready")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(client, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>process.exit(0));console.log('[lat-run] fixture-host slot 3\\ncfbox: [1] box deadbeef (pg, 4 vCPU) started in 1s\\nTOKEN=must-not-be-recorded');writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);\n`, { mode: 0o755 })
  const controller = new AbortController()
  const running = gate.withPgAdmission(() => gate.onFarm(directory, { labels: [], vitest: true }, { clients: [client], signal: controller.signal }), { path, signal: controller.signal })
  const rejected = assert.rejects(running, /fixture cancellation/)
  while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error("fixture cancellation"))
  await rejected
  assert.equal(existsSync(path), false)
  const ticket = readdirSync(`${path}.queue`).find((name) => existsSync(join(`${path}.queue`, name, "external-work.json")))
  const record = JSON.parse(readFileSync(join(`${path}.queue`, ticket, "external-work.json")))
  assert.equal(record.clients[0].state, "stopped")
  assert.equal(typeof record.clients[0].startTime, "string")
  assert.ok(existsSync(join(`${path}.queue`, ticket, "external-work-stopped")))
  assert.deepEqual(record.clients[0].recovery.boxes, [{ job: 1, idPrefix: "deadbeef", image: "pg", cpu: 4 }])
  assert.deepEqual(record.clients[0].recovery.servers, [{ host: "fixture-host", slot: 3 }])
  assert.ok(!JSON.stringify(record).includes("must-not-be-recorded"))
  assert.equal(existsSync(record.clients[0].log), false, "recovery metadata survives temporary log cleanup")
  let entered = false
  await gate.withPgAdmission(() => { entered = true }, { path, timeoutMs: 1000 })
  assert.equal(entered, true)
})

test("policy: a missing browser executable is infrastructure even with a file receipt", () => {
  assert.throws(() => gate.assertComplete({ labels: [], vitestFiles: ["a.test.ts"], reachesMvp: true }, {
    targets: { results: [] }, vitest: { exit: 1, files: ["a.test.ts"], failed: [{ file: "a.test.ts", name: "(the file failed: ec99ea6eb85671ca) browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium" }] }
  }), (error) => error.status === "incomplete" && error.stage === "browser-setup" && /Retry/.test(error.retry))
})

test("policy: scoped documentation readers remain selected", () => {
  const target = row("//apps/site:supportMatrixTest", ["test"], [{ kind: "glob", pattern: "apps/site/docs/**/*" }])
  assert.deepEqual(gate.affectedTargets([target], ["apps/site/docs/reference/support-matrix.md"]), [target.label])
})

test("policy: cancellation keeps pg admission until client cleanup settles", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-cancellation-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "pg.lock"), controller = new AbortController()
  let entered, shutdown, secondEntered = false
  const ready = new Promise((resolve) => { entered = resolve })
  const first = gate.withPgAdmission(async () => { entered(); await new Promise((resolve) => { shutdown = resolve }) }, { path, signal: controller.signal })
  await ready
  const second = gate.withPgAdmission(async () => { secondEntered = true }, { path })
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 350))
  const enteredBeforeShutdown = secondEntered
  shutdown()
  await Promise.all([first, second])
  assert.equal(enteredBeforeShutdown, false)
  assert.equal(secondEntered, true)
})

test("policy: malformed farm receipts are incomplete rather than change failures", () => {
  for (const result of [undefined, {}, { targets: {} }, { targets: { results: [] }, vitest: {} }, { targets: { results: [] }, vitest: { exit: 0, files: [], failed: [{ file: "a", name: "(ran no tests)", unexcused: "true" }] } }]) {
    assert.throws(() => gate.assertComplete({ labels: [], reachesMvp: true, vitestFiles: [] }, result), (error) => error.status === "incomplete")
  }
  assert.throws(() => gate.readBoxReceipts("[1] SMITHERS_AFFECTED ewo=\n", new Set(), () => {}), (error) => error.status === "incomplete")
})

test("policy: all successful job records still need successful client completion", () => {
  const receipt = Buffer.from(JSON.stringify({ targets: { results: [] } })).toString("base64")
  const output = `[1] SMITHERS_AFFECTED ${receipt}\ncfbox: [1] exit 0; command 1.0s, wall 1.0s\n`
  assert.equal(gate.boxOutcomes(output, 0, 1)[0].status, 0)
  for (const exit of [137, 255, null]) assert.notEqual(gate.boxOutcomes(output, exit, 1)[0].status, 0)
})

test("policy: live owner and client hold admission; a killed owner is reclaimed once its client dies", { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-owner-death-")), path = join(directory, "pg.lock")
  const client = join(directory, "client"), ready = join(directory, "ready")
  writeFileSync(client, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)\n`, { mode: 0o755 })
  const module = new URL("./affected.mjs", import.meta.url).href
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { withPgAdmission, onFarm } from ${JSON.stringify(module)}; await withPgAdmission(() => onFarm(${JSON.stringify(directory)}, { labels: [], vitest: true }, { clients: [${JSON.stringify(client)}] }), { path: ${JSON.stringify(path)} })`], { stdio: "ignore" })
  let clientPid, second
  const controller = new AbortController()
  t.after(async () => {
    holder.kill("SIGKILL")
    if (clientPid) try { process.kill(-clientPid, "SIGKILL") } catch {}
    controller.abort()
    await second?.catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  for (let i = 0; !existsSync(ready) && i < 300; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(existsSync(ready))
  const ticket = join(`${path}.queue`, "0000000000000001")
  for (let i = 0; !clientPid && i < 300; i++) {
    clientPid = JSON.parse(readFileSync(join(ticket, "external-work.json"), "utf8")).clients[0].pid
    if (!clientPid) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(Number.isSafeInteger(clientPid), "client PID must be durably recorded")
  let entered = false
  second = gate.withPgAdmission(async () => { entered = true }, { path, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(entered, false, "a live owner with a live client must retain admission")
  const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited
  await new Promise((resolve) => setTimeout(resolve, 350))
  const enteredWhileAlive = entered
  process.kill(-clientPid, 0) // The original real client group is still alive.
  process.kill(-clientPid, "SIGKILL")
  let stopped = false
  for (let i = 0; i < 100; i++) {
    try { process.kill(-clientPid, 0) } catch (error) { if (error.code === "ESRCH") { stopped = true; break } }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(stopped, "the fixture must confirm client termination")
  await second
  assert.equal(enteredWhileAlive, false)
  assert.equal(entered, true)
  const proof = JSON.parse(readFileSync(join(ticket, "external-work-stopped"), "utf8"))
  assert.equal(proof.proof, "local-owner-and-clients-exited")
})


test("policy: a second pg gate ends incomplete within its wait bound without launching", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gate-bounded-wait-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "pg.lock")
  let unlock, ready
  const entered = new Promise(resolve => { ready = resolve })
  const first = gate.withPgAdmission(async () => { ready(); await new Promise(resolve => { unlock = resolve }) }, { path })
  await entered
  let launched = false
  try {
    await assert.rejects(gate.withPgAdmission(() => { launched = true }, { path, timeoutMs: 100 }), error => error.status === "incomplete" && error.stage === "pg-admission")
    assert.equal(launched, false)
  } finally { unlock(); await first }
})

test("policy: a proven regression refuses even when another suite is incomplete", async () => {
  const run = async (_, request, options) => {
    const result = passing(request)
    if (!base(options) && !request.vitest) result.targets.results.forEach(row => { row.status = "failed" })
    if (request.vitest) result.vitest.files = []
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), run }), error => error.status === "refused" && error.regressions.includes("//apps/mvp:rules (failed target)"))
})

test("policy: completed parent proof still refuses when another parent comparison is incomplete", async () => {
  const run = async (_, request, options) => {
    const result = passing(request)
    if (!base(options)) {
      result.client = request.vitest ? "app" : "targets"
      if (request.vitest) result.vitest.failed = [{ file: "src/a.test.ts", name: "needs comparison" }]
      else result.targets.results.forEach(row => { row.status = "failed" })
      return result
    }
    if (request.vitest) {
      await new Promise(resolve => setImmediate(resolve))
      throw new gate.AffectedIncomplete("parent-suite-completeness", "the other parent request did not finish")
    }
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), run }), error => error.status === "refused" && error.regressions.includes("//apps/mvp:rules (failed target)"))
})

test("policy: the wall bound returns incomplete even if a runner ignores cancellation", async (t) => {
  const snapshots = new Set(), started = Date.now()
  t.after(() => { for (const path of snapshots) rmSync(path, { recursive: true, force: true }) })
  await assert.rejects(gate.affectedTests("unused", {
    source: source(["apps/mvp/src/main.ts"]), timeoutMs: 100,
    run: async (root) => { snapshots.add(root); await new Promise(() => {}) },
  }), error => error.status === "incomplete" && error.stage === "execution-deadline")
  assert.ok(Date.now() - started < 1000)
})

test("policy: a completed new target blocks despite an incomplete head sibling", async () => {
  const input = source(["apps/mvp/src/main.ts", ".smithers/target-index.json"]), bytes = input.baseBytes
  input.baseBytes = path => path === ".smithers/target-index.json" ? Buffer.from("[]") : bytes(path)
  const run = async (_, request) => {
    if (request.vitest) { await new Promise(resolve => setImmediate(resolve)); throw new gate.AffectedIncomplete("vitest-execution", "head sibling failed setup") }
    const result = passing(request); result.targets.results.forEach(row => { row.status = "failed" }); return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: input, run }), error => error.status === "refused" && error.regressions.includes("//apps/mvp:rules (failed target)"))
})

test("policy: incomplete head siblings retain completed proof counts", async () => {
  const run = async (_, request) => {
    if (request.vitest) { await new Promise(resolve => setImmediate(resolve)); throw new gate.AffectedIncomplete("vitest-execution", "head sibling failed setup") }
    return passing(request)
  }
  await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), run }), error => error.status === "incomplete" && error.proven.targets === 1 && error.proven.files === 0)
})

for (const [name, contents] of [["unparseable", "{"], ["non-array", "{}"], ["null", "null"], ["invalid row", "[null]"], ["missing label", "[{}]"]]) test(`policy: ${name} base index ends incomplete with completed head counters`, async () => {
  const input = source(["apps/mvp/src/main.ts", ".smithers/target-index.json"]), bytes = input.baseBytes
  input.baseBytes = path => path === ".smithers/target-index.json" ? Buffer.from(contents) : bytes(path)
  let heads = 0, parents = 0, snapshot
  const run = async (_, request, options) => {
    if (base(options)) parents++
    else { heads++; snapshot = options.source }
    const result = passing(request)
    result.targets.results.forEach(row => { row.status = "failed" })
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: input, run }), error => {
    assert.equal(error.status, "incomplete")
    assert.equal(error.stage, "parent-target-index")
    assert.deepEqual(error.proven, { targets: 1, files: 1, sharedFailures: 0 })
    assert.match(error.message, /target-index\.json/)
    return true
  })
  assert.equal(heads, gate.vitestShards + 1)
  assert.equal(parents, 0)
  assert.equal(existsSync(snapshot), false)
})

test("policy: an incomplete audit refuses if land-log cannot be written", async (t) => {
  const { logLanding, overrideInbox } = await import("./review.mjs")
  const directory = mkdtempSync(join(tmpdir(), "gate-audit-")), previous = { inbox: overrideInbox.path, reviews: process.env.SMITHERS_REVIEWS_DIR }
  t.after(() => { overrideInbox.path = previous.inbox; if (previous.reviews === undefined) delete process.env.SMITHERS_REVIEWS_DIR; else process.env.SMITHERS_REVIEWS_DIR = previous.reviews; rmSync(directory, { recursive: true, force: true }) })
  overrideInbox.path = join(directory, "inbox"); writeFileSync(overrideInbox.path, "")
  process.env.SMITHERS_REVIEWS_DIR = join(directory, "not-a-directory"); writeFileSync(process.env.SMITHERS_REVIEWS_DIR, "occupied")
  assert.throws(() => logLanding(directory, "tip", { reviewed: [], overridden: [], gate: { status: "incomplete", stage: "pg-admission", proven: { targets: 0, files: 0, sharedFailures: 0 } } }), /incomplete.*audit/i)
  assert.match(readFileSync(overrideInbox.path, "utf8"), /gate: incomplete, stage=pg-admission/)
})

test("policy: completed Latitude failure survives an incomplete cfbox batch", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "head-farm-proof-")), marker = join(directory, "latitude-ended")
  const keys = ["SMITHERS_LAT_RUN", "SMITHERS_CFBOX", "SMITHERS_AFFECTED_LOCK"], previous = keys.map(key => process.env[key])
  t.after(() => { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }); rmSync(directory, { recursive: true, force: true }) })
  process.env.SMITHERS_LAT_RUN = join(directory, "latitude")
  process.env.SMITHERS_CFBOX = join(directory, "cfbox")
  process.env.SMITHERS_AFFECTED_LOCK = join(directory, "pg.lock")
  writeFileSync(process.env.SMITHERS_LAT_RUN, `#!${process.execPath}\nconst fs=require('node:fs'),r=JSON.parse(Buffer.from(process.argv.at(-1),'base64'));console.error('[lat-run] test-host slot 1');console.log('SMITHERS_AFFECTED '+Buffer.from(JSON.stringify({targets:{results:r.labels.map(label=>({label,status:'failed'}))}})).toString('base64'));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'ended'),30);\n`, { mode: 0o755 })
  writeFileSync(process.env.SMITHERS_CFBOX, `#!${process.execPath}\nconst fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);setTimeout(()=>{console.error('cfbox: [1] no pg 4-vCPU box became free (CFBOX_WAIT_MAX=1)');process.exit(125)},100)}},10);\n`, { mode: 0o755 })
  const input = source(["apps/mvp/src/main.ts", ".smithers/target-index.json"]), read = input.read, bytes = input.baseBytes
  const rows = JSON.parse(read(".smithers/target-index.json")); rows.find(row => row.label === "//apps/mvp:rules").rule = "Docker.Test"
  input.read = path => path === ".smithers/target-index.json" ? JSON.stringify(rows) : read(path)
  input.baseBytes = path => path === ".smithers/target-index.json" ? Buffer.from("[]") : bytes(path)
  await assert.rejects(gate.affectedTests(directory, { source: input }), error => error.status === "refused" && error.regressions.includes("//apps/mvp:rules (failed target)"))
  assert.equal(existsSync(marker), true)
})

test("policy: proven failures win the wall bound when a head or parent sibling ignores cancellation", async (t) => {
  const snapshots = new Set()
  t.after(() => { for (const path of snapshots) rmSync(path, { recursive: true, force: true }) })
  for (const atParent of [false, true]) {
    const input = source(["apps/mvp/src/main.ts", ".smithers/target-index.json"]), bytes = input.baseBytes
    if (!atParent) input.baseBytes = path => path === ".smithers/target-index.json" ? Buffer.from("[]") : bytes(path)
    const run = async (root, request, options) => {
      snapshots.add(root)
      if (request.vitest && (!atParent || base(options))) await new Promise(() => {})
      const result = passing(request)
      result.client = request.vitest ? "app" : "targets"
      if (!base(options)) {
        if (request.vitest) result.vitest.failed = [{ file: "src/a.test.ts", name: "needs parent" }]
        else result.targets.results.forEach(row => { row.status = "failed" })
      }
      return result
    }
    await assert.rejects(gate.affectedTests("unused", { source: input, run, timeoutMs: 200 }), error => error.status === "refused" && error.regressions.includes("//apps/mvp:rules (failed target)"))
  }
})

function withSecondFile(input) {
  const path = "apps/mvp/src/b.test.ts", read = input.read, files = input.files, bytes = input.baseBytes, entries = input.baseEntries, materialize = input.materialize
  input.files = () => [...files(), path]
  input.read = name => name === path ? "// second test" : read(name)
  input.baseBytes = name => name === path ? Buffer.from("// second test") : bytes(name)
  input.baseEntries = () => new Map([...entries(), [path, {}]])
  input.materialize = root => { materialize(root); writeFileSync(join(root, path), "// second test") }
  return input
}

for (const shared of [false, true]) test(`policy: parent browser setup preserves ${shared ? "shared failure counts" : "another file's passing proof"}`, async () => {
  const input = withSecondFile(source(["apps/mvp/src/main.ts"]))
  const failedA = { file: "src/a.test.ts", name: "A" }, failedB = { file: "src/b.test.ts", name: "B" }
  const run = async (_, request, options) => {
    const result = passing(request); result.client = "pg"
    if (request.vitest) result.vitest = base(options)
      ? { exit: 1, files: ["src/a.test.ts", "src/b.test.ts"], failed: [...shared ? [failedA] : [], { file: "src/b.test.ts", name: "(the file failed: abcd1234) browserType.launch: Executable doesn't exist" }] }
      : { exit: 1, files: request.shard === "1/6" ? ["src/a.test.ts", "src/b.test.ts"] : [], failed: request.shard === "1/6" ? [failedA, failedB] : [] }
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: input, run }), error => shared
    ? error.status === "incomplete" && error.stage === "browser-setup" && error.proven.sharedFailures === 1
    : error.status === "refused" && error.regressions.includes("apps/mvp/src/a.test.ts > A"))
})

test("policy: a completed shared parent failure survives an incomplete parent sibling", async () => {
  const run = async (_, request, options) => {
    const result = passing(request); result.client = request.vitest ? "app" : "targets"
    if (base(options) && request.vitest) { await new Promise(resolve => setImmediate(resolve)); throw new gate.AffectedIncomplete("vitest-execution", "parent sibling incomplete") }
    if (request.vitest) result.vitest.failed = [{ file: "src/a.test.ts", name: "A" }]
    else result.targets.results.forEach(row => { row.status = "failed" })
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), run }), error => error.status === "incomplete" && error.proven.sharedFailures === 1)
})

test("policy: every completed cfbox outcome is inspected after an earlier incomplete, missing, or malformed receipt", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "batch-proof-")), keys = ["SMITHERS_CFBOX", "SMITHERS_AFFECTED_LOCK"], previous = keys.map(key => process.env[key])
  t.after(() => { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }); rmSync(directory, { recursive: true, force: true }) })
  process.env.SMITHERS_CFBOX = join(directory, "cfbox"); process.env.SMITHERS_AFFECTED_LOCK = join(directory, "pg.lock")
  for (const mode of ["missing", "malformed", "setup"]) {
    writeFileSync(process.env.SMITHERS_CFBOX, `#!${process.execPath}\nconst mode=${JSON.stringify(mode)},a=process.argv.slice(2),jobs=[[]];for(const x of a.slice(a.indexOf('--')+1))x===':::'?jobs.push([]):jobs.at(-1).push(x);if(mode==='setup')console.log('[1] SMITHERS_AFFECTED '+Buffer.from(JSON.stringify({targets:{results:[],error:'setup incomplete'}})).toString('base64'));const finish=()=>jobs.forEach((_,i)=>{if(i===0){if(mode==='malformed')console.log('[1] SMITHERS_AFFECTED ewo=')}else{const r={targets:{results:[]},vitest:{exit:i===1?1:0,files:i===1?['src/a.test.ts']:[],failed:i===1?[{file:'src/a.test.ts',name:'new failure'}]:[]}};console.log('['+(i+1)+'] SMITHERS_AFFECTED '+Buffer.from(JSON.stringify(r)).toString('base64'))}console.error('cfbox: ['+(i+1)+'] exit 0; command 0.1s, wall 0.1s')});if(mode==='setup')setTimeout(finish,2300);else finish();\n`, { mode: 0o755 })
    const input = source(["apps/mvp/src/a.test.ts"]), entries = input.baseEntries
    input.baseEntries = () => { const result = entries(); result.delete("apps/mvp/src/a.test.ts"); return result }
    await assert.rejects(gate.affectedTests(directory, { source: input }), error => error.status === "refused" && error.regressions.includes("apps/mvp/src/a.test.ts > new failure"))
  }
})

for (const mode of ["head-error", "shared-error", "parent-other-error", "interrupted", "new-zero-error"]) test(`policy: completed assertions survive run errors: ${mode}`, async () => {
  const failure = { file: "src/a.test.ts", name: "A" }
  let compared = false
  const input = source(["apps/mvp/src/main.ts"])
  if (mode === "new-zero-error") {
    const entries = input.baseEntries
    input.baseEntries = () => { const result = entries(); result.delete("apps/mvp/src/a.test.ts"); return result }
  }
  const run = async (_, request, options) => {
    const result = passing(request)
    if (request.vitest) {
      if (base(options)) {
        compared = true
        result.vitest = mode === "head-error" ? { exit: 0, files: [failure.file], failed: [] }
          : { exit: 1, files: [failure.file], failed: [{ ...failure, name: mode === "shared-error" ? "A" : "B" }], error: "unrelated parent rejection" }
      } else result.vitest = request.shard === "1/6"
        ? { exit: mode === "interrupted" ? null : 1, files: [failure.file], failed: [mode === "new-zero-error" ? { ...failure, name: "(ran no tests)", unexcused: true } : failure], error: "unrelated head rejection" }
        : { exit: 0, files: [], failed: [] }
    }
    return result
  }
  await assert.rejects(gate.affectedTests("unused", { source: input, run }), error => {
    assert.equal(error.status, mode === "head-error" ? "refused" : "incomplete")
    if (mode === "head-error") assert.ok(error.regressions.includes("apps/mvp/src/a.test.ts > A"))
    else assert.equal(error.proven.sharedFailures, mode === "shared-error" ? 1 : 0)
    return true
  })
  assert.equal(compared, !["interrupted", "new-zero-error"].includes(mode))
})

test("policy: an unsuccessful parent without a completed failure cannot prove another test passed", async () => {
  for (const exit of [1, null]) {
    const run = async (_, request, options) => {
      const result = passing(request); result.client = "pg"
      if (request.vitest) result.vitest = base(options)
        ? { exit, files: ["src/a.test.ts"], failed: [] }
        : { exit: 1, files: request.shard === "1/6" ? ["src/a.test.ts"] : [], failed: request.shard === "1/6" ? [{ file: "src/a.test.ts", name: "A" }] : [] }
      return result
    }
    await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/main.ts"]), run }), error => error.status === "incomplete" && error.stage === "vitest-execution")
  }
})

test("policy: named assertions matching synthetic markers compare normally on edited files", async () => {
  for (const name of ["(ran no tests)", "(the file failed, with no error)", "(skipped reason sha256:ordinary assertion)"]) {
    for (const parentFails of [true, false]) {
      let compared = false
      const run = async (_, request, options) => {
        const result = passing(request); result.client = "pg"
        if (request.vitest) {
          if (base(options)) compared = true
          const failed = base(options) ? parentFails : request.shard === "1/6"
          result.vitest = { exit: failed ? 1 : 0, files: base(options) || request.shard === "1/6" ? ["src/a.test.ts"] : [], failed: failed ? [{ file: "src/a.test.ts", name }] : [] }
        }
        return result
      }
      const outcome = gate.affectedTests("unused", { source: source(["apps/mvp/src/a.test.ts"]), run })
      if (parentFails) {
        const result = await outcome
        assert.deepEqual(result.unchangedZeroTestFiles, [])
        assert.deepEqual(result.excusedSkippedFiles, [])
      } else await assert.rejects(outcome, error => error.status === "refused" && error.regressions.includes(`apps/mvp/src/a.test.ts > ${name}`))
      assert.equal(compared, true)
    }
  }
})

test("policy: a synthetic parent marker cannot excuse a distinct identically named assertion", async () => {
  for (const [name, flags] of [["(ran no tests)", { unexcused: true }], ["(the file failed, with no error)", { unexcused: true }], ["(skipped reason sha256:ordinary assertion)", { skipped: true }]]) {
    const run = async (_, request, options) => {
      const result = passing(request); result.client = "pg"
      if (request.vitest) {
        const failed = base(options) || request.shard === "1/6"
        result.vitest = { exit: failed ? 1 : 0, files: failed ? ["src/a.test.ts"] : [], failed: failed ? [{ file: "src/a.test.ts", name, ...base(options) ? flags : {} }] : [] }
      }
      return result
    }
    await assert.rejects(gate.affectedTests("unused", { source: source(["apps/mvp/src/a.test.ts"]), run }), error => error.status === "refused" && error.regressions.includes(`apps/mvp/src/a.test.ts > ${name}`))
  }
})
