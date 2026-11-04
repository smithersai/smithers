import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { acquireLock, claimDecision, finishTicket, groupSnapshot, killPublisher, publicationStopped } from "./lock.mjs"

const moduleUrl = new URL("./lock.mjs", import.meta.url).href
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "landlock-recovery-"))
  const children = [], leases = [], pending = []
  t.after(async () => {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL") }
    await Promise.allSettled(pending)
    for (const lease of leases) await lease()
    rmSync(directory, { recursive: true, force: true })
  })
  const child = (code) => {
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "ignore", "pipe", "ipc"] })
    children.push(processChild)
    return processChild
  }
  const lock = join(directory, "main-push.lock")
  const acquire = async (options = {}) => {
    const result = acquireLock(lock, { ...options, signal: options.signal ?? t.signal })
    pending.push(result)
    const lease = await result; leases.push(lease); return lease
  }
  return { directory, child, lock, acquire }
}

for (const phase of ["release-decision", "legacy-retired"]) test(`cleanup recovers a holder killed at ${phase}`, { timeout: 60000 }, async (t) => {
  const { child, lock, acquire } = fixture(t)
  const parent = child(`
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    import { readSync } from 'node:fs';
    const release = await acquireLock(${JSON.stringify(lock)}, {onEvent(event) {
      if (event.stage === ${JSON.stringify(phase)}) { process.send('paused'); readSync(0, Buffer.alloc(1),0,1,null); }
    }});
    await release(); process.disconnect();
  `)
  let stderr = ""
  parent.stderr.on("data", (bytes) => { stderr += bytes })
  const exited = once(parent, "exit")
  const ready = once(parent, "message")
  const [message] = await Promise.race([ready, exited.then(() => assert.fail("cleanup phase was never emitted: " + stderr))])
  assert.equal(message, "paused")
  parent.kill("SIGKILL"); await exited
  const next = await acquire({ timeoutMs: 10000 })
  next.check()
  assert.equal(existsSync(lock), true)
})

test("a holder killed at legacy acquisition leaves recoverable ownership", { timeout: 60000 }, async (t) => {
  const { child, lock, acquire } = fixture(t)
  const parent = child(`
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    import { readSync } from 'node:fs';
    await acquireLock(${JSON.stringify(lock)}, {onEvent(event) {
      if (event.stage === 'legacy-created') { process.send('paused'); readSync(0, Buffer.alloc(1),0,1,null); }
    }});
  `)
  const exited = once(parent, "exit")
  assert.equal((await once(parent, "message"))[0], "paused")
  parent.kill("SIGKILL"); await exited
  const next = await acquire({ timeoutMs: 1000, heartbeat: false })
  next.check()
})

test("retirement fences a delayed initializer before done, even if it dies on acquisition", { timeout: 60000 }, async (t) => {
  const { child, lock, acquire } = fixture(t)
  const ticket = join(`${lock}.queue`, "0000000000000001")
  const initializer = child(`
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    import { readSync } from 'node:fs';
    try {
      await acquireLock(${JSON.stringify(lock)}, { heartbeat: false, onEvent(event) {
        if (['before-initialization','legacy-created'].includes(event.stage)) {
          process.send(event.stage); readSync(0, Buffer.alloc(1),0,1,null);
        }
      }});
    } catch (error) { process.send({refused: error.message}); process.disconnect(); }
  `)
  const initializerExit = once(initializer, "exit")
  assert.equal((await once(initializer, "message"))[0], "before-initialization")
  const reclaimer = child(`
    import { finishTicket } from ${JSON.stringify(moduleUrl)};
    import { readFileSync, readSync } from 'node:fs';
    const owner = JSON.parse(readFileSync(${JSON.stringify(join(ticket, "owner.json"))}, 'utf8'));
    finishTicket(${JSON.stringify(ticket)}, ${JSON.stringify(lock)}, owner, 'reclaimed', event => {
      if (event.stage === 'retirement-checked') { process.send('inspected'); readSync(0,Buffer.alloc(1),0,1,null); }
    }); process.disconnect();
  `)
  const reclaimerExit = once(reclaimer, "exit")
  assert.equal((await once(reclaimer, "message"))[0], "inspected")
  const resumed = once(initializer, "message")
  initializer.stdin.write("x")
  const [result] = await resumed
  if (result === "legacy-created") initializer.kill("SIGKILL")
  else assert.match(result.refused, /lost|expired/)
  await initializerExit
  reclaimer.stdin.end("x"); assert.equal((await reclaimerExit)[0], 0)
  const next = await acquire({ timeoutMs: 1000, heartbeat: false })
  next.check()
})

