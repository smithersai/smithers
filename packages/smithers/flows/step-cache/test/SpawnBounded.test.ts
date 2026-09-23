/**
 * The bound every synchronous child in this package runs under. Without it a
 * wedged fixture blocks the worker forever: Vitest's own timeout is a timer
 * on the event loop that `spawnSync` is holding, so it never fires.
 */
import { describe, expect, it } from "vitest"
import { spawnBounded } from "./helpers/spawnBounded.ts"

describe("spawnBounded", () => {
  it("kills a wedged child at its budget and reports what it left behind", () => {
    expect(() =>
      spawnBounded(
        ["--eval", "process.stderr.write('stuck in fixture'); setInterval(() => {}, 1000)"],
        1_000
      )
    ).toThrow(/ETIMEDOUT[\s\S]*status null, signal SIGKILL[\s\S]*stuck in fixture/)
  })

  it("hands back a child that ended on its own, signal and all", () => {
    const died = spawnBounded([
      "--eval",
      "process.on('exit', () => process.stdout.write('unexpected clean exit')); process.kill(process.pid, 'SIGKILL')"
    ], 10_000)
    // libuv's Windows self-kill uses TerminateProcess(1); only a parent kill
    // records exit_signal in the parent's process handle.
    expect(died.signal).toBe(process.platform === "win32" ? null : "SIGKILL")
    expect(died.status).toBe(process.platform === "win32" ? 1 : null)
    expect(died.stdout).toBe("")

    const exited = spawnBounded(["--eval", "process.stdout.write('done'); process.exitCode = 3"], 10_000)
    expect(exited.status).toBe(3)
    expect(exited.stdout).toBe("done")
  })
})
