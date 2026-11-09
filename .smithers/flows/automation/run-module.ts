/**
 * Runs one of this repository's automation modules as a child process, for a
 * flow action.
 *
 * Repository automation (release steps, check receipts, benchmarks, docs sync)
 * is ordinary Node code that a flow's action starts with an argument array.
 * The child inherits stdio, so a step's logs reach the terminal or CI log
 * exactly as before, and nothing it prints is captured: the failure a run
 * records holds the module and exit code only, so no output, and therefore no
 * secret a step prints, reaches the run store.
 *
 * @since 1.0.0
 */
import * as Fault from "@smthrs/flow/Fault"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A module exited non-zero, was killed, or could not start.
 *
 * @since 1.0.0
 * @category errors
 */
export class ModuleFailed extends Schema.TaggedError<ModuleFailed>()("automation/ModuleFailed", {
  module: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String)
}) {
  override get message() {
    return this.signal === null
      ? `${this.module} exited ${this.exitCode}`
      : `${this.module} stopped by ${this.signal}`
  }
}
// The module reported a failing gate or a refused step: the subject, not the host.
Fault.register("automation/ModuleFailed", "user")

/**
 * The checkout root: the nearest ancestor of `from` holding `pnpm-workspace.yaml`.
 *
 * Resolved from the module's own location, so it does not depend on the
 * directory `smthrs` was started in or on where the flows directory sits.
 *
 * @since 1.0.0
 * @category utils
 */
export const repositoryRoot = (from: string | URL): string => {
  let directory = dirname(from instanceof URL ? fileURLToPath(from) : from)
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no pnpm-workspace.yaml above ${String(from)}`)
    directory = parent
  }
}

/**
 * Options for {@link runModule}.
 *
 * @since 1.0.0
 * @category models
 */
/**
 * The `--import` flag for VibeLang's loader when this checkout installs it: a
 * module may import workspace source, and a migrated package's source is
 * `.vibe`, which Node loads only through `vibelang/register`. It is resolved
 * with `import.meta.resolve`: the registry pins every flow that imports this
 * module, and it refuses a module that builds a CommonJS loader.
 *
 * @since 1.0.0
 * @category constructors
 */
export const vibeLangLoader = (): ReadonlyArray<string> => {
  try {
    return [`--import=${import.meta.resolve("vibelang/register")}`]
  } catch {
    return []
  }
}

export interface RunModuleOptions {
  /** Extra environment; the child otherwise inherits this process's. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory; defaults to this process's, as `node <module>` had. */
  readonly cwd?: string
  /** Interpreter arguments placed before the module, such as `--expose-gc`. */
  readonly nodeArgs?: ReadonlyArray<string>
  /**
   * The program that runs the module, found on `PATH`; this Node binary when
   * omitted. A shell script names its shell, such as `bash`.
   */
  readonly interpreter?: string
}

/**
 * Run `node <module> ...args`, or `<interpreter> <module> ...args`, and succeed
 * on exit 0. Node runs the module with VibeLang's loader when the checkout
 * installs it.
 *
 * Interrupting the effect stops the child's process group.
 *
 * @since 1.0.0
 * @category constructors
 */
export const runModule = (
  module: URL,
  args: ReadonlyArray<string>,
  options: RunModuleOptions = {}
): Effect.Effect<void, ModuleFailed> => {
  const path = fileURLToPath(module)
  const root = repositoryRoot(module)
  const name = relative(root, path).split("\\").join("/")
  return Effect.callback<void, ModuleFailed>((resume) => {
    const loaders = options.interpreter === undefined ? vibeLangLoader() : []
    const child = spawn(options.interpreter ?? process.execPath, [
      ...loaders,
      ...(options.nodeArgs ?? []),
      path,
      ...args
    ], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32"
    })
    child.once("error", () => resume(Effect.fail(new ModuleFailed({ module: name, exitCode: null, signal: null }))))
    child.once("close", (code, signal) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(new ModuleFailed({ module: name, exitCode: code, signal: signal ?? null }))
      ))
    return Effect.sync(() => {
      if (child.exitCode !== null || child.pid === undefined) return
      try {
        if (process.platform === "win32") child.kill("SIGTERM")
        else process.kill(-child.pid, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
    })
  })
}
