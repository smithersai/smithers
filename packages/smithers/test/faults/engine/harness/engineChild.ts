/**
 * Spawning and reading the engine incarnation the crash family kills.
 *
 * @since 1.0.0
 */
import { isGroupAlive, killGroup, waitFor } from "@smthrs/testing/Faults"
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type FlowOptions, markers } from "./killResumeFlow.ts"

const owned = new Map<EngineChild, () => Promise<void>>()
const defaultDeadlineMs = 90_000

const runner = fileURLToPath(new URL("../fixtures/engineChild.ts", import.meta.url))

/**
 * What the child prints on the way out.
 *
 * @since 1.0.0
 * @category models
 */
export type ChildMode = "probe" | "execute"

/**
 * A spawned engine incarnation.
 *
 * @since 1.0.0
 * @category models
 */
export interface EngineChild {
  readonly process: ChildProcess
  readonly pid: number
  /** The nonce this incarnation must echo in its handshake. */
  readonly nonce: string
  readonly stdout: () => string
  readonly stderr: () => string
  /** Resolves with the exit code. */
  readonly exited: Promise<number | null>
  /** Resolves once the handshake line for `mode` has been printed. */
  readonly handshake: Promise<void>
}

/**
 * Spawns one engine incarnation.
 *
 * @since 1.0.0
 * @category constructors
 */
export const spawnEngineChild = (
  options: FlowOptions & { readonly executionId: string; readonly mode: ChildMode; readonly deadlineMs?: number }
): EngineChild => {
  const nonce = randomUUID()
  const child = spawn(
    process.execPath,
    [
      runner,
      options.filename,
      options.executionId,
      options.mode,
      options.markerDir,
      options.counterFile,
      String(options.secondSleepMs),
      nonce,
      options.hostId,
      options.crossing ?? "default"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const pid = child.pid
  if (pid === undefined) throw new Error("engine child has no pid")

  let out = ""
  let err = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const expected = `SMITHERS_ENGINE_HANDSHAKE=${options.mode}:${nonce}`
  let announce: () => void = () => {}
  let refuse: (cause: unknown) => void = () => {}
  const handshake = new Promise<void>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
    if (out.includes(expected)) announce()
  })
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
  })

  // A caller may only await exit; always observe the handshake rejection.
  handshake.catch(() => {})
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs
  const timeout = (phase: string) =>
    new Error(`engine child ${pid} timed out waiting for ${phase} within ${deadlineMs}ms\n${out}\n${err}`)
  const handshakeDeadline = setTimeout(() => refuse(timeout("handshake")), deadlineMs)
  handshakeDeadline.unref()
  void handshake.then(() => clearTimeout(handshakeDeadline), () => clearTimeout(handshakeDeadline))

  const groups = new Set<number>()
  const rememberGroup = () => {
    if (options.mode !== "execute") return
    try {
      const pid = Number(readFileSync(join(options.markerDir, markers.spawnedPid), "utf8"))
      if (Number.isSafeInteger(pid) && pid > 0) groups.add(pid)
    } catch {
      // The engine may have failed before starting the spawning action.
    }
  }
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const actualExit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => {
      rememberGroup()
      resolve(code)
    })
  })
  actualExit.catch(() => {})
  const exited = new Promise<number | null>((resolve, reject) => {
    const exitDeadline = setTimeout(() => reject(timeout("exit")), deadlineMs)
    exitDeadline.unref()
    child.once("error", (cause) => {
      clearTimeout(exitDeadline)
      clearTimeout(handshakeDeadline)
      refuse(cause)
      reject(cause)
    })

    child.once("exit", (code) => {
      clearTimeout(exitDeadline)
      clearTimeout(handshakeDeadline)
      if (!out.includes(expected)) {
        refuse(new Error(`engine child exited (${String(code)}) before its ${options.mode} handshake\n${err}`))
      }
      resolve(code)
    })
  })

  exited.catch(() => {})
  const host: EngineChild = {
    process: child,
    pid,
    nonce,
    stdout: () => out,
    stderr: () => err,
    exited,
    handshake
  }
  owned.set(host, async () => {
    const done = child.exitCode !== null || child.signalCode !== null
    if (!done) child.kill("SIGKILL")
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      `engine child ${pid} to exit during teardown`,
      5_000
    )
    await actualExit
    rememberGroup()
    for (const group of groups) {
      killGroup(group)
      await waitFor(() => !isGroupAlive(group), `engine child ${pid} process group ${group} to exit`, 5_000)
    }
    // Await the real close, even if the public wait has already timed out.
    let reaped = false
    void closed.then(() => {
      reaped = true
    })
    await waitFor(() => reaped, `engine child ${pid} pipes to close`, 5_000)
  })
  return host
}

/**
 * Runs the admission probe and returns once it has proved the runner boots the
 * product. Throws with the child's output when it does not.
 *
 * @since 1.0.0
 * @category constructors
 */
export const probeEngineChild = async (options: FlowOptions & { readonly executionId: string }): Promise<void> => {
  const child = spawnEngineChild({ ...options, mode: "probe" })
  const code = await child.exited
  if (code !== 0 || !child.stdout().includes("PROBE_STATUS=ok")) {
    throw new Error(`engine admission probe failed (${String(code)})\n${child.stdout()}\n${child.stderr()}`)
  }
  if (!child.stdout().includes(`SMITHERS_ENGINE_HANDSHAKE=probe:${child.nonce}`)) {
    throw new Error("engine admission probe did not echo its nonce")
  }
}

/**
 * Reaps every owned host before its fixture can be deleted. This teardown is
 * separate from the deliberate crash, and is safe after that crash or an exit.
 * @since 0.1.0
 * @category destructors
 */
export const reapEngineChildren = async (): Promise<void> => {
  await Promise.all([...owned].map(async ([host, reap]) => {
    await reap()
    owned.delete(host)
  }))
}

/**
 * Waits for a fixture condition, reporting an early engine exit immediately.
 * @since 0.1.0
 * @category constructors
 */
export const waitForEngine = (
  child: EngineChild,
  ready: () => boolean,
  label: string,
  timeoutMs = 60_000
): Promise<void> =>
  waitFor(
    () => {
      if (ready()) return true
      if (child.process.exitCode !== null || child.process.signalCode !== null) {
        throw new Error(`engine child exited before ${label}\n${child.stdout()}\n${child.stderr()}`)
      }
      return false
    },
    label,
    timeoutMs
  )
