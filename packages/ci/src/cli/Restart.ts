/**
 * The environment the program itself runs with.
 *
 * A replayed step is a command from a past commit, and it runs beside this
 * program as the same user. On a machine with no jail it can read the
 * environment every process of that user was started with: `/proc/<pid>/environ`
 * on Linux, `ps eww` on macOS. A variable a program removes from its own
 * environment stays readable there, because the system shows what the process
 * was started with.
 *
 * So the program starts again, as the same process, with a short environment:
 * what a step gets of the machine anyway, and what the runtime and the
 * terminal read. Every other variable travels to the new start through a
 * pipe and lives only in its memory, where the parts that need a token read
 * it. Nothing is written to a file.
 *
 * @since 0.1.0
 */

import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/**
 * An environment: names and values.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * The variables Smithers build gives every step from the machine. A step has
 * them already, so the program keeps them.
 *
 * @category constants
 * @since 0.1.0
 */
export const machine: ReadonlyArray<string> = [
  "APPDATA",
  "CI",
  "COMSPEC",
  "DEVELOPER_DIR",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SDKROOT",
  "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME"
]

/**
 * The variables the runtime reads as it starts and the terminal reads as it
 * prints: options, certificate files, colors, the locale and the time zone.
 * None holds a credential.
 *
 * @category constants
 * @since 0.1.0
 */
export const runtime: ReadonlyArray<string> = [
  "COLORTERM",
  "COLUMNS",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LINES",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NO_COLOR",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TZ"
]

/**
 * Where the program and the tools it starts keep compiled code: Node's,
 * VibeLang's and Zig's caches. None holds a credential. Without them a new
 * start, and every Zig build it starts, compiles everything again where the
 * person chose a cache that already holds it.
 *
 * @category constants
 * @since 0.1.0
 */
export const caches: ReadonlyArray<string> = ["NODE_COMPILE_CACHE", "VIBELANG_CACHE_DIR", "ZIG_GLOBAL_CACHE_DIR"]

/**
 * The variable that tells a new start where the withheld variables wait. Its
 * value is the path of a pipe, never a variable's value.
 *
 * @category constants
 * @since 0.1.0
 */
export const handed = "SMITHERS_CI_ENVIRONMENT"

/**
 * Splits an environment into the variables the program keeps and the ones it
 * withholds from its own start. Windows names are compared without case, as
 * Windows compares them.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const split = (
  environment: Environment,
  platform: string
): { readonly short: Record<string, string>; readonly withheld: Record<string, string> } => {
  const names = new Set([...machine, ...runtime, ...caches])
  const short: Record<string, string> = {}
  const withheld: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    const kept = names.has(platform === "win32" ? name.toUpperCase() : name)
    ;(kept ? short : withheld)[name] = value
  }
  return { short, withheld }
}

/**
 * What the helper runs: it reads the variables from its standard input into
 * memory, leaves a writer behind that waits at the pipe for the new start,
 * and ends. The variables are in no environment and on no command line.
 */
const writer = "v=$(cat); ( printf %s \"$v\" > \"$1\" & )"

/**
 * The programs and the directory a hand-over uses: `mkfifo` makes the pipe,
 * the shell holds the variables until they are read, and the pipe is made in
 * a new directory under `directory`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tools {
  readonly mkfifo: string
  readonly shell: string
  readonly directory: string
}

/**
 * This machine's tools.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const tools = (): Tools => ({ mkfifo: "mkfifo", shell: "/bin/sh", directory: tmpdir() })

/**
 * Makes a pipe in a directory only this user can enter and leaves `withheld`
 * waiting at it for the next start of the program. Resolves to the pipe's
 * path.
 *
 * @throws {Error} When the pipe or its writer cannot be made.
 * @category handing over
 * @since 0.1.0
 */
export const hand = async (withheld: Readonly<Record<string, string>>, using: Tools = tools()): Promise<string> => {
  const pipe = join(mkdtempSync(join(using.directory, "smithers-ci-environment-")), "pipe")
  try {
    execFileSync(using.mkfifo, ["-m", "600", pipe], { stdio: "ignore" })
    await new Promise<void>((resolve, reject) => {
      const helper = spawn(using.shell, ["-c", writer, "smithers-ci", pipe], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "ignore", "ignore"]
      })
      helper.on("error", reject)
      helper.on("close", (code) => code === 0 ? resolve() : reject(new Error(`the helper ended with ${code}`)))
      helper.stdin.on("error", reject)
      helper.stdin.end(JSON.stringify(withheld))
    })
  } catch (cause) {
    discard(pipe)
    throw cause
  }
  return pipe
}

const discard = (pipe: string): void => {
  rmSync(pipe, { force: true })
  rmdirSync(dirname(pipe))
}

/**
 * Reads the variables waiting at `pipe` and removes it. Anything that is not
 * a pipe this program made is left alone and gives nothing.
 *
 * @throws {never}
 * @category handing over
 * @since 0.1.0
 */
export const taken = (pipe: string): Readonly<Record<string, string>> => {
  try {
    if (!statSync(pipe).isFIFO()) return {}
    const text = readFileSync(pipe, "utf8")
    discard(pipe)
    return JSON.parse(text) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * The slice of `process` a start touches. `execve` replaces the running
 * program with another in the same process; a runtime without it cannot
 * start again.
 *
 * @category models
 * @since 0.1.0
 */
export interface Program {
  readonly env: Record<string, string | undefined>
  readonly platform: string
  readonly execPath: string
  readonly execArgv: ReadonlyArray<string>
  readonly argv: ReadonlyArray<string>
  readonly execve?: ((file: string, args: ReadonlyArray<string>, env: Record<string, string>) => void) | undefined
}

/**
 * Gives the whole environment the person started the program with, and
 * leaves the process with the short one.
 *
 * With a variable to withhold, the program starts again with the short
 * environment and this call does not return: the new start finds the rest at
 * the pipe and returns it here. On a runtime that cannot start again, the
 * variables are removed from this process's environment, so nothing it starts
 * inherits them.
 *
 * @throws {never}
 * @category running
 * @since 0.1.0
 */
export const own = async (
  program: Program,
  send: (withheld: Readonly<Record<string, string>>) => Promise<string> = hand
): Promise<Environment> => {
  const pipe = program.env[handed]
  if (pipe !== undefined) {
    delete program.env[handed]
    return { ...program.env, ...taken(pipe) }
  }
  const whole = { ...program.env }
  const { short, withheld } = split(program.env, program.platform)
  if (Object.keys(withheld).length === 0) return whole
  if (program.execve !== undefined && program.platform !== "win32") {
    try {
      const waiting = await send(withheld)
      try {
        program.execve(program.execPath, [program.execPath, ...program.execArgv, ...program.argv.slice(1)], {
          ...short,
          [handed]: waiting
        })
      } finally {
        // Reached only when the program was not replaced: nothing will read the pipe, so its writer is let go.
        taken(waiting)
      }
    } catch {
      // This machine cannot hand the variables over. They still leave this process's environment below.
    }
  }
  for (const name of Object.keys(withheld)) delete program.env[name]
  return whole
}
