/**
 * The platform code of `run-module.vibe`: Node's process spawning, its module
 * resolution and the checkout's layout, which a `.vibe` file does not import.
 *
 * @since 1.0.0
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

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
 * The `--import` flag for VibeLang's loader when this checkout installs it: a
 * module may import workspace source, and a migrated package's source is
 * `.vibe`, which Node loads only through `vibelang/register`. It is resolved
 * with `import.meta.resolve`: the registry pins every flow that imports this
 * module, and it refuses a module that builds a CommonJS loader.
 *
 * @since 1.0.0
 * @category constructors
 * @throws {never}
 */
export function vibeLangLoader(): ReadonlyArray<string> {
  try {
    return [`--import=${import.meta.resolve("vibelang/register")}`]
  } catch {
    return []
  }
}

/** A module's file path and its name relative to the checkout root, as the failure a run records names it. */
export const locateModule = (module: URL): { readonly path: string; readonly name: string } => {
  const path = fileURLToPath(module)
  const root = repositoryRoot(module)
  return { path, name: relative(root, path).split("\\").join("/") }
}

/** What {@link startChild} needs to start `node <module> ...args` or `<interpreter> <module> ...args`. */
export interface ChildStart {
  readonly path: string
  readonly interpreter: string | undefined
  readonly loaders: ReadonlyArray<string>
  readonly nodeArgs: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
}

/** How a child ended: its exit code, or the signal that stopped it. */
export interface ChildClose {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * Starts the child with inherited stdout and stderr, in its own process group
 * where the platform has them. `onError` runs when it cannot start, `onClose`
 * when it ends. Returns a function that stops the child's process group (or the
 * child alone where groups are unavailable) when it is still running.
 *
 * @since 1.0.0
 * @category constructors
 * @throws {never}
 */
export function startChild(
  start: ChildStart,
  onError: () => void,
  onClose: (close: ChildClose) => void
): () => void {
  try {
    const child = spawn(start.interpreter ?? process.execPath, [
      ...start.loaders,
      ...start.nodeArgs,
      start.path,
      ...start.args
    ], {
      cwd: start.cwd ?? process.cwd(),
      env: { ...process.env, ...start.env },
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32"
    })
    child.once("error", () => onError())
    child.once("close", (code, signal) => onClose({ code, signal: signal ?? null }))
    return () => {
      if (child.exitCode !== null || child.pid === undefined) return
      try {
        if (process.platform === "win32") child.kill("SIGTERM")
        else process.kill(-child.pid, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
    }
  } catch {
    // `spawn` throws only for arguments it cannot use; the child never started.
    queueMicrotask(onError)
    return () => {}
  }
}
