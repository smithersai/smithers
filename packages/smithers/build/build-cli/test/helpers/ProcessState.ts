/**
 * What a process is, for the message of a test that expected it gone: its name, state and parent from
 * `/proc/<pid>/status`, or that the kernel has no entry for it. A zombie (state Z) has ended and waits for its
 * parent or the namespace's first process to reap it; any other state is a process still running.
 */
import { readFileSync } from "node:fs"

export const processState = (pid: number): string => {
  let status: string
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8")
  } catch {
    return `pid ${pid}: no /proc entry`
  }
  const field = (name: string): string => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1] ?? "?"
  return `pid ${pid}: ${field("Name")}, state ${field("State")}, parent ${field("PPid")}`
}
