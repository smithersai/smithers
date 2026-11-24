/** Process-owned configuration locks.
 * @since 1.0.0
 */

import { randomUUID } from "node:crypto"
import { linkSync, lstatSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { errorCode } from "./ErrorCode.ts"
/**
 * Age after which a lock carrying no owner is treated as abandoned.
 *
 * Only a lock written by 0.x, or by a process killed between creating the file
 * and naming itself in it, has no owner to ask about. Registration takes
 * milliseconds, so nothing this old is still being written.
 */
const ORPHAN_LOCK_MS = 5 * 60_000

/** Why the lock could not be taken, in the words the operator sees. */
interface Refusal {
  readonly reason: string
}

/** The process recorded in a lock, when it recorded one at all. */
const lockOwner = (token: string): number | undefined => {
  const separator = token.indexOf(":")
  const pid = Number(token.slice(0, separator < 0 ? token.length : separator))
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Whether the recorded owner is still running.
 *
 * Only `ESRCH` proves absence: a process owned by another user answers
 * `EPERM`, and reading that as death would delete a live owner's lock. A
 * recycled pid can only make a dead owner look alive, which costs a retry.
 */
const lockOwnerAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== "ESRCH"
  }
}

/**
 * Creates the lock with its owner already inside it, or reports it taken.
 *
 * The owner arrives by hard link rather than by a write after `openSync`,
 * because a crash between those two calls is exactly what leaves a lock nobody
 * can prove is dead.
 */
const claimLock = (lockPath: string, token: string): boolean => {
  const claim = `${lockPath}.${process.pid}.${randomUUID()}`
  writeFileSync(claim, token, { encoding: "utf8", flag: "wx", mode: 0o600 })
  try {
    linkSync(claim, lockPath)
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    try {
      unlinkSync(claim)
    } catch {
      // The scratch file is already gone, which is the outcome this wanted.
    }
  }
}

/**
 * Removes a lock whose owner is provably gone.
 *
 * Answers a refusal, naming the lock file, whenever the lock has to stand:
 * removing one still held would let two processes rewrite the configuration at
 * once, so an owner that cannot be shown to be dead keeps it.
 */
const reclaimLock = (lockPath: string, path: string): Refusal | undefined => {
  let observed: string
  let age: number
  try {
    const stats = lstatSync(lockPath)
    if (stats.isDirectory()) {
      if (Date.now() - stats.mtimeMs < ORPHAN_LOCK_MS) return { reason: `${path} is being changed by another process` }
      rmdirSync(lockPath)
      return undefined
    }
    observed = readFileSync(lockPath, "utf8")
    age = Date.now() - stats.mtimeMs
  } catch (error) {
    // Gone between the failed claim and this read: the caller claims again.
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
  const owner = lockOwner(observed)
  if (owner !== undefined && lockOwnerAlive(owner)) {
    return {
      reason: `${path} is being updated by another Smithers process (pid ${owner}). No change was written; ` +
        `run this again once it exits, or delete ${lockPath} if that process is gone.`
    }
  }
  if (owner === undefined && age < ORPHAN_LOCK_MS) {
    return {
      reason: `${path} is being updated by another Smithers process. No change was written; run this again, ` +
        `or delete ${lockPath} if no other Smithers process is running.`
    }
  }
  try {
    // The recovery guard excludes other recoverers through the next claim.
    // Keep the token check for a fast-path acquirer that won before this read.
    if (readFileSync(lockPath, "utf8") === observed) unlinkSync(lockPath)
  } catch {
    // Another process recovered it first, which is the outcome this wanted.
  }
  return undefined
}

/** Takes the registration lock, recovering one left by a dead process.
 * @private
 * @since 1.0.0
 */
export const acquireLock = (lockPath: string, path: string, token: string): Refusal | undefined => {
  if (claimLock(lockPath, token)) return undefined
  // Serialize stale observations through removal AND the following claim.
  // A second recoverer must never unlink a lock acquired after its stale read.
  // Recovery-guard crashes fail closed; the refusal names the guard for repair.
  const recoveryPath = `${lockPath}.recovery`
  if (!claimLock(recoveryPath, token)) {
    return {
      reason: `${path} lock recovery is already in progress. No change was written; ` +
        `run this again, or delete ${recoveryPath} if no Smithers process is running.`
    }
  }
  try {
    const refusal = reclaimLock(lockPath, path)
    if (refusal !== undefined) return refusal
    if (claimLock(lockPath, token)) return undefined
    return {
      reason: `${path} is being updated by another Smithers process. No change was written; run this again, ` +
        `or delete ${lockPath} if no other Smithers process is running.`
    }
  } finally {
    releaseLock(recoveryPath, token)
  }
}

/** Removes only the lock this call took, never a replacement.
 * @private
 * @since 1.0.0
 */
export const releaseLock = (lockPath: string, token: string): void => {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
  } catch {
    // Best effort: a recovery may have replaced this token, and deleting the
    // new owner's lock would reopen the race the lock exists to close.
  }
}
