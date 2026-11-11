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

/**
 * A plain Node child that imports workspace sources needs the VibeLang loader: the engine's StepTrace and the
 * registry's Bundled are `.vibe` files, which Node does not load on its own. Prepend it to the child's argv.
 */
export const vibeImport: string = "--import=vibelang/register"

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

/** Wait for one complete protocol line, retaining bounded diagnostics and removing every listener on settlement. */
export const waitForLine = (
  child: ChildProcessWithoutNullStreams,
  matches: (line: string) => boolean,
  options: { readonly timeoutMs: number; readonly description: string }
): Promise<string> =>
  new Promise((resolve, reject) => {
    let pending = ""
    let stdout = ""
    let stderr = ""
    const tail = (text: string) => text.slice(-4096)
    const diagnostic = () => `\n${stderr}\n${stdout}`
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.stderr.off("data", onStderr)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      onError(new Error(`child exited before ${options.description} with ${code ?? signal}${diagnostic()}`))
    const onStderr = (chunk: string) => {
      stderr = tail(stderr + chunk)
    }
    const onData = (chunk: string) => {
      stdout = tail(stdout + chunk)
      pending += chunk
      for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (matches(line)) {
          cleanup()
          resolve(line)
          return
        }
      }
    }
    const timer = setTimeout(
      () => onError(new Error(`child did not reach ${options.description}${diagnostic()}`)),
      options.timeoutMs
    )
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", onData)
    child.stderr.on("data", onStderr)
    child.once("error", onError)
    child.once("exit", onExit)
    if (exited(child)) onExit(child.exitCode, child.signalCode)
  })
