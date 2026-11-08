import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { Effect, Layer } from "effect"
import { ResourceLocks, ordered, releaseAll, leasePool, DeadOwner, IncompleteOwner } from "./resource-locks.ts"
import { joinLegacyFence, whileLeavingFence } from "./legacy-fence.ts"
import { declarations, resourcesFor, filesFromList, parseListReport, SPEC_RESOURCES } from "./resources.ts"
import { ensureScratchRepository, leaseRunResources, poolConfig, poolNames, ScratchGitHub, verifyPoolAccount } from "./scratch-pool.ts"

const directory = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "e2e-resource-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const lockAt = async (t, options = {}) => new ResourceLocks(await directory(t), { pollMs: 5, ...options })
const read = (name) => ({ name, mode: "read" })
const write = (name) => ({ name, mode: "write" })
const owner = (pid = process.pid) => ({ pid, host: hostname(), nonce: "test-owner", since: new Date().toISOString() })
const deadPid = async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
  const pid = child.pid
  await once(child, "close")
  return pid
}

test("union is exact, sorted, deduplicated; write dominates read; unknown specs fail closed", () => {
  assert.deepEqual(ordered([write("z"), read("a"), read("z"), write("a")]), [write("a"), write("z")])
  assert.throws(() => ordered([write("")]), /Invalid/)
  assert.throws(() => ordered([{ name: "a", mode: "bad" }]), /Invalid/)
  assert.deepEqual(declarations(["shell-notifications.spec.ts", "deployment/sign-in.setup.ts"]), [])
  assert.throws(() => declarations(["new.spec.ts"]), /Declare/)
  assert.deepEqual(resourcesFor(declarations(["runner-registration.spec.ts", "todos-independent.spec.ts"]), {
    E2E_FACTORY_REPOSITORY: "test/Factory", E2E_STACK_REPOSITORY: "test/Stack",
  }), [write("repository:test/factory"), write("repository:test/stack")])
  assert.deepEqual(resourcesFor(["model:read", "model:write", "notification-settings", "todo", "stack"], {}), [
    write("account:model-connections"), write("account:notification-settings"), write("repository:roninjin10/smithers-github-tests"),
  ])
  assert.deepEqual(resourcesFor(["repo-flows"], { E2E_FACTORY_REPOSITORY: "test/a" }), [write("repository:test/a")])
  assert.deepEqual(resourcesFor(["secrets-branch"], { E2E_SECRETS_REPOSITORY: "test/Secrets", E2E_SECRETS_BRANCH: "Fixture" }), [write("branch:test/secrets/Fixture")])
  assert.deepEqual(resourcesFor(["secrets-branch"], {}), [])
  assert.throws(() => resourcesFor(["stack"], { E2E_STACK_REPOSITORY: "../../bad" }), /Invalid/)
})
test("discovery uses selected tests, including nested suites; every current spec declares resources", async () => {
  assert.deepEqual(filesFromList({ suites: [{ specs: [{ file: "unused", tests: [] }], suites: [{ specs: [{ file: "a.spec.ts", tests: [{}] }, { file: "a.spec.ts", tests: [{}] }] }] }] }), ["a.spec.ts"])
  assert.deepEqual(filesFromList(parseListReport('{"suites":[]}')), [])
  assert.throws(() => parseListReport("private-provider-diagnostic"), (error) => error.message.includes("invalid JSON") && !error.message.includes("private-provider-diagnostic"))
  assert.deepEqual(filesFromList({}), [])
  assert.throws(() => filesFromList({ errors: [{}] }), /discovery failed/)
  const files = (await readdir(new URL(".", import.meta.url))).filter((name) => name.endsWith(".spec.ts")).sort()
  assert.deepEqual(Object.keys(SPEC_RESOURCES).sort(), files)
})
test("independent resources and shared readers coexist; a writer waits until every reader exits", async (t) => {
  const log = []
  const locks = await lockAt(t, { log: (line) => log.push(line) })
  const a = await locks.acquire(read("model"))
  const b = await locks.acquire(read("model"))
  const c = await locks.acquire(write("repository:other"))
  assert.equal(await locks.tryAcquire(write("model")), undefined)
  let entered = false
  const waiting = locks.acquire(write("model")).then((lease) => { entered = true; return lease })
  await a.release(); await a.release()
  assert.equal(await locks.tryAcquire(write("model")), undefined)
  assert.equal(entered, false)
  await b.release()
  const writer = await waiting
  assert.equal(await locks.tryAcquire(read("model")), undefined)
  await releaseAll([writer, c])
  assert.ok(log.some((line) => line.includes("waiting model")))
  assert.ok(log.some((line) => line.includes("released model")))
})
test("a pull review holds its reused head until the whole proof exits, while independent model readers coexist", async (t) => {
  const locks = await lockAt(t)
  const resources = resourcesFor(declarations(["pull-review.spec.ts"]), {})
  const first = await locks.acquireAll(resources)
  const partial = []
  let blocked = false
  try {
    for (const resource of resources) {
      const lease = await locks.tryAcquire(resource)
      if (!lease) { blocked = true; break }
      partial.push(lease)
    }
    assert.equal(blocked, true, "a second proof cannot refresh the first proof's head")
    const reader = await locks.tryAcquire(read("account:model-connections"))
    assert.ok(reader)
    await reader.release()
    assert.equal(await locks.tryAcquire(write("account:model-connections")), undefined)
  } finally {
    await releaseAll(partial)
    await releaseAll(first)
  }
  await releaseAll(await locks.acquireAll(resources))
})
test("live owners and incomplete owners are never taken over; dead owners report exact path", async (t) => {
  const locks = await lockAt(t)
  const lease = await locks.acquire(write("repository:test/a"))
  assert.equal(await locks.tryAcquire(write("repository:test/a")), undefined)
  await lease.release()
  const path = join(locks.root, "stale.lock", "write-old")
  await mkdir(path, { recursive: true })
  assert.equal(await locks.tryAcquire(write("stale")), undefined)
  await writeFile(join(path, "owner"), JSON.stringify(owner(await deadPid())))
  await assert.rejects(locks.acquire(write("stale")), (error) => error instanceof DeadOwner && error.message.includes(path))
  assert.ok(await readFile(join(path, "owner")))
})
test("a dead gate is reported; an unreadable filesystem and owner corruption are not contention", async (t) => {
  const locks = await lockAt(t)
  const gate = join(locks.root, "g.lock.gate")
  await mkdir(gate)
  assert.equal(await locks.tryAcquire(write("g")), undefined)
  await writeFile(join(gate, "owner"), JSON.stringify(owner(await deadPid())))
  await assert.rejects(locks.tryAcquire(write("g")), DeadOwner)
  await writeFile(join(gate, "owner"), JSON.stringify({ pid: -1 }))
  await assert.rejects(locks.tryAcquire(write("g")), /Invalid lock owner/)
  const file = join(locks.root, "not-a-directory")
  await writeFile(file, "file")
  await assert.rejects(new ResourceLocks(file).acquire(write("a")), { code: "EEXIST" })
})
test("release verifies nonce and cannot delete a replacement owner", async (t) => {
  const locks = await lockAt(t)
  const lease = await locks.acquire(write("a"))
  const [entry] = await readdir(join(locks.root, "a.lock"))
  await writeFile(join(locks.root, "a.lock", entry, "owner"), JSON.stringify(owner()))
  await assert.rejects(releaseAll([lease]), AggregateError)
  assert.equal((await readdir(join(locks.root, "a.lock"))).length, 1)
})
test("cancellation releases earlier locks, and a second run can take them", async (t) => {
  const root = await directory(t)
  const controller = new AbortController()
  const locks = new ResourceLocks(root, { signal: controller.signal, pollMs: 5 })
  const held = await locks.acquire(write("z"))
  const acquiring = locks.acquireAll([write("z"), write("a")])
  // Observe the first lease on disk rather than depending on a timing delay.
  const observer = new ResourceLocks(root, { pollMs: 5 })
  while (!(await readdir(join(root, "a.lock")).catch(() => [])).length) await observer.pause()
  controller.abort()
  await assert.rejects(acquiring, { name: "AbortError" })
  const a = await observer.acquire(write("a"))
  await releaseAll([held, a])
})
test("pool skips busy slots, waits on exhaustion, then reuses a released slot", async (t) => {
  const locks = await lockAt(t)
  const a = await leasePool(locks, ["test/pool-1", "test/pool-2"])
  const b = await leasePool(locks, ["test/pool-1", "test/pool-2"])
  assert.notEqual(a.repository, b.repository)
  let entered = false
  const waiting = leasePool(locks, ["test/pool-1", "test/pool-2"]).then((result) => { entered = true; return result })
  await locks.pause()
  assert.equal(entered, false)
  await a.lease.release()
  const c = await waiting
  assert.equal(c.repository, a.repository)
  await releaseAll([b.lease, c.lease])
  await assert.rejects(leasePool(locks, []), /Empty/)
})
test("multi-pool selection releases partial candidates and always acquires in global order", async (t) => {
  const log = []
  const locks = await lockAt(t, { log: (line) => log.push(line) })
  const busy = await locks.acquire(write("repository:test/stack-1"))
  const a = await leaseRunResources(locks, [write("account:settings")], [["test/stack-1", "test/stack-2"], ["test/factory-1"]])
  assert.deepEqual(a.repositories, ["test/stack-2", "test/factory-1"])
  const acquired = log.filter((line) => line.includes(" acquired ")).slice(-3).map((line) => line.split(" acquired ")[1].split(" mode=")[0])
  assert.deepEqual(acquired, ["account:settings", "repository:test/factory-1", "repository:test/stack-2"])
  await releaseAll([...a.leases, busy])
  await assert.rejects(leaseRunResources(locks, [], [[]]), /Empty/)
})
test("pool failures are injected Effect services, never fabricated happy GitHub responses", async () => {
  const config = { login: "test", appId: 1, size: 2 }
  assert.deepEqual(poolNames(config, "stack"), ["test/smithers-e2e-stack-1", "test/smithers-e2e-stack-2"])
  assert.throws(() => poolConfig({}), /App identity missing/)
  assert.throws(() => poolConfig({ E2E_SCRATCH_POOL_SIZE: "17" }), /Invalid/)
  assert.equal(poolConfig({ E2E_GITHUB_APP_ID: "1" }).size, 4)
  const failure = new Error("injected transport fault")
  const faulty = Layer.succeed(ScratchGitHub, { request: () => Effect.fail(failure) })
  await assert.rejects(Effect.runPromise(verifyPoolAccount(config).pipe(Effect.provide(faulty))), /injected transport fault/)
  await assert.rejects(Effect.runPromise(ensureScratchRepository("test/smithers-e2e-stack-1", config).pipe(Effect.provide(faulty))), /injected transport fault/)
  await assert.rejects(Effect.runPromise(ensureScratchRepository("real/product", config).pipe(Effect.provide(faulty))), /Not a pool/)
})
test("the legacy fence admits new runs together but does not steal an old live or dead run", async (t) => {
  const locks = await lockAt(t)
  const path = join(locks.root, "run.lock")
  const first = await joinLegacyFence(path, locks)
  const second = await joinLegacyFence(path, locks)
  assert.equal((await readdir(join(path, "members"))).length, 2)
  let finished = false
  const leaving = first().then(() => { finished = true })
  await locks.pause()
  assert.equal(finished, false)
  await second(); await leaving
  await assert.rejects(readFile(join(path, "owner")), { code: "ENOENT" })
  await mkdir(path)
  await writeFile(join(path, "owner"), `old run pid ${await deadPid()}`)
  await assert.rejects(joinLegacyFence(path, locks), DeadOwner)
  await writeFile(join(path, "owner"), `old run pid ${process.pid}`)
  const controller = new AbortController()
  const waiter = joinLegacyFence(path, new ResourceLocks(locks.root, { signal: controller.signal, pollMs: 5 }))
  controller.abort()
  await assert.rejects(waiter, { name: "AbortError" })
  assert.match(await readFile(join(path, "owner"), "utf8"), /old run/)
})