test("a remote publication needs a termination receipt even after its deadline", (t) => {
  const { directory } = fixture(t)
  claimDecision(directory, "push")
  writeFileSync(join(directory, "publisher.json"), JSON.stringify({ host: "remote.fixture.invalid", pid: 2147483647, deadline: 1 }))
  assert.equal(publicationStopped(directory, Date.now() + 1e9), false)
  writeFileSync(join(directory, "publisher-stopped"), "confirmed")
  assert.equal(publicationStopped(directory, Date.now() + 1e9), true)
})

test("process-name-only or missing process observations never prove publication stopped", () => {
  const record = { pid: 42, token: "recorded-runner" }
  const liveGroup = "42 42 S\n43 42 S\n"
  assert.throws(() => groupSnapshot(record, liveGroup, "(node)\n"), /unconfirmed|unavailable/i)
  assert.throws(() => groupSnapshot(record, liveGroup, ""), /unconfirmed|unavailable/i)
  assert.throws(() => groupSnapshot(record, liveGroup, undefined), /unconfirmed|unavailable/i)
  assert.throws(() => groupSnapshot(record, ""), /unconfirmed|unavailable/i)
  assert.equal(groupSnapshot(record, liveGroup, "node runner recorded-runner"), true)
  assert.equal(groupSnapshot(record, "43 42 S\n"), true, "a dead group leader does not mean its child stopped")
  assert.equal(groupSnapshot(record, "42 42 Z\n43 42 Z\n"), false, "zombies cannot publish")
})

test("native acquisition never replaces an empty legacy mkdir lock", (t) => {
  const { directory, lock } = fixture(t)
  const prepared = join(directory, "prepared")
  mkdirSync(prepared); writeFileSync(join(prepared, "owner-test"), "prepared")
  mkdirSync(lock)
  const before = lstatSync(lock)
  const result = spawnSync("python3", [fileURLToPath(new URL("./claim-directory.py", import.meta.url)), prepared, lock], { encoding: "utf8" })
  assert.equal(result.status, 17, result.stderr)
  assert.equal(lstatSync(lock).ino, before.ino)
  assert.equal(existsSync(join(lock, "owner-test")), false)
  assert.equal(readFileSync(join(prepared, "owner-test"), "utf8"), "prepared")
})

test("a delayed acquisition helper cannot publish after its source is retired", { timeout: 60000 }, async (t) => {
  const { directory, child, lock } = fixture(t)
  const ticket = join(directory, "ticket"), prepared = join(ticket, "initialization/legacy-prepared")
  const owner = { token: "delayed-helper" }
  mkdirSync(prepared, { recursive: true })
  writeFileSync(join(ticket, "initialization/value"), JSON.stringify({ kind: "prepared", owner }))
  writeFileSync(join(prepared, `owner-${owner.token}`), "owned")
  const helper = child(`
    import { claimLegacy } from ${JSON.stringify(moduleUrl)};
    process.once('message', () => {
      try { claimLegacy(${JSON.stringify(prepared)}, ${JSON.stringify(lock)}); process.send('published'); }
      catch (error) { process.send(error.message); }
      process.disconnect();
    }); process.send('ready');
  `)
  const exited = once(helper, "exit")
  assert.equal((await once(helper, "message"))[0], "ready")
  const result = once(helper, "message")
  finishTicket(ticket, lock, owner, "reclaimed")
  helper.send("publish")
  assert.match((await result)[0], /atomic acquisition failed/)
  assert.equal((await exited)[0], 0)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(join(ticket, "legacy-retired", `owner-${owner.token}`)), true)
})

