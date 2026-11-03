/**
 * Real child processes for tests, each in its own process group, reaped in teardown.
 *
 * A test that times out stops awaiting its child, so a `finally` that kills the
 * child has not run, and Vitest stops a fork with SIGTERM, which runs no `exit`
 * handler. The orphan then outlives the run by days. Every child here leads its
 * own process group, is tracked until teardown, and `reap` kills the whole group
 * (grandchildren included) and waits for the leader to exit. A worker that ends
 * without teardown kills every tracked group from its `exit` and signal handlers.
 * A worker that SIGKILL ends runs nothing: `test-process-environment.mjs` reaps
 * those orphans when the run closes.
 */
import {
  type ChildProcess,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  spawn as spawnChild,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe
} from "node:child_process"
import type { Readable, Writable } from "node:stream"

const live = new Set<ChildProcess>()

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

/** Signals the child's whole process group. False when the group is already gone. */
export const killGroup = (child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): boolean => {
  if (child.pid === undefined) return false
  try {
    return process.kill(-child.pid, signal)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    return false
  }
}

/** Kills the child's process group and resolves once the leader has exited. */
export const kill = async (child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> => {
  // Listen before signalling: the exit can arrive before the next turn.
  const done = exited(child) || child.pid === undefined
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()))
  killGroup(child, signal)
  await done
  // The leader is gone; a grandchild it left in the group is not.
  killGroup(child, "SIGKILL")
  live.delete(child)
}

/** Kills every child this module started and has not reaped. For `afterEach` or `afterAll`. */
export const reap = async (): Promise<void> => {
  await Promise.all([...live].map((child) => kill(child)))
}

/** The pids of the children still running. */
export const pids = (): ReadonlyArray<number> =>
  [...live].flatMap((child) => child.pid === undefined || exited(child) ? [] : [child.pid])

const killLive = (): void => {
  for (const child of live) killGroup(child)
}

process.once("exit", killLive)
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    killLive()
    // This listener replaced the signal's default action; `once` removed it, so this ends the process as the signal would.
    process.kill(process.pid, signal)
  })
}

/** `node:child_process.spawn`, with the child leading a new process group that `reap` kills. */
export function spawn(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams
export function spawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>
): ChildProcessByStdio<Writable, Readable, Readable>
export function spawn(command: string, args: ReadonlyArray<string>, options: SpawnOptions): ChildProcess
export function spawn(command: string, args: ReadonlyArray<string>, options: SpawnOptions = {}): ChildProcess {
  const child = spawnChild(command, args, { ...options, detached: true })
  live.add(child)
  return child
}
