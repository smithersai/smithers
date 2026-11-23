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
 * The pipe's path reaches the new start in a variable, and anybody can set a
 * variable. So the new start reads only a pipe of its own making: one named
 * as `hand` names it, in a directory that is this user's and nobody else's to
 * enter. A path named as `hand` names one marks a new start whatever is found
 * there, and a new start never starts again: a system that adds a variable of
 * its own to every process, as macOS does, would otherwise have each start
 * begin another without end. Any other value is ignored, its path is left
 * alone, and the program starts again as if it were not set.
 *
 * This file is TypeScript because the executable loads it before
 * `vibelang/register`: nothing is compiled while the process still holds the
 * whole environment.
 *
 * @since 0.1.0
 */

import { execFileSync, spawn } from "node:child_process"
import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { basename, dirname, join } from "node:path"

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
 * The variables a system gives every process it starts, whatever environment
 * the start was given: macOS adds the user's text encoding. A new start holds
 * them without having been handed them, so they are kept. None holds a
 * credential.
 *
 * @category constants
 * @since 0.1.0
 */
export const system: ReadonlyArray<string> = ["__CF_USER_TEXT_ENCODING"]

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
  const names = new Set([...machine, ...runtime, ...caches, ...system])
  const short: Record<string, string> = {}
  // An environment can contain any name, including an own "__proto__" entry.
  const withheld: Record<string, string> = Object.create(null)
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
 *
 * The writer waits `$2` seconds and no longer. A new start that never comes
 * to read, as when it ends before its first line, would otherwise leave a
 * shell holding every variable for as long as the machine runs, beside a pipe
 * any process of this user can open. After that time the writer is ended and
 * the pipe and its directory are removed.
 */
const writer = [
  "v=$(cat)",
  "(",
  "  ( printf %s \"$v\" > \"$1\" ) &",
  "  w=$!",
  "  v=",
  "  ( sleep \"$2\"; kill \"$w\" ) >/dev/null 2>&1 &",
  "  t=$!",
  "  if wait \"$w\"; then kill \"$t\"; else rm -f \"$1\"; rmdir \"${1%/*}\"; fi",
  ") >/dev/null 2>&1 &"
].join("\n")

/** The name `hand` gives a pipe, and what the name of its directory starts with. */
const pipeName = "pipe"
const directoryPrefix = "smithers-ci-environment-"

/**
 * The programs and the directory a hand-over uses: `mkfifo` makes the pipe,
 * the shell holds the variables until they are read, and the pipe is made in
 * a new directory under `directory`. The variables wait `seconds` at the
 * pipe, a minute when it is not given, and are then let go.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tools {
  readonly mkfifo: string
  readonly shell: string
  readonly directory: string
  readonly seconds?: number | undefined
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
  const pipe = join(mkdtempSync(join(using.directory, directoryPrefix)), pipeName)
  try {
    execFileSync(using.mkfifo, ["-m", "600", pipe], { stdio: "ignore" })
    await new Promise<void>((resolve, reject) => {
      const helper = spawn(using.shell, ["-c", writer, "smithers-ci", pipe, String(using.seconds ?? 60)], {
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

/**
 * Removes a pipe and its directory. The directory is taken out of the way first, in one step: a writer that has
 * not opened the pipe yet then finds no such path. Were the pipe removed first, a writer arriving in the moment
 * before its directory goes would make a file of that name there, with the variables in it.
 */
const discard = (pipe: string): void => {
  const directory = dirname(pipe)
  const gone = `${directory}.gone`
  renameSync(directory, gone)
  rmSync(join(gone, basename(pipe)), { force: true })
  rmdirSync(gone)
}

/** True for a path named as `hand` names a pipe, whatever is there. */
const named = (pipe: string): boolean =>
  basename(pipe) === pipeName && basename(dirname(pipe)).startsWith(directoryPrefix)

/** True for a pipe `hand` made: named as it names one, this user's, in a directory only this user can enter. */
const ours = (pipe: string): boolean => {
  const directory = dirname(pipe)
  if (!named(pipe)) return false
  const user = userInfo().uid
  const above = lstatSync(directory)
  const at = lstatSync(pipe)
  // Each is read whatever the others say: none of them can fail once the two were found.
  return [above.isDirectory(), above.uid === user, (above.mode & 0o077) === 0, at.isFIFO(), at.uid === user]
    .every((holds) => holds)
}

const idle = new Int32Array(new SharedArrayBuffer(4))

/**
 * How much a hand-over may hold and how long reading it may take.
 *
 * `bytes` is the most the writer may write, 8 MiB when it is not given: more than any environment a system starts
 * a process with (Linux gives arguments and environment 2 MiB together, macOS 1 MiB), written as JSON. `within` is
 * the milliseconds from opening the pipe to its end, half a minute when it is not given, however steadily the writer
 * writes.
 *
 * @category models
 * @since 0.1.0
 */
export interface Bounds {
  readonly bytes?: number | undefined
  readonly within?: number | undefined
}

/**
 * Everything the writer at `pipe` writes, or `undefined` when no writer came, or one stopped writing, for
 * `patience` milliseconds, when it wrote more than `bounds.bytes`, or when it had not ended `bounds.within`
 * milliseconds after the pipe was opened. The pipe is opened without waiting: a pipe nobody writes to would
 * otherwise hold the program at its first line for good. A writer that never stops is held to the two bounds: one
 * that wrote a little every few seconds would otherwise keep the program reading, and keeping what it read, for good.
 */
