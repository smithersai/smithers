/**
 * Waits for a pid to stop being a process that can still run.
 *
 * Signal 0 alone cannot answer that question. A process that has already run
 * its last instruction stays signalable until its parent reaps it, and the
 * followers these integration suites create are deliberately abandoned: their
 * group leader is killed with them, so whatever adopts them decides when their
 * entries leave the table. Under a PID 1 that does not promptly reap orphans —
 * the usual case inside a Linux container — a correctly contained follower
 * stays signalable for the whole budget, and a helper that reads that as
 * "still running" fails a suite whose subject succeeded. Its scheduler state
 * is the answer instead, exactly as `LeaderExit.integration.test.ts` reads it.
 *
 * The other half is the same rule the reaper's own liveness check applies:
 * `ESRCH` is the only signal error that means gone. `EPERM` says the process
 * is alive and belongs to another user, and any other code is a question this
 * host could not ask; treating either as an exit would let this helper report
 * that pid 1 has died.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** How often the pid is probed with a signal, which costs nothing. */
const pollMs = 10

/** How often the state probe runs, which spawns `ps` on most platforms. */
const statePollMs = 100

/** How long the state probe may take before it counts as an answer nobody gave. */
const stateTimeoutMs = 2000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const errorCode = (cause: unknown): string | undefined => (cause as { readonly code?: string } | null)?.code

/** The scheduler state behind a pid, or `undefined` when it could not be read. */
const state = (pid: number): string | undefined => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      // The `comm` field is parenthesised and may itself contain spaces, so
      // the state is the first field after the LAST closing parenthesis.
      return stat.slice(stat.lastIndexOf(") ") + 2).trimStart().charAt(0)
    } catch {
      // No `/proc` mounted, or the pid left between the two probes; ask `ps`.
    }
  }
  try {
    return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: stateTimeoutMs,
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
    }).trim()
  } catch {
    // A `ps` that refused says nothing about the pid; the signal probe decides.
    return undefined
  }
}

/**
 * Whether `pid` reached a terminated state within `budgetMs`.
 *
 * `false` means the pid still names a running process at the deadline. A pid
 * this process could not observe at all throws rather than answering, so a
 * permission error is never mistaken for either verdict.
 */
export const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  let nextStateProbe = Date.now()
  for (;;) {
    let refused: unknown
    try {
      process.kill(pid, 0)
    } catch (cause) {
      if (errorCode(cause) === "ESRCH") return true
      refused = cause
    }
    const expired = Date.now() > deadline
    if (refused === undefined && (expired || Date.now() >= nextStateProbe)) {
      nextStateProbe = Date.now() + statePollMs
      // A zombie is a pid that outlived its process, not a process that runs.
      if (state(pid)?.startsWith("Z") === true) return true
    }
    if (expired) {
      if (refused !== undefined) {
        throw new Error(`cannot observe pid ${pid}: ${errorCode(refused) ?? String(refused)}`, { cause: refused })
      }
      return false
    }
    await sleep(pollMs)
  }
}
