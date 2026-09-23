import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as Fs from "node:fs/promises"

const scripts = new Set<string>()

/** Registers a Node program as a fixture executable on every operating system. */
export const writeExecutable = async (path: string, body: string): Promise<void> => {
  await Fs.writeFile(path, `${body}\n`, "utf8")
  scripts.add(path)
}

/**
 * Supplies the interpreter for registered scripts instead of relying on Unix
 * shebang execution. The real spawner still owns argv, cwd, environment, output,
 * exit status, deadlines, and process-tree cleanup. Other executables pass through.
 */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (host) =>
    ChildProcessSpawner.make((command) =>
      host.spawn(
        command._tag === "StandardCommand" && scripts.has(command.command)
          ? ChildProcess.make(process.execPath, [command.command, ...command.args], command.options)
          : command
      )
    ))
).pipe(Layer.provideMerge(NodeServices.layer))
