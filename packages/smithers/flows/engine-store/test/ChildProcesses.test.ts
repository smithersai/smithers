import { afterEach, expect, it } from "vitest"
import * as ChildProcesses from "./ChildProcesses.ts"

afterEach(ChildProcesses.reap)

const launch = (script: string) =>
  ChildProcesses.spawn(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }
  })
const options = { timeoutMs: 5_000, description: "durable frontier" }
const ready = (line: string) => line === "ready-to-kill"
const listeners = (child: ReturnType<typeof launch>) => [
  child.stdout.listenerCount("data"),
  child.stderr.listenerCount("data"),
  child.listenerCount("error"),
  child.listenerCount("exit")
]

it("waits for a complete marker split across chunks, ignoring telemetry and removing its listeners", async () => {
  const child = launch(String.raw`
    process.stdout.write("telemetry\nready-to-");
    setTimeout(() => process.stdout.write("kill\n"), 10);
    setInterval(() => {}, 1000);
  `)
  const before = listeners(child)
  expect(await ChildProcesses.waitForLine(child, ready, options)).toBe("ready-to-kill")
  expect(listeners(child)).toEqual(before)
})

it("reports an early exit with stderr and stdout instead of waiting for the deadline", async () => {
  const child = launch(
    String.raw`process.stdout.write("last message\n"); process.stderr.write("storage failed"); process.exitCode = 7`
  )
  const before = listeners(child)
  await expect(ChildProcesses.waitForLine(child, ready, options)).rejects.toThrow(
    /child exited before durable frontier with 7\nstorage failed\nlast message/
  )
  expect(listeners(child)).toEqual(before)
})

it("times out a live child and removes its listeners so teardown can reap it", async () => {
  const child = launch("setInterval(() => {}, 1000)")
  const before = listeners(child)
  await expect(ChildProcesses.waitForLine(child, ready, { ...options, timeoutMs: 20 })).rejects.toThrow(
    "child did not reach durable frontier"
  )
  expect(listeners(child)).toEqual(before)
})

it("propagates a spawn error and removes its listeners", async () => {
  const child = ChildProcesses.spawn("missing-child-process-test-executable", [], { env: {} })
  const before = listeners(child)
  await expect(ChildProcesses.waitForLine(child, ready, options)).rejects.toMatchObject({ code: "ENOENT" })
  expect(listeners(child)).toEqual(before)
})

it("refuses an already exited child without waiting for the deadline", async () => {
  const child = launch("process.exit(0)")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  await expect(ChildProcesses.waitForLine(child, ready, options)).rejects.toThrow(
    "child exited before durable frontier with 0"
  )
})
