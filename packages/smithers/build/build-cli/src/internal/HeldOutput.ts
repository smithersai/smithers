/**
 * What still holds a recorded command's output on this host, read from
 * `/proc`, for a run that must not wait on it once its recorder has ended
 * (`Exec.HeldOutput`). Only processes of this user can be read, and only
 * they are ended.
 *
 * @since 1.0.0
 */

import type * as Exec from "@smthrs/targets/Exec"
import * as NodeFs from "node:fs"

/** A link that names a pipe or a socket, which only the processes that share it hold. */
const owned = /^(pipe|socket):\[\d+\]$/

/** The link of one descriptor, or nothing when it cannot be read. */
const linkOf = (path: string): string | undefined => {
  try {
    return NodeFs.readlinkSync(path)
  } catch {
    return undefined
  }
}

/**
 * Reads output links and their holders under `proc`, and ends a process
 * with `kill`: `/proc` and `process.kill` on a host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  proc: string,
  kill: (pid: number) => void
): Exec.HeldOutput => ({
  // Only a pipe or a socket is the command's own: a file such as /dev/null is held by every other process too.
  links: (pid) => [1, 2].flatMap((fd) => linkOf(`${proc}/${pid}/fd/${fd}`) ?? []).filter((link) => owned.test(link)),
  holders: (links) => {
    let entries: ReadonlyArray<string>
    try {
      entries = NodeFs.readdirSync(proc)
    } catch {
      return undefined
    }
    const wanted = new Set(links)
    return entries.filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid).filter((pid) => {
      let fds: ReadonlyArray<string>
      try {
        fds = NodeFs.readdirSync(`${proc}/${pid}/fd`)
      } catch {
        return false
      }
      return fds.some((fd) => wanted.has(linkOf(`${proc}/${pid}/fd/${fd}`) ?? ""))
    }).map(Number)
  },
  kill: (pid) => {
    try {
      kill(pid)
    } catch {
      // Gone already, or not this user's.
    }
  }
})

/**
 * This host's: `/proc`, and SIGKILL.
 *
 * @category constants
 * @since 1.0.0
 */
export const live: Exec.HeldOutput = make("/proc", (pid) => process.kill(pid, "SIGKILL"))