test("publication and revocation race on a complete immutable decision", { timeout: 60000 }, async (t) => {
  const { directory, child } = fixture(t)
  const workers = []
  for (let i = 0; i < 5; i++) {
    const worker = child(`
      import { claimDecision } from ${JSON.stringify(moduleUrl)};
      import { readFileSync } from 'node:fs';
      process.once('message', () => {
        const kind = ${JSON.stringify(i % 2 ? "revoked" : "push")};
        const won = claimDecision(${JSON.stringify(directory)}, kind);
        const observed = JSON.parse(readFileSync(${JSON.stringify(join(directory, "decision/value"))}, 'utf8')).kind;
        process.send({kind, won, observed}); process.disconnect();
      }); process.send('ready');
    `)
    const exited = once(worker, "exit")
    assert.equal((await once(worker, "message"))[0], "ready")
    workers.push({ worker, exited, result: once(worker, "message") })
  }
  for (const { worker } of workers) worker.send("claim")
  const results = await Promise.all(workers.map(async ({ result, exited }) => {
    const [value] = await result
    assert.equal((await exited)[0], 0)
    return value
  }))
  const winners = results.filter((result) => result.won)
  assert.equal(winners.length, 1)
  for (const result of results) assert.equal(result.observed, winners[0].kind)
})

test("a live heartbeat process which never becomes ready respects admission and cancellation", { timeout: 60000 }, async (t) => {
  const { directory, acquire, lock } = fixture(t)
  const program = join(directory, "stalled.mjs")
  writeFileSync(program, "process.on('message',()=>{}); process.send('stalled');")
  await assert.rejects(acquire({ timeoutMs: 100, heartbeatProgram: program }), /heartbeat.*timed out/i)
  assert.equal(existsSync(lock), false)
  const controller = new AbortController()
  const pending = acquire({ timeoutMs: 5000, signal: controller.signal, heartbeatProgram: program,
    onEvent(event) { if (event.stage === "heartbeat-spawned") controller.abort(new Error("startup cancelled")) }
  })
  await assert.rejects(pending, /startup cancelled/)
  assert.equal(existsSync(lock), false)
})

test("a push outliving its killed lander is terminated before another holder enters", { timeout: 60000 }, async (t) => {
  const { directory, child, lock, acquire } = fixture(t)
  const socket = join(directory, "push.sock"), marker = join(directory, "published")
  const connected = Promise.withResolvers(), closed = Promise.withResolvers()
  const server = createServer((connection) => {
    connection.once("close", () => closed.resolve())
    connected.resolve(connection)
  })
  t.after(() => server.close())
  server.listen(socket); await once(server, "listening")
  const command = `const net=require('node:net'),fs=require('node:fs'); const s=net.connect(${JSON.stringify(socket)}); s.on('data',()=>{fs.writeFileSync(${JSON.stringify(marker)},'unsafe');s.end()})`
  const parent = child(`
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    const release = await acquireLock(${JSON.stringify(lock)});
    await release.push(${JSON.stringify(process.execPath)}, ['-e',${JSON.stringify(command)}]);
    await release(); process.disconnect();
  `)
  const exited = once(parent, "exit")
  const connection = await Promise.race([connected.promise, exited.then(() => assert.fail("push never started"))])
  // The decision appears only as a complete, nonempty directory.
  const ticket = join(`${lock}.queue`, "0000000000000001")
  const decision = JSON.parse(readFileSync(join(ticket, "decision/value"), "utf8"))
  assert.equal(decision.kind, "push")
  parent.kill("SIGKILL"); await exited
  const next = await acquire({ timeoutMs: 10000 })
  await closed.promise
  connection.end("go")
  assert.equal(existsSync(marker), false, "the orphan must never publish under the successor's lease")
  next.check()
})

