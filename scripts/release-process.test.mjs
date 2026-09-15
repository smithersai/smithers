import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { processStates } from "./fixtures/installed-consumer/process-state.mjs"
import { captureProcess } from "./release-process.mjs"

const node = (source, options) => captureProcess(process.execPath, ["--eval", source], process.cwd(), options)

test("drains all output before classifying a successful release probe", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000)); process.stderr.write("end")')
  assert.deepEqual(result, { ok: true, output: "x".repeat(200_000) + "end" })
})

test("a nonzero probe retains its diagnostics and failing outcome", async () => {
  const result = await node('process.stdout.write("partial"); process.stderr.write("failure"); process.exitCode = 9')
  assert.equal(result.ok, false)
  assert.ok(result.output.startsWith("partialfailure"))
})

test("noninteractive probes receive EOF instead of waiting for input", async () => {
  const result = await node('process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()', {
    timeoutMs: 5000
  })
  assert.deepEqual(result, { ok: true, output: "eof" })
})

test("an executable that cannot start produces a useful failed result", async () => {
  const result = await captureProcess("/nonexistent/smthrs-release-probe", [], process.cwd())
  assert.equal(result.ok, false)
  assert.match(result.output, /ENOENT/)
})

test("a probe that never terminates is killed within its budget", async () => {
  const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.match(result.output, /Command failed/)
})

test("excessive probe output fails rather than growing the gate without bound", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000))', { maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.match(result.output, /maxBuffer/)
  assert.ok(result.output.length < 8192)
})

test("a targeted process snapshot agrees with a real child's recorded parent and inherited group", async (t) => {
  const child = spawn(process.execPath, ["--eval", `
    process.on("message", () => {})
    process.send({ pid: process.pid, parent: process.ppid })
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  const [recorded] = await once(child, "message")
  const snapshot = processStates([process.pid, recorded.pid])
  assert.deepEqual([...snapshot.keys()].sort((a, b) => a - b), [process.pid, recorded.pid].sort((a, b) => a - b))
  assert.equal(snapshot.get(process.pid).parent, process.ppid)
  assert.equal(snapshot.get(recorded.pid).parent, recorded.parent)
  assert.equal(recorded.parent, process.pid)
  assert.equal(snapshot.get(recorded.pid).group, snapshot.get(process.pid).group)
  assert.equal(snapshot.get(recorded.pid).stopped, false)
  assert.throws(() => processStates([1]), /Invalid fixture PID/)
})
