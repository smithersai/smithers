/**
 * Host access for the fail-only report example: running a shell command.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type { ExecException } from "node:child_process"
import { exec } from "node:child_process"

/** What the shell handed back for one command, including a failure that carries no exit code. */
export interface CommandRun {
  readonly error: ExecException | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/**
 * Runs `command` in a shell in `directory`, killing it after `timeoutMs`.
 *
 * @since 0.1.0
 */
export const execCommand = (command: string, directory: string, timeoutMs: number): Effect.Effect<CommandRun> =>
  Effect.callback<CommandRun>((resume, signal) => {
    const startedAt = Date.now()
    exec(command, { cwd: directory, timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      resume(Effect.succeed({ error, stdout, stderr, durationMs: Date.now() - startedAt }))
    })
  })