test("publication abort kills the supervised command before releasing exclusion", { timeout: 60000 }, async (t) => {
  const { directory, acquire, lock } = fixture(t)
  const controller = new AbortController()
  const first = await acquire({ signal: controller.signal })
  const socket = join(directory, "abort.sock")
  const connected = Promise.withResolvers(), closed = Promise.withResolvers()
  const server = createServer((connection) => { connection.once("close", () => closed.resolve()); connected.resolve() })
  server.listen(socket); await once(server, "listening")
  t.after(() => server.close())
  const pending = assert.rejects(first.push(process.execPath, ["-e", `require('node:net').connect(${JSON.stringify(socket)}).on('data',()=>{})`]), /cancel|interrupt|abort/i)
  await connected.promise
  controller.abort(new Error("publication cancelled"))
  await pending; await first(); await closed.promise
  assert.equal(existsSync(lock), false)
  const next = await acquire({ timeoutMs: 10000 })
  next.check()
})

for (const reason of ["deadline", "cancellation", "unconfirmed termination"]) test(`a stopped publication supervisor cannot block ${reason}`, { timeout: 20000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "land-stop-")), lock = join(directory, "main-push.lock")
  const controller = new AbortController(), connected = Promise.withResolvers(), closed = Promise.withResolvers()
  const socket = join(directory, "push.sock")
  const server = createServer((connection) => { connection.once("close", () => closed.resolve()); connected.resolve() })
  let lease, pending, supervisorPid, timer, record, ticket, supervisorStopped = false
  t.after(async () => {
    clearTimeout(timer)
    if (supervisorPid && !supervisorStopped) { try { process.kill(supervisorPid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error } }
    if (record) { writeFileSync(join(ticket, "publisher.json"), JSON.stringify(record)); killPublisher(record) }
    await pending?.catch(() => {})
    await lease?.().catch((error) => { if (reason !== "unconfirmed termination") throw error })
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  server.listen(socket); await once(server, "listening")
  lease = await acquireLock(lock, { signal: controller.signal, maxHoldMs: reason === "deadline" ? 1500 : 60000 })
  pending = lease.push(process.execPath, ["-e", `require('node:net').connect(${JSON.stringify(socket)}).on('data',()=>{})`])
  pending.catch(() => {})
  await Promise.race([connected.promise, pending.then(() => assert.fail("publication skipped its command"))])
  ticket = join(`${lock}.queue`, lease.ticket)
  record = JSON.parse(readFileSync(join(ticket, "publisher.json"), "utf8"))
  supervisorPid = record.supervisorPid
  process.kill(supervisorPid, "SIGSTOP")
  assert.match(spawnSync("ps", ["-o", "stat=", "-p", String(supervisorPid)], { encoding: "utf8" }).stdout.trim(), /^T/)
  if (reason === "unconfirmed termination") writeFileSync(join(ticket, "publisher.json"), JSON.stringify({ ...record, host: "remote.fixture.invalid" }))
  if (reason !== "deadline") controller.abort(new Error("publication cancelled"))
  const result = await Promise.race([
    pending.then(() => ({ success: true }), (error) => ({ error })),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stopped supervisor prevented publication settlement")), reason === "unconfirmed termination" ? 10000 : 5000) })
  ])
  clearTimeout(timer)
  supervisorStopped = true // The publication promise observes the supervisor's actual exit.
  const stop = JSON.parse(readFileSync(join(ticket, "publisher-stop-requested"), "utf8"))
  assert.equal(stop.kind, reason === "deadline" ? "deadline" : "cancellation")
  assert.equal(stop.supervisorPid, supervisorPid)
  if (reason === "unconfirmed termination") {
    assert.match(result.error?.message ?? "unexpected success", /termination is not confirmed; lock retained/)
    await assert.rejects(lease(), /termination is not confirmed; lock retained/)
    assert.equal(existsSync(lock), true)
    assert.equal(existsSync(join(ticket, "done")), false)
    await assert.rejects(acquireLock(lock, { timeoutMs: 0, heartbeat: false }), /queue timed out/)
    await closed.promise
    return
  }
  assert.match(result.error?.message ?? "unexpected publication success", /deadline|cancel/i)
  await lease(); await closed.promise
  assert.equal(existsSync(lock), false)
  const proof = JSON.parse(readFileSync(join(ticket, "publisher-stopped"), "utf8"))
  assert.equal(proof.proof, "local-group-probe", "the parent must confirm termination independently")
  const next = await acquireLock(lock, { timeoutMs: 1000 })
  next.check(); await next()
})
