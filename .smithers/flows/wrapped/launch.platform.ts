// The platform code of launch.vibe: the harness child process, which a .vibe file does not spawn directly.
import { codexEnvironment } from "@smthrs/cli/Agents"
import { Effect } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import type { WrappedFailed } from "./launch.vibe"

export interface Command {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}

/** Cache credentials withheld in addition to the shared vendor credential policy. */
export const withheld: ReadonlyArray<string> = [
  "SMITHERS_CACHE_URL",
  "SMITHERS_CACHE_TOKEN"
]

/** Applies the shared credential policy and wrapped cache exclusions. */
export const childEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = codexEnvironment(base)
  for (const name of withheld) delete env[name]
  return env
}

/** How long pipes may drain after the harness exits, for a holder outside its group. */
export const drainMs = 2000

export interface RunOptions {
  readonly cwd: string
  readonly stdin: string
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly includeStderr?: boolean | undefined
}

/**
 * The UTF-8 byte length of `text`.
 * @throws {never}
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** The UTF-8 text at `path`. */
export const readText = (path: string): Promise<string> => readFile(path, "utf8")

/**
 * Spawns `command` (no shell) as the leader of a new process group with
 * {@link childEnvironment}, writes stdin, and returns stdout. Timeout,
 * oversized output, interruption and exit all SIGKILL the group, so the
 * harness's own children die with it.
 *
 * The result follows the harness's `exit`, not the pipes: a process the
 * harness left behind may hold stdout open. On exit the group is killed and
 * the pipes drain; after {@link drainMs} whatever arrived is the output.
 *
 * `failure` builds the typed failure for a code and message, so this file
 * needs no value import from the flow it serves.
 */
export const run = (
  command: Command,
  options: RunOptions,
  failure: (code: WrappedFailed["code"], message: string) => WrappedFailed
): Effect.Effect<string, WrappedFailed> =>
  Effect.callback<string, WrappedFailed>((resume) => {
    const fail = (code: WrappedFailed["code"], message: string) => resume(Effect.fail(failure(code, message)))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: options.cwd,
        env: childEnvironment(options.env ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true
      })
    } catch (error) {
      // Node throws synchronously for an argument with a NUL byte and for E2BIG.
      fail("spawn_failed", `${command.executable}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // ESRCH: the group is already gone.
      }
    }
    const stdout: Array<Buffer> = []
    let size = 0
    let stderr = ""
    let settled = false
    let drain: ReturnType<typeof setTimeout> | undefined
    const settle = (effect: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      killGroup()
      effect()
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        code === 0
          ? resume(Effect.succeed(Buffer.concat(stdout).toString("utf8") + (options.includeStderr ? stderr : "")))
          : fail(
            "exit_nonzero",
            `${command.executable} exited ${code ?? signal}: ${
              (stderr + (options.includeStderr ? Buffer.concat(stdout).toString("utf8") : "")).trim()
            }`
          )
      )
    const timer = setTimeout(
      () => settle(() => fail("timeout", `${command.executable} exceeded ${options.timeoutMs} ms`)),
      options.timeoutMs
    )
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > options.maxBytes) {
        settle(() => fail("output_too_large", `${command.executable} printed more than ${options.maxBytes} bytes`))
      } else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096)
    })
    child.on("error", (error) => settle(() => fail("spawn_failed", `${command.executable}: ${error.message}`)))
    child.on("exit", (code, signal) => {
      if (settled) return
      // What the harness left holding its pipes dies now; `close` follows once they drain.
      killGroup()
      child.once("close", () => finish(code, signal))
      drain = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code, signal)
      }, drainMs)
    })
    // A child that exits before reading stdin surfaces through `close`.
    child.stdin.on("error", () => undefined)
    child.stdin.end(options.stdin)
    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      killGroup()
    })
  })
