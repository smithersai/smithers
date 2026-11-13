/**
 * Synchronous native signal operations. Production uses the kernel; fault
 * suites inject a refusing operation without replacing process globals.
 * @since 1.0.0
 */

import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import type { Liveness, Refusal, System } from "../ProcessReaper.ts"

const errorCode = (cause: unknown): string | undefined => (cause as { readonly code?: string } | null)?.code

/**
 * Whether a durable record names a POSIX process group this host may signal.
 *
 * `process.kill(-pgid, ...)` turns the stored number into a target directly, so
 * every value that is not a real foreign group has to be refused before it gets
 * there: `0` signals THIS process's group, a negative value stops naming a
 * group at all and names a single pid, and a `pgid` that differs from `pid`
 * describes a child that does not lead the group it claims —
 * `ContainedSpawner.groupOf` writes `pgid === pid` for every detached POSIX
 * child, so anything else is a record no writer in this repository produced.
 */

const refusePosixTarget = (record: ProcessLedger.ProcessRecord): Refusal | undefined => {
  if (record.pgid === null) return "no-group"
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1) return "invalid-record"
  if (!Number.isSafeInteger(record.pgid) || record.pgid <= 1) return "invalid-record"
  return record.pgid === record.pid ? undefined : "invalid-record"
}

/**
 * Kernel liveness, retaining ambiguity when a signal cannot be authorized.
 * @private
 * @since 1.0.0
 */
export const liveness = (
  pid: number,
  kill: typeof process.kill = (pid, signal) => process.kill(pid, signal)
): Liveness => {
  try {
    // Signal 0 delivers nothing; it only asks whether the pid is signalable.
    kill(pid, 0)
    return "alive"
  } catch (cause) {
    // ESRCH is the only answer that means gone. EPERM means the process
    // exists and belongs to another user; anything else is a question this
    // host could not ask, and both keep the record rather than kill on it.
    return errorCode(cause) === "ESRCH" ? "dead" : "unknown"
  }
}

/**
 * The POSIX kill path over whichever probes the platform answers with.
 * @private
 * @since 1.0.0
 */
export const posixSystemFrom = (
  probes: Pick<System, "startedAtMs" | "ownGroup" | "bootedAtMs">,
  ownerPid: number,
  kill: typeof process.kill = (pid, signal) => process.kill(pid, signal)
): System => {
  const readOwnGroup = probes.ownGroup
  return {
    isAlive: (pid) => liveness(pid, kill),
    startedAtMs: probes.startedAtMs,
    ownGroup: readOwnGroup,
    bootedAtMs: probes.bootedAtMs,
    refuseTarget: refusePosixTarget,
    killTree: (record) => {
      // Repeated here and not only in `refuse`: this function is exported, and
      // the negation below is the one place a stored number becomes a signal.
      if (refusePosixTarget(record) !== undefined) return "failed"
      // The host's own identity, repeated for the same reason. `refuse` holds
      // one `ownGroup` reading for the whole sweep; a caller that reaches this
      // function directly has made no such reading, and `process.kill(-pgid)`
      // does not care which way the number arrived. A group that cannot be
      // read is a comparison that did not happen, so nothing is signalled.
      if (record.pid === ownerPid || record.pgid === ownerPid) return "failed"
      const group = readOwnGroup()
      if (group === null || record.pid === group || record.pgid === group) return "failed"
      try {
        kill(-(record.pgid as number), "SIGKILL")
        return "signalled"
      } catch (cause) {
        // The group settled between the liveness check and the signal: the end
        // state is the one that was wanted. Anything else is a kill that did NOT
        // happen, and saying so is what gets the record tried again.
        return errorCode(cause) === "ESRCH" ? "already-gone" : "failed"
      }
    }
  }
}

/**
 * Only ESRCH proves a process group vacant.
 * @private
 * @since 1.0.0
 */
export const groupVacant = (
  pgid: number,
  kill: typeof process.kill = (pid, signal) => process.kill(pid, signal)
): boolean => {
  // kill(0) and kill(-1) address the caller's group and every process.
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false
  try {
    kill(-pgid, 0)
    return false
  } catch (cause) {
    return errorCode(cause) === "ESRCH"
  }
}
