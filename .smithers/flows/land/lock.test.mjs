import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireLock, landWorkspace } from "./workspace.mjs"
import { jj } from "./numbering.mjs"
import { defaultLockTimeoutMs } from "./lock.mjs"

const scratch = join(homedir(), ".vibe-orch/proxy/smithers-runners/landlock")
mkdirSync(scratch, { recursive: true })
const fixture = (t) => {
  const directory = mkdtempSync(join(scratch, "test-"))
  t.landLocks = []
  t.after(async () => { for (const release of t.landLocks) await release(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, lock: join(directory, "main-push.lock") }
}
const deferred = () => Promise.withResolvers()
function clock(time = 1000) {
  const waits = new Set()
  return {
    now: () => time,
    wait: () => new Promise((resolve) => waits.add(resolve)),
    advance(ms = 0) { time += ms; for (const resolve of waits) resolve(); waits.clear() }
  }
}
function options(c, log = () => {}) {
  return { ...c, heartbeat: false, staleMs: 100, maxHoldMs: 1000, timeoutMs: 500, log }
}
async function holder(t, lock, opts) {
  const release = await acquireLock(lock, opts)
  t.landLocks.push(release)
  assert.equal(typeof release.push, "function", "publication must be fenced by the ticket")
  return release
}

test("five racing tickets remain FIFO, including a third waiter's printed position", { timeout: 10000 }, async (t) => {
  const { lock } = fixture(t), c = clock(), lines = []
  const first = await holder(t, lock, options(c, (line) => lines.push(line)))
  const entered = [], pending = []
  for (let i = 0; i < 5; i++) pending.push(acquireLock(lock, options(c, (line) => lines.push(line))).then((release) => {
    entered.push(i); return release().then(() => c.advance())
  }))
  assert.match(lines.join("\n"), /position 3\b/)
  assert.deepEqual(entered, [])
  await first(); c.advance()
  await Promise.all(pending)
  assert.deepEqual(entered, [0, 1, 2, 3, 4])
  // A drained queue must retain the monotonic allocation history.
  const last = await holder(t, lock, options(c, (line) => lines.push(line)))
  assert.match(lines.join("\n"), /TICKET 7\b/)
  await last()
})

test("default admission keeps ticket two through six minutes of healthy validation and publication", { timeout: 15000 }, async (t) => {
  const { directory, lock } = fixture(t), c = clock(Date.now()), lines = []
  assert.equal(defaultLockTimeoutMs, 3600000)
  const priorTimeout = process.env.SMITHERS_LOCK_TIMEOUT_MS
  delete process.env.SMITHERS_LOCK_TIMEOUT_MS
  t.after(() => { if (priorTimeout === undefined) delete process.env.SMITHERS_LOCK_TIMEOUT_MS; else process.env.SMITHERS_LOCK_TIMEOUT_MS = priorTimeout })
  const first = await holder(t, lock, { now: c.now, heartbeat: false, log: () => {} })
  const publication = join(directory, "landed")
  const checkedAgain = deferred()
  let waits = 0
  const pending = acquireLock(lock, {
    now: c.now, heartbeat: false,
    wait: () => { if (++waits === 2) checkedAgain.resolve(); return c.wait() },
    log: (line) => lines.push(line)
  })
  // Observe rejection immediately; cleanup must release a successfully admitted waiter too.
  pending.then((release) => t.landLocks.push(release), () => {})
  assert.match(lines.join("\n"), /TICKET 2\b[\s\S]*position 2\b/)
  const ticket = join(`${lock}.queue`, "0000000000000002")
  // The independent heartbeat writer is represented by its persisted heartbeat.
  // Six minutes is within the holder's real fifteen-minute lease.
  writeFileSync(join(`${lock}.queue`, first.ticket, "heartbeat"), String(c.now() + 360000))
  c.advance(360000)
  try {
    await Promise.race([checkedAgain.promise, pending.then(() => assert.fail("waiter bypassed holder"))])
    assert.equal(existsSync(join(ticket, "done")), false, "the waiting ticket must stay active")
    first.check()
    await first(); c.advance()
    const second = await pending
    assert.equal(second.ticket, "0000000000000002", "no replacement ticket is needed")
    await second.push(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(publication)}, 'landed')`])
    assert.equal(readFileSync(publication, "utf8"), "landed")
    assert.doesNotMatch(lines.join("\n"), /RECLAIM|TICKET 3/)
  } finally { await first(); c.advance(); await pending.catch(() => {}) }
})

test("max hold revokes a live holder; its final push refuses without running the callback", async (t) => {
  const { lock } = fixture(t), c = clock(), lines = []
  const first = await holder(t, lock, options(c))
  c.advance(1001)
  const second = await holder(t, lock, options(c, (line) => lines.push(line)))
  let pushed = false
  await assert.rejects(first.push(process.execPath, ["-e", "process.exit(0)"]), /lost|expired/i)
  assert.equal(pushed, false)
  assert.match(lines.join("\n"), /RECLAIM.*ticket 1.*max hold/i)
  await first() // A late cleanup must not remove the replacement's legacy lock.
  assert.equal(existsSync(lock), true)
  second.check(); pushed = true
  assert.equal(pushed, true)
})

test("an expired holder refuses publication even before anyone reclaims it", async (t) => {
  const { lock } = fixture(t), c = clock()
  const first = await holder(t, lock, options(c))
  c.advance(1001)
  await assert.rejects(first.push(process.execPath, ["-e", "process.exit(0)"]), /lost|expired/i)
})

test("bounded queue admission times out clearly and removes only its ticket", async (t) => {
  const { lock } = fixture(t), c = clock()
  const first = await holder(t, lock, options(c))
  const pending = assert.rejects(acquireLock(lock, { ...options(c), timeoutMs: 20 }), /Landing queue timed out.*ticket 2.*position 2/i)
  c.advance(21)
  await pending
  first.check()
})

test("non-directory legacy lock refuses immediately without even waiting", async (t) => {
  const { lock } = fixture(t)
  writeFileSync(lock, "preserve")
  await assert.rejects(acquireLock(lock, { wait: () => assert.fail("must not wait") }), /regular file.*not the directory form/)
  assert.equal(readFileSync(lock, "utf8"), "preserve")
})

test("legacy bare mkdir owners exclude the queue head and are never reclaimed", async (t) => {
  const { lock } = fixture(t), c = clock()
  mkdirSync(lock)
  const pending = assert.rejects(acquireLock(lock, { ...options(c), timeoutMs: 20 }), /timed out.*legacy/i)
  c.advance(21)
  await pending
  assert.equal(existsSync(lock), true)
})

test("cancellation removes a waiter without removing the holder's lock", async (t) => {
  const { lock } = fixture(t)
  const first = await holder(t, lock, { heartbeat: false })
  const controller = new AbortController(), queued = deferred()
  const pending = assert.rejects(acquireLock(lock, { signal: controller.signal, log: (line) => { if (line.includes("position 2")) queued.resolve() } }), /cancel fixture/)
  await queued.promise
  controller.abort(new Error("cancel fixture"))
  await pending
  first.check()
})

test("a same-host dead pid is reclaimed before its heartbeat expires", async (t) => {
  const { lock } = fixture(t), c = clock(), lines = []
  const first = await holder(t, lock, options(c))
  const file = join(`${lock}.queue`, first.ticket, "owner.json")
  const record = JSON.parse(readFileSync(file, "utf8"))
  // A real child supplies a pid whose exit is observed, rather than guessing a pid.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await once(child, "exit")
  record.pid = child.pid
  writeFileSync(file, JSON.stringify(record))
  const second = await holder(t, lock, options(c, (line) => lines.push(line)))
  assert.match(lines.join("\n"), /RECLAIM.*process gone/)
  second.check()
})

test("a healthy remote pid and an interrupted initializer use heartbeat evidence only", async (t) => {
  const { lock } = fixture(t), c = clock()
  const first = await holder(t, lock, options(c))
  const file = join(`${lock}.queue`, first.ticket, "owner.json")
  const record = JSON.parse(readFileSync(file, "utf8"))
  record.host = "remote.fixture.invalid"; record.pid = 2147483647
  writeFileSync(file, JSON.stringify(record))
  const pending = assert.rejects(acquireLock(lock, { ...options(c), timeoutMs: 10 }), /timed out/)
  c.advance(11); await pending
  await first()
  const abandoned = join(`${lock}.queue`, "0000000000000003")
  mkdirSync(abandoned)
  c.advance(Date.now() + 200)
  const lines = []
  const next = await holder(t, lock, options(c, (line) => lines.push(line)))
  assert.match(lines.join("\n"), /RECLAIM.*uninitialized.*heartbeat/)
  next.check()
})

test("five processes racing to claim tickets enter in numeric claim order", { timeout: 15000 }, async (t) => {
  const { lock } = fixture(t)
  const first = await holder(t, lock, { heartbeat: false })
  const entered = [], queued = [], completed = [], racing = []
  for (let i = 0; i < 5; i++) {
    const ready = deferred(), finished = deferred()
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireLock } from ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};
      process.once('message', async () => {
        const release = await acquireLock(${JSON.stringify(lock)}, {log: line => process.send({line})});
        release.check(); process.send({entered: release.ticket});
        await release(); process.disconnect();
      }); process.send({ready: true});
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
    child.on("message", (message) => {
      if (message.ready) ready.resolve()
      if (message.line?.includes("WAITING")) finished.resolve()
      if (message.entered) entered.push(message.entered)
    })
    queued.push(finished.promise)
    completed.push(once(child, "exit").then(([code]) => assert.equal(code, 0)))
    await ready.promise
    // All workers are ready before any claims are allowed.
    racing.push(child)
  }
  for (const child of racing) child.send("start")
  await Promise.all(queued)
  await first()
  await Promise.all(completed)
  assert.deepEqual(entered, [2, 3, 4, 5, 6].map((n) => String(n).padStart(16, "0")))
})

test("the heartbeat survives a synchronously blocked lander and stops when it exits", { timeout: 10000 }, async (t) => {
  const { lock } = fixture(t)
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireLock } from ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};
    import { readSync } from 'node:fs';
    const release = await acquireLock(${JSON.stringify(lock)}, {heartbeatMs: 20, staleMs: 5000});
    process.send({ticket: release.ticket});
    readSync(0, Buffer.alloc(1), 0, 1, null);
    await release(); process.disconnect();
  `], { stdio: ["pipe", "ignore", "pipe", "ipc"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  const [message] = await once(child, "message")
  const directory = join(`${lock}.queue`, message.ticket)
  const initial = Number(readFileSync(join(directory, "heartbeat"), "utf8"))
  const refreshed = deferred()
  const observer = watch(directory, () => {
    const stamp = Number(readFileSync(join(directory, "heartbeat"), "utf8"))
    if (stamp - initial >= 250) refreshed.resolve()
  })
  t.after(() => observer.close())
  await refreshed.promise
  await assert.rejects(acquireLock(lock, { timeoutMs: 0, staleMs: 5000, heartbeatMs: 20 }), /timed out/)
  const exited = once(child, "exit")
  child.stdin.end("x"); await exited
  assert.equal(existsSync(lock), false)
})

test("a SIGKILL holder is reclaimed by heartbeat on a remote-host ticket", { timeout: 10000 }, async (t) => {
  const { lock } = fixture(t), c = clock(), lines = []
  // Readiness is IPC, never a sleep. The holder uses the real heartbeat writer.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireLock } from ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};
    const release = await acquireLock(${JSON.stringify(lock)}, { staleMs: 1000, heartbeatMs: 20 });
    process.send({ ticket: release.ticket });
    process.on("message", () => {});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  t.after(() => child.kill("SIGKILL"))
  const [message] = await once(child, "message")
  assert.ok(message.ticket, "holder identifies its ticket")
  const owner = join(`${lock}.queue`, message.ticket, "owner.json")
  const record = JSON.parse(readFileSync(owner, "utf8"))
  const exited = once(child, "exit")
  child.kill("SIGKILL"); await exited
  // Remote pid must never be probed. Make only heartbeat age justify recovery.
  record.host = "remote.fixture.invalid"
  writeFileSync(owner, JSON.stringify(record))
  c.advance(Date.now() + 2000)
  const next = await holder(t, lock, { ...options(c, (line) => lines.push(line)), maxHoldMs: 1e9 })
  assert.match(lines.join("\n"), /RECLAIM.*heartbeat/i)
  next.check()
})

test("commit.mjs queues before executing its validation command", { timeout: 10000 }, async (t) => {
  const { directory, lock } = fixture(t)
  const root = join(directory, "repo")
  mkdirSync(root); jj(root, ["git", "init", "."])
  const first = await holder(t, lock, { heartbeat: false })
  const child = spawn(process.execPath, [join(import.meta.dirname, "commit.mjs"), "--test", "exit 17"], {
    cwd: root, env: { ...process.env, SMITHERS_LAND_LOCK: lock }, stdio: ["ignore", "ignore", "pipe"]
  })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  const queued = deferred(), exited = once(child, "exit")
  let stderr = ""
  child.stderr.on("data", (bytes) => { stderr += bytes; if (stderr.includes("position 2")) queued.resolve() })
  await Promise.race([queued.promise, exited.then(() => assert.fail(stderr))])
  assert.doesNotMatch(stderr, /Test command failed/)
  await first()
  assert.equal((await exited)[0], 1)
  assert.match(stderr, /ACQUIRED landing ticket 2[\s\S]*Test command failed: exit 17/)
})

test("two concurrent real landers validate and push in ticket order; a third queues without a slot", { timeout: 180000 }, async (t) => {
  const { directory, lock } = fixture(t)
  const remote = join(directory, "remote")
  mkdirSync(remote)
  jj(remote, ["git", "init", "."])
  jj(remote, ["config", "set", "--repo", "user.name", "Lock test"])
  jj(remote, ["config", "set", "--repo", "user.email", "lock@example.invalid"])
  writeFileSync(join(remote, "base"), "base")
  jj(remote, ["commit", "-m", "base"])
  jj(remote, ["bookmark", "set", "main", "-r", "@-"])
  const lanes = [1, 2, 3].map((i) => {
    const root = join(directory, `repo-${i}`)
    jj(directory, ["git", "clone", remote, root])
    jj(root, ["config", "set", "--repo", "user.name", "Lock test"])
    jj(root, ["config", "set", "--repo", "user.email", "lock@example.invalid"])
    writeFileSync(join(root, `feature-${i}`), `${i}`)
    return root
  })
  const entered = deferred(), proceed = deferred(), logs = [], events = new EventEmitter()
  // Validation is a real Node child, gated through its stdout/stdin events.
  const validation = join(directory, "validation.mjs")
  writeFileSync(validation, `import net from 'node:net'; const s=net.connect(process.env.LAND_TEST_SOCKET); s.on('data',()=>s.end());`)
  const { createServer } = await import("node:net")
  const socket = join(directory, "gate.sock")
  const server = createServer((connection) => { entered.resolve(); proceed.promise.then(() => connection.end("go")) })
  t.after(() => server.close())
  server.listen(socket); await once(server, "listening")
  const oldSocket = process.env.LAND_TEST_SOCKET
  process.env.LAND_TEST_SOCKET = socket
  t.after(() => { if (oldSocket === undefined) delete process.env.LAND_TEST_SOCKET; else process.env.LAND_TEST_SOCKET = oldSocket })
  const original = console.error
  console.error = (...args) => { const line = args.join(" "); logs.push(line); events.emit("line", line) }
  t.after(() => { console.error = original; proceed.resolve() })
  const landed = [], pending = []
  const run = (i, tests) => {
    const result = landWorkspace(lanes[i - 1], { lockPath: lock, message: `test: lane ${i}`, tests }).then((id) => { landed.push(i); return id })
    result.catch(() => {}) // The finally below always observes every concurrent result.
    pending.push(result)
    return result
  }
  const queued = (position) => new Promise((resolve) => {
    const listener = (line) => { if (line.includes(`position ${position}`)) { events.off("line", listener); resolve() } }
    events.on("line", listener)
  })
  try {
    const first = run(1, [`${process.execPath} ${validation}`])
    await Promise.race([entered.promise, first.then(() => assert.fail("first skipped validation"))])
    const secondQueued = queued(2), second = run(2, ["true"])
    await Promise.race([secondQueued, second.then(() => assert.fail("second landed while first still validated"))])
    const thirdQueued = queued(3), third = run(3, ["true"])
    await Promise.race([thirdQueued, third.then(() => assert.fail("third skipped the queue"))])
    proceed.resolve()
    await Promise.all([first, second, third])
  } finally { proceed.resolve(); await Promise.allSettled(pending) }
  assert.deepEqual(landed, [1, 2, 3])
  assert.doesNotMatch(logs.join("\n"), /Main advanced/)
  jj(remote, ["git", "import", "--ignore-working-copy"])
  for (let i = 1; i <= 3; i++) assert.equal(jj(remote, ["file", "show", "-r", "main", `feature-${i}`]), `${i}`)
  await t.test("a real land that overruns immediately before push leaves remote main unchanged", async () => {
    const c = clock()
    const before = jj(remote, ["log", "-r", "main", "--no-graph", "-T", "commit_id"])
    writeFileSync(join(lanes[0], "too-late"), "never published")
    await assert.rejects(landWorkspace(lanes[0], {
      lockPath: lock, lockOptions: options(c), message: "test: expired land", tests: ["true"], beforePush: async () => { c.advance(1001) }
    }), /lost or expired.*refusing to push/)
    jj(remote, ["git", "import", "--ignore-working-copy"])
    assert.equal(jj(remote, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), before)
    assert.equal(existsSync(lock), false)
  })
})
