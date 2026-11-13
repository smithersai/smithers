/**
 * Bounded POSIX process-table observation.
 * @since 1.0.0
 */

import { spawnSync } from "node:child_process"
import type * as ProcessCleanup from "./ProcessCleanup.ts"
const cleanupProbeTimeoutMs = 2000
/**
 * Reads identities through a configured fixed-path executable.
 * @private
 * @since 1.0.0
 */
export const psGroupSnapshot = (executable: string) => (pgid: number): ProcessCleanup.Snapshot | undefined => {
  const result = spawnSync(executable, ["-A", "-o", "pid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: cleanupProbeTimeoutMs,
    killSignal: "SIGKILL",
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" }
  })
  if (result.error !== undefined || result.signal !== null || result.status !== 0) return undefined
  let own: number | undefined
  const members: Array<ProcessCleanup.Member> = []
  for (const line of result.stdout.trim().split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s+(.+)$/.exec(line)
    if (match === null) return undefined
    const pid = Number(match[1])
    const group = Number(match[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group)) return undefined
    if (pid === process.pid) own = group
    if (group !== pgid) continue
    const started = Date.parse(`${match[4]!} UTC`)
    if (Number.isNaN(started)) return undefined
    members.push({ pid, startedAtMs: started, zombie: match[3]!.startsWith("Z") })
  }
  return own === undefined || own <= 0 ? undefined : { ownGroup: own, members }
}
