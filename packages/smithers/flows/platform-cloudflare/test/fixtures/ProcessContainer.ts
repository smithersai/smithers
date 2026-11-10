/**
 * A container whose commands are real local processes: the platform API
 * `ContainerSession` takes, standing in for a Cloudflare container so the
 * session's commands, files and the `SandboxTools` scripts on it run for
 * real. The user option is recorded, not switched to: the tests run as one
 * user. A real container runs in `ContainerTerminal.workerd.test.ts`.
 *
 * Faults are injected through the options: `exec` fails every command,
 * `noStdout` and `noStdin` leave out a stream the command asked for, and
 * `exitCode` replaces every command's exit code.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { ContainerSession } from "../../src/index.ts"

/** The process failed, as an Alchemy container client's `ContainerError`. */
export class ProcessFailure extends Schema.TaggedError<ProcessFailure>()("ProcessFailure", {
  message: Schema.String
}) {}

const fromReadable = (readable: Readable): Stream.Stream<Uint8Array, ProcessFailure> =>
  Stream.fromAsyncIterable(
    readable as AsyncIterable<Uint8Array>,
    (cause) => new ProcessFailure({ message: String(cause) })
  ).pipe(Stream.map((chunk) => new Uint8Array(chunk)))

export interface Faults {
  readonly exec?: boolean
  readonly noStdout?: boolean
  readonly noStdin?: boolean
  readonly exitCode?: number
  /** The command's output stream breaks off with the container's failure. */
  readonly brokenStdout?: boolean
  /** Waiting for the command's exit fails with this value: an untagged one, unlike the container's own. */
  readonly exitFails?: unknown
}

/** The container, and every command's options in order. */
export const make = (faults: Faults = {}) => {
  const commands: Array<{ readonly argv: ReadonlyArray<string>; readonly options: ContainerSession.ExecOptions }> = []
  const container: ContainerSession.Container<ProcessFailure> = {
    exec: (argv, options) =>
      Effect.gen(function*() {
        commands.push({ argv, options })
        if (faults.exec === true) return yield* new ProcessFailure({ message: "exec broke" })
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(argv[0]!, argv.slice(1), {
              cwd: options.cwd,
              env: { ...process.env, ...options.env },
              stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"]
            })
          ),
          (child) => Effect.sync(() => child.exitCode === null && child.kill("SIGKILL"))
        )
        // A write callback reports the typed failure; Node also emits it on the writable. Own that event for
        // the child's lifetime, including errors queued after the writing Effect was interrupted.
        let stdinError: ProcessFailure | undefined
        child.stdin?.on("error", (cause) => {
          stdinError = new ProcessFailure({ message: String(cause) })
        })
        const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 137)))
        return {
          stdin: child.stdin === null || faults.noStdin === true
            ? undefined
            : Sink.forEach((chunk: Uint8Array) =>
              Effect.suspend(() =>
                stdinError !== undefined ? Effect.fail(stdinError) : Effect.tryPromise({
                  try: () =>
                    new Promise<void>((resolve, reject) =>
                      child.stdin!.write(chunk, (error) => error ? reject(error) : resolve())
                    ),
                  catch: (cause) => new ProcessFailure({ message: String(cause) })
                })
              )
            ).pipe(Sink.mapEffect(() => Effect.sync(() => void child.stdin!.end()))),
          stdout: faults.noStdout === true
            ? undefined
            : faults.brokenStdout === true
            ? Stream.fail(new ProcessFailure({ message: "stdout broke" }))
            : fromReadable(child.stdout!),
          stderr: fromReadable(child.stderr!),
          exitCode: "exitFails" in faults
            ? Effect.fail(faults.exitFails as ProcessFailure)
            : Effect.promise(() => exited).pipe(Effect.map((code) => faults.exitCode ?? code))
        } satisfies ContainerSession.Process<ProcessFailure>
      })
  }
  return { container, commands }
}