test("real child processes serialize opposite-order lock requests without deadlock", { timeout: 10_000 }, async (t) => {
  const root = await directory(t)
  const module = new URL("./resource-locks.ts", import.meta.url).href
  const script = `
    const {ResourceLocks,releaseAll}=await import(process.argv[1]);
    const {mkdir,rm}=await import('node:fs/promises');
    const {join}=await import('node:path');
    const locks=new ResourceLocks(process.argv[2],{pollMs:5});
    const resources=JSON.parse(process.argv[3]).map(name=>({name,mode:'write'}));
    for(let i=0;i<8;i++){
      const leases=await locks.acquireAll(resources);
      await mkdir(join(process.argv[2],'critical'));
      await new Promise(resolve=>setTimeout(resolve,5));
      await rm(join(process.argv[2],'critical'),{recursive:true});
      await releaseAll(leases);
    }
  `
  const children = ["a,b", "b,a", "a,b"].map((order) => spawn(process.execPath, ["--input-type=module", "-e", script, module, root, JSON.stringify(order.split(","))], { stdio: ["ignore", "ignore", "pipe"] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  const results = await Promise.all(children.map(async (child) => {
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk })
    const [status] = await once(child, "close")
    return { status, stderr }
  }))
  for (const result of results) assert.equal(result.status, 0, result.stderr)
})

test("aborted pool selection returns every partial lease", async (t) => {
  const root = await directory(t)
  const controller = new AbortController()
  const locks = new ResourceLocks(root, { signal: controller.signal, pollMs: 5 })
  const held = await locks.acquire(write("repository:pool"))
  const waiting = leaseRunResources(locks, [write("account:settings")], [["pool"]])
  await locks.pause()
  controller.abort()
  await assert.rejects(waiting, { name: "AbortError" })
  const settings = await new ResourceLocks(root).acquire(write("account:settings"))
  await releaseAll([settings, held])
})

test("owner publication is atomic under real cross-process observation", { timeout: 20_000 }, async (t) => {
  const root = await directory(t)
  const module = new URL("./resource-locks.ts", import.meta.url).href
  const script = `
    const {ResourceLocks}=await import(process.argv[1]);
    const locks=new ResourceLocks(process.argv[2],{pollMs:1});
    for(let i=0;i<300;i++) await (await locks.acquire({name:'publication',mode:'write'})).release();
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, module, root], { stdio: "ignore" })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let done = false
  const closed = once(child, "close").then(([status]) => { done = true; assert.equal(status, 0) })
  let reads = 0
  while (!done) {
    const value = await readFile(join(root, "publication.lock.gate", "owner"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (value !== undefined) { assert.equal(typeof JSON.parse(value).nonce, "string"); reads++ }
  }
  await closed
  assert.ok(reads > 0, "observed published gate owners while another process acquired/released")
})

test("child completion waits for surviving process-group descendants", { timeout: 10_000 }, async (t) => {
  const { runChild } = await import("./child-runner.ts")
  const root = await directory(t)
  const marker = join(root, "finished")
  const parent = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),200)",process.argv[1]],{stdio:'ignore'});
    child.unref();
  `
  const result = await runChild(process.execPath, ["-e", parent, marker])
  assert.equal(result.status, 0)
  assert.equal(await readFile(marker, "utf8"), "done")
  assert.equal((await runChild(process.execPath, ["-e", "process.stdout.write('captured')"], { capture: true })).stdout, "captured")
  assert.equal((await runChild(process.execPath, ["-e", "process.stderr.write('diagnostic')"], { capture: true })).stderr, "diagnostic")
  await assert.rejects(runChild(join(root, "missing"), []), { code: "ENOENT" })
})
test("cancellation waits for a descendant which handles SIGINT after its parent exits", { timeout: 10_000 }, async (t) => {
  const { runChild } = await import("./child-runner.ts")
  const root = await directory(t)
  const ready = join(root, "ready")
  const stopped = join(root, "stopped")
  const parent = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.argv[2],'stopped');process.exit(0)},150));require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",process.argv[1],process.argv[2]],{stdio:'ignore'});
    child.unref();
  `
  const controller = new AbortController()
  const running = runChild(process.execPath, ["-e", parent, ready, stopped], { signal: controller.signal, killAfterMs: 1_000 })
  while (!(await readFile(ready, "utf8").catch(() => undefined))) await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()
  await running
  assert.equal(await readFile(stopped, "utf8"), "stopped")
})

test("a remote-host owner is never declared dead using a local PID", async (t) => {
  const locks = await lockAt(t)
  const path = join(locks.root, "remote.lock", "write-remote")
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "owner"), JSON.stringify({ ...owner(await deadPid()), host: `${hostname()}-another-host` }))
  assert.equal(await locks.tryAcquire(write("remote")), undefined)
  assert.ok(await readFile(join(path, "owner")))
})


test("old incomplete gates, leases and legacy fences are reported without takeover", async (t) => {
  const locks = await lockAt(t)
  const old = new Date(Date.now() - 10_000)
  const gate = join(locks.root, "incomplete.lock.gate")
  await mkdir(gate); await utimes(gate, old, old)
  await assert.rejects(locks.tryAcquire(write("incomplete")), IncompleteOwner)
  const lease = join(locks.root, "abandoned.lock", "write-empty")
  await mkdir(lease, { recursive: true }); await utimes(lease, old, old)
  await assert.rejects(locks.tryAcquire(write("abandoned")), IncompleteOwner)
  const fence = join(locks.root, "run.lock")
  await mkdir(fence); await utimes(fence, old, old)
  await assert.rejects(joinLegacyFence(fence, locks), IncompleteOwner)
  assert.equal((await readdir(fence)).length, 0)
})

test("a failed media executable cannot abandon a live compatibility cohort", { timeout: 10_000 }, async (t) => {
  const { runChild } = await import("./child-runner.ts")
  const locks = await lockAt(t)
  const fence = join(locks.root, "run.lock")
  const first = await joinLegacyFence(fence, locks)
  const second = await joinLegacyFence(fence, locks)
  let finished = false
  const media = whileLeavingFence(first, () => runChild(join(locks.root, "missing-media"), []))
    .then(() => { throw new Error("missing command unexpectedly ran") }, (error) => { finished = true; return error })
  await locks.pause()
  assert.equal(finished, false)
  await second()
  const error = await media
  assert.equal(error.code, "ENOENT")
  await assert.rejects(readFile(join(fence, "owner")), { code: "ENOENT" })
})

test("candidate-dependent aliases lease the selected repository, not the configured fallback", async (t) => {
  const locks = await lockAt(t)
  const selected = await leaseRunResources(locks, (repositories) => resourcesFor(["factory", "repo-flows"], {
    E2E_FACTORY_REPOSITORY: repositories[0],
  }), [["test/pool-1"]])
  assert.deepEqual(selected.leases.map((lease) => lease.resource.name), ["repository:test/pool-1"])
  const unrelated = await locks.acquire(write("repository:test/fallback"))
  await releaseAll([...selected.leases, unrelated])
})