const drained = (pipe: string, patience: number, bounds: Bounds): string | undefined => {
  const descriptor = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const chunks: Array<Buffer> = []
    const buffer = Buffer.alloc(65_536)
    const most = bounds.bytes ?? 8 * 1024 * 1024
    const end = Date.now() + (bounds.within ?? 30_000)
    let held = 0
    let until = Date.now() + patience
    while (true) {
      if (Date.now() >= end) return undefined
      // A read that would wait fails: the writer has the pipe open and has written nothing yet.
      let count = -1
      try {
        count = readSync(descriptor, buffer, 0, buffer.length, null)
      } catch {
        count = -1
      }
      if (count > 0) {
        held += count
        if (held > most) return undefined
        chunks.push(Buffer.from(buffer.subarray(0, count)))
        // A writer that is writing is waited for: the time runs from what it wrote last.
        until = Date.now() + patience
        continue
      }
      // The end, after something was read: the writer wrote everything and closed the pipe.
      if (count === 0 && chunks.length > 0) return Buffer.concat(chunks).toString("utf8")
      if (Date.now() >= until) return undefined
      Atomics.wait(idle, 0, 0, 2)
    }
  } finally {
    closeSync(descriptor)
  }
}

/** The variables of a hand-over as they were written: an object of names and text values, or `undefined`. */
const variablesOf = (text: string): Readonly<Record<string, string>> | undefined => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return Object.values(value).every((held) => typeof held === "string") ? value as Record<string, string> : undefined
}

/**
 * Reads the variables waiting at `pipe` and removes it, or gives `undefined`
 * when nothing can be read there: the path is no pipe of this program's
 * making, which is then left as it is, no writer came within `patience`
 * milliseconds, what it wrote is not the variables, or it wrote past
 * `bounds`.
 *
 * @throws {never}
 * @category handing over
 * @since 0.1.0
 */
export const received = (
  pipe: string,
  patience = 10_000,
  bounds: Bounds = {}
): Readonly<Record<string, string>> | undefined => {
  try {
    if (!ours(pipe)) return undefined
    const text = drained(pipe, patience, bounds)
    discard(pipe)
    return text === undefined ? undefined : variablesOf(text)
  } catch {
    return undefined
  }
}

/**
 * Reads the variables waiting at `pipe` and removes it. Anything that is not
 * a pipe this program made is left alone and gives nothing.
 *
 * @throws {never}
 * @category handing over
 * @since 0.1.0
 */
export const taken = (pipe: string, patience?: number): Readonly<Record<string, string>> =>
  received(pipe, patience) ?? {}

/**
 * What `own` says on standard error when it could not do what it is for.
 *
 * @category models
 * @since 0.1.0
 */
export type Say = (line: string) => void

const aloud: Say = (line) => {
  process.stderr.write(`${line}\n`)
}

/**
 * The line for a start that could not be made again with a short environment.
 *
 * @category constants
 * @since 0.1.0
 */
export const notHidden =
  "smithers-ci: could not start again with a short environment. On a machine with no jail, a replayed step can " +
  "read the variables this program was started with."

/**
 * The line for a new start that found nothing at the pipe it was given.
 *
 * @category constants
 * @since 0.1.0
 */
export const notHandedOver =
  "smithers-ci: the variables this program was started with did not reach its new start, so it runs without " +
  "them: no token of a shared cache or of a model is set. Run it again."

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
 * inherits them, and `say` is given `notHidden`: what the process was started
 * with stays readable.
 *
 * A process whose pipe variable names a path as `hand` names one is a new
 * start, and never starts again, whatever else it holds. It reads the pipe
 * when the pipe is of this program's making. A variable it still holds that
 * the program withholds, one the system added to the start or one the pipe's
 * variable was set beside, is removed from the process's environment. When it
 * finds nothing at its pipe it says `notHandedOver` and runs with the short
 * environment alone, and says `notHidden` too when it held a variable to
 * withhold.
 *
 * A pipe variable that names any other path is not this program's: with
 * nothing to withhold the program says `notHandedOver`, and with a variable
 * to withhold it starts again as if the variable were not set. The path is
 * neither read nor removed.
 *
 * @throws {never}
 * @category running
 * @since 0.1.0
 */
export const own = async (
  program: Program,
  send: (withheld: Readonly<Record<string, string>>) => Promise<string> = hand,
  say: Say = aloud
): Promise<Environment> => {
  const pipe = program.env[handed]
  // Never passed on, whoever set it: it names a path, and nothing this program starts has a use for one.
  if (pipe !== undefined) delete program.env[handed]
  const whole = { ...program.env }
  const { short, withheld } = split(program.env, program.platform)
  const leftover = Object.keys(withheld)
  if (pipe !== undefined && (leftover.length === 0 || named(pipe))) {
    const rest = received(pipe)
    if (rest === undefined) say(notHandedOver)
    if (rest === undefined && leftover.length > 0) say(notHidden)
    for (const name of leftover) delete program.env[name]
    return { ...whole, ...rest }
  }
  if (leftover.length === 0) return whole
  if (program.platform !== "win32") {
    let handedOver = false
    if (program.execve !== undefined) {
      try {
        const waiting = await send(withheld)
        try {
          program.execve(program.execPath, [program.execPath, ...program.execArgv, ...program.argv.slice(1)], {
            ...short,
            [handed]: waiting
          })
          // Only a stand-in for the system's call returns: the program it started read the pipe.
          handedOver = true
        } finally {
          // Reached only when the program was not replaced: nothing will read the pipe, so its writer is let go.
          taken(waiting, 0)
        }
      } catch {
        // This machine cannot hand the variables over. They still leave this process's environment below.
      }
    }
    if (!handedOver) say(notHidden)
  }
  for (const name of leftover) delete program.env[name]
  return whole
}
