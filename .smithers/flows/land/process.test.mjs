import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runProcess, boundedSpawnSync, withProcessDeadline } from "./process.mjs"

test("real child output and status are retained without shell interpolation", async () => {
  const result = await runProcess(process.execPath, ["-e", "console.log(process.argv[1]); console.error('err'); process.exit(7)", "$(never run)"])
  assert.equal(result.stdout, "$(never run)\n")
  assert.equal(result.stderr, "err\n")
  assert.equal(result.status, 7)
})
test("bounds hung processes and output; nonexistent executables fail clearly", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }), /timed out/)
  await assert.rejects(runProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { maxBytes: 20 }), /output exceeded/)
  await assert.rejects(runProcess("/nonexistent-devx-command", []), /ENOENT/)
})
test("abort before and during execution stops only the new process group", async () => {
  const before = new AbortController()
  before.abort(new Error("before"))
  await assert.rejects(runProcess(process.execPath, ["-e", "0"], { signal: before.signal }), /before/)
  const during = new AbortController()
  const running = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: during.signal })
  setTimeout(() => during.abort(new Error("during")), 50)
  await assert.rejects(running, /during/)
})


test("a synchronous gate deadline bounds descendant-held output pipes", () => {
  const started = Date.now(), controller = new AbortController()
  assert.throws(() => withProcessDeadline({ at: started + 150, signal: controller.signal, expired: () => new Error("gate expired") }, () => boundedSpawnSync(process.execPath, ["-e", `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'});setInterval(()=>{},1000)`])), /gate expired/)
  assert.ok(Date.now() - started < 1000, "descendants must not extend the gate deadline")
})

test("cancellation escalates to SIGKILL for a descendant that outlives the direct child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "land-process-")), pidFile = join(dir, "descendant.pid")
  // The descendant ignores SIGTERM and holds none of the parent's output pipes, so the direct child's close comes first.
  const descendant = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"
  const parent = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{c.disconnect();writeFileSync(process.argv[1],String(c.pid))});setInterval(()=>{},1000)`
  const pidOf = () => { try { return Number(readFileSync(pidFile, "utf8")) } catch { return undefined } }
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" } }
  const controller = new AbortController()
  const running = runProcess(process.execPath, ["-e", parent, pidFile], { signal: controller.signal, timeoutMs: 20000 })
  let pid
  try {
    while (!(pid = pidOf())) await new Promise((done) => setTimeout(done, 20))
    controller.abort(new Error("cancelled"))
    await assert.rejects(running, /cancelled/)
    const settled = Date.now()
    while (alive(pid) && Date.now() - settled < 1000) await new Promise((done) => setTimeout(done, 20))
    assert.equal(alive(pid), false, "a SIGTERM-ignoring descendant must be killed before cancellation settles")
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    rmSync(dir, { recursive: true, force: true })
  }
})
