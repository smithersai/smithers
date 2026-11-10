/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { execFileSync } from "node:child_process"

/**
 * Every process on the host as `ps` prints it, or `undefined` when `ps` can't answer.
 *
 * @private
 * @since 1.0.0
 */
export const processTable = (): string | undefined => {
  try {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,time=,lstart="], {
      env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return undefined
  }
}

/**
 * Whether `pid` still exists.
 *
 * @private
 * @since 1.0.0
 */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as { readonly code?: string }).code !== "ESRCH"
  }
}

/**
 * Sends `signal` to `pid`.
 *
 * @private
 * @since 1.0.0
 */
export const kill = (pid: number, signal: NodeJS.Signals): void => {
  process.kill(pid, signal)
}
