/**
 * Host operations used by child-repository resolution.
 * @since 1.0.0
 * @private
 */

import { Effect } from "effect"
import { type ChildProcessByStdio, spawn, type SpawnOptions } from "node:child_process"
import type { Readable, Writable } from "node:stream"

/** A child with both output pipes owned by its caller.
 * @category models
 * @since 1.0.0
 */
export type Child = ChildProcessByStdio<null, Readable, Readable>

/** Each invocation owns its adapter; faults never replace process-wide modules.
 * @category services
 * @since 1.0.0
 */
export interface Services {
  readonly spawn: (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => Effect.Effect<Child, unknown>
  readonly killGroup: (pid: number) => Effect.Effect<void, unknown>
  readonly output: (stream: "stdout" | "stderr", text: string) => void
}

/** Builds host operations using caller-owned real terminal streams.
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  terminal: { readonly stdout: Pick<Writable, "write">; readonly stderr: Pick<Writable, "write"> } = process
): Services => ({
  spawn: (command, args, options) =>
    Effect.try({
      try: () => spawn(command, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] }),
      catch: (cause) => cause
    }),
  killGroup: (pid) =>
    Effect.try({
      try: () => {
        process.kill(-pid, "SIGKILL")
      },
      catch: (cause) => cause
    }),
  output: (stream, text) => {
    terminal[stream].write(text)
  }
})

/** Real host operations for the promise-based command boundary.
 * @category services
 * @since 1.0.0
 */
export const live: Services = make()
