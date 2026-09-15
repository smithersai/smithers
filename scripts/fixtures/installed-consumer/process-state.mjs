/** One targeted kernel snapshot for a fixture's parent, group and stop assertions. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

export const processStates = (pids) => {
  const selected = new Set(pids)
  assert.ok(selected.size > 0)
  for (const pid of selected) assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid fixture PID: ${pid}`)
  // A mixed shell/MCP assertion replaces at least four separate ps calls.
  // Use the production identity probe's 5 s allowance for their one snapshot;
  // never turn an execution failure into an apparently missing parent PID.
  const result = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", [...selected].join(",")], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL"
  })
  assert.equal(result.error, undefined, `Process snapshot failed: ${result.error?.message ?? ""}\n${result.stderr}`)
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return new Map()
  assert.equal(result.status, 0, result.stderr)
  const states = new Map()
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    assert.ok(match, `Invalid process snapshot row: ${line}`)
    const [, pid, parent, group, state] = match
    assert.ok(selected.has(Number(pid)), `Unrequested process in snapshot: ${pid}`)
    states.set(Number(pid), { parent: Number(parent), group: Number(group), stopped: state.startsWith("T") })
  }
  return states
}
