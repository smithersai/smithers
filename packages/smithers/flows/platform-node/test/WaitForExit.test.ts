/**
 * The exit observation both integration suites assert with.
 *
 * These suites kill process groups and then claim the pids are gone, so the
 * helper deciding "gone" is load-bearing: read it wrongly and a correctly
 * contained process fails the suite, or a process that is still running passes
 * it. The two cases signal 0 alone gets wrong are pinned here with real
 * processes — a terminated child nobody reaped, and a pid this process is not
 * allowed to signal.
 */
import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawn } from "node:child_process"
import { waitForExit } from "./helpers/waitForExit.ts"

const stat = (pid: number): string => {
  try {
    return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
    }).trim()
  } catch {
    return "gone"
  }
}

/**
 * A terminated child whose parent will never reap it.
 *
 * `Atomics.wait` blocks the parent's loop forever, so libuv never runs the
 * `SIGCHLD` reap — the same table entry a container's non-reaping PID 1 leaves
 * behind for an orphan, produced without waiting on one.
 */
const unreapedChild = async (): Promise<{ pid: number; release: () => void }> => {
  const parent = spawn(process.execPath, [
    "-e",
    "const{spawn}=require('node:child_process');const{writeSync}=require('node:fs');" +
    "const c=spawn('/bin/sh',['-c','exit 0'],{stdio:'ignore'});" +
    "c.on('spawn',()=>{writeSync(1,`${c.pid}\\n`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)})"
  ], { stdio: ["ignore", "pipe", "inherit"] })
  const release = () => parent.kill("SIGKILL")
  try {
    let text = ""
    for await (const chunk of parent.stdout) {
      text += String(chunk)
      if (text.includes("\n")) break
    }
    return { pid: Number(text.trim()), release }
  } catch (cause) {
    release()
    throw cause
  }
}

describe.skipIf(process.platform === "win32")("waitForExit", () => {
  it("reads a terminated child nobody has reaped as exited", { timeout: 20_000 }, async () => {
    const zombie = await unreapedChild()
    try {
      const deadline = Date.now() + 5000
      while (stat(zombie.pid) !== "Z" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
      // The fixture only proves anything while the entry is really unreaped.
      expect(stat(zombie.pid), `pid ${zombie.pid} never became a zombie`).toBe("Z")
      // Signal 0 still succeeds here, which is why it cannot be the criterion.
      expect(() => process.kill(zombie.pid, 0)).not.toThrow()
      const started = Date.now()
      expect(await waitForExit(zombie.pid, 2_000)).toBe(true)
      // Answered from the state, not by exhausting the budget.
      expect(Date.now() - started).toBeLessThan(1_500)
    } finally {
      zombie.release()
    }
  })

  it("never claims a pid it may not signal has exited", async () => {
    // PID 1 outlives every test. An unprivileged signal 0 answers `EPERM`,
    // which says the process is alive and belongs to someone else.
    const observed = await waitForExit(1, 50).then(
      (exited) => ({ exited, failure: undefined }),
      (cause: Error) => ({ exited: undefined, failure: cause.message })
    )
    expect(observed.exited, observed.failure).not.toBe(true)
    if (observed.failure !== undefined) expect(observed.failure).toContain("cannot observe pid 1")
  })

  it("reports a pid whose process really has gone", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" })
    const pid = child.pid as number
    await new Promise<void>((resolve) => child.on("close", () => resolve()))
    expect(await waitForExit(pid, 2_000)).toBe(true)
  })

  it("reports a running process as still running when the budget runs out", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" })
    const pid = child.pid as number
    try {
      expect(await waitForExit(pid, 100)).toBe(false)
    } finally {
      child.kill("SIGKILL")
    }
    expect(await waitForExit(pid, 2_000)).toBe(true)
  })
})
