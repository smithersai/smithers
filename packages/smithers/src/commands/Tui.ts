/**
 * `smthrs tui`: hands the terminal to the Smithers TUI.
 *
 * The TUI renders with `@opentui/core`, which needs Bun, while this CLI runs
 * on Node. The command therefore spawns Bun on the TUI entry with the
 * terminal inherited and exits with the TUI's status. A source checkout runs
 * `apps/tui/src/main.tsx`; an installation runs the bundle the package build
 * writes to `dist/tui/main.js`.
 *
 * @since 1.0.0
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as CliError from "../CliError.ts"

/**
 * The TUI's own flags, forwarded unchanged.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly directory?: string | undefined
  readonly model?: string | undefined
  readonly continue?: boolean | undefined
  readonly resume?: boolean | undefined
  readonly print?: string | undefined
}

/**
 * The argument vector `apps/tui/src/main.tsx` parses.
 *
 * @category constructors
 * @since 1.0.0
 */
export const argv = (options: Options): Array<string> => [
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.continue === true ? ["--continue"] : []),
  ...(options.resume === true ? ["--resume"] : []),
  ...(options.print === undefined ? [] : ["--print", options.print]),
  ...(options.directory === undefined ? [] : [options.directory])
]

/**
 * The TUI entry for the package rooted at `packageRoot`: the checkout source
 * when the package sits in the Smithers workspace, else the built bundle.
 *
 * @category constructors
 * @since 1.0.0
 */
export const entry = (packageRoot: URL): string => {
  const checkout = new URL("../../pnpm-workspace.yaml", packageRoot)
  return fileURLToPath(
    existsSync(checkout)
      ? new URL("../../apps/tui/src/main.tsx", packageRoot)
      : new URL("dist/tui/main.js", packageRoot)
  )
}

/**
 * Where to find Bun: `SMITHERS_BUN`, else this process when it is Bun, else
 * `bun` on `PATH`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const bun = (environment: Record<string, string | undefined>): string =>
  environment["SMITHERS_BUN"] ?? (process.versions["bun"] === undefined ? "bun" : process.execPath)

/**
 * Runs the TUI to completion and resolves with its exit status.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = (
  options: Options,
  environment: Record<string, string | undefined>,
  target: string = entry(new URL(".", import.meta.resolve("@smthrs/cli/package.json")))
): Promise<number> => {
  if (!existsSync(target)) {
    return Promise.reject(
      new CliError.UnsupportedError({ message: `The TUI is missing from this installation: ${target}` })
    )
  }
  const executable = bun(environment)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [target, ...argv(options)], { stdio: "inherit", env: environment })
    // The TUI owns Ctrl+C; the parent must outlive it to report its status.
    const ignore = () => {}
    process.on("SIGINT", ignore)
    const settle = () => process.removeListener("SIGINT", ignore)
    child.once("error", (cause: NodeJS.ErrnoException) => {
      settle()
      reject(
        cause.code === "ENOENT"
          ? new CliError.UnsupportedError({
            message: `smthrs tui needs Bun >= 1.3 (${executable} was not found). Install it from https://bun.sh`
          })
          : cause
      )
    })
    child.once("exit", (code, signal) => {
      settle()
      resolve(code ?? (signal === null ? 1 : 128))
    })
  })
}
