import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import { waitForServe } from "./serve-startup.ts"

const launch = async (t, mode) => {
  const child = spawn(process.execPath, [new URL("../fixtures/readiness-server.mjs", import.meta.url).pathname, mode], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGKILL")
      await closed
    }
  })
  const [{ port }] = await once(child, "message")
  return { child, port, timeoutMs: 5_000, command: "readiness-server " + mode, output: () => "startup diagnostic" }
}

for (const mode of ["headers", "body"]) {
  test("startup bounds a stalled " + mode + " response and reaps its child", { timeout: 10_000 }, async t => {
    const { child, ...options } = await launch(t, mode)
    // Start the deadline only after the real HTTP child has bound its port.
    const request = once(child, "message")
    const started = Date.now()
    const pending = waitForServe(child, { ...options, timeoutMs: 500 })
    const rejected = assert.rejects(pending, /never answered.*500ms[\s\S]*startup diagnostic/)
    const [receipt] = await request
    assert.equal(receipt.request, 1)
    await rejected
    assert.ok(Date.now() - started < 5_000)
    assert.equal(child.signalCode, "SIGKILL")
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
  })
}

test("cancellation during a stalled response reaps the owned child", async t => {
  const { child, ...options } = await launch(t, "body")
  const controller = new AbortController()
  const request = once(child, "message")
  const pending = waitForServe(child, { ...options, signal: controller.signal })
  const rejected = assert.rejects(pending, /cancel startup/)
  await request
  controller.abort(new Error("cancel startup"))
  await rejected
  assert.equal(child.signalCode, "SIGKILL")
})

test("an already cancelled startup reaps its child without probing", async t => {
  const { child, ...options } = await launch(t, "headers")
  await assert.rejects(waitForServe(child, { ...options, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/)
  assert.equal(child.signalCode, "SIGKILL")
})

test("an early child exit fails promptly with the exit code", async t => {
  const { child, ...options } = await launch(t, "exit")
  await assert.rejects(waitForServe(child, options), /exited with 17/)
  assert.equal(child.exitCode, 17)
})

test("spawn errors are reported after the failed child closes", async () => {
  const child = spawn(process.execPath, [], { cwd: new URL("./missing-directory", import.meta.url).pathname })
  await assert.rejects(waitForServe(child, {
    port: 1, timeoutMs: 5_000, command: "missing cwd", output: () => "",
  }), /ENOENT/)
  assert.equal(child.pid, undefined)
})

test("a 404 is retried and success transfers a still live child to its caller", async t => {
  const { child, ...options } = await launch(t, "retry")
  const receipts = []
  child.on("message", value => receipts.push(value))
  await waitForServe(child, options)
  assert.deepEqual(receipts.map(value => value.request), [1, 2])
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  process.kill(child.pid, 0)
})
