/**
 * Starts `smthrs` where the commands it runs see no process but its own.
 *
 * A command `smthrs` runs is the repository's code, and a process can read
 * what every other process of its user was started with: `/proc/<pid>/environ`
 * holds a variable for as long as the process lives, whatever the program
 * removes later. On a CI runner the shell that started `smthrs` holds the
 * shared cache's token that way, and `sudo` there needs no password, so the
 * memory of every process is one command further.
 *
 * So when `smthrs` is started with the token to run targets, it starts itself
 * again under bubblewrap, in a process table of its own:
 *
 * - What it runs sees `smthrs` and what `smthrs` started. The shell, the
 *   runner and this first start are not there to read.
 * - bubblewrap lets no program gain a privilege, so `sudo` gains none.
 * - The second start is given a short list of variables. Every other one
 *   reaches it through a pipe and is set once it runs, which the system does
 *   not show. The token is set nowhere: it is answered from memory to the one
 *   reader that asks for it by name, and no program `smthrs` starts inherits
 *   it.
 * - The session's message bus is out of reach: whoever talks to it can have
 *   the session start a program outside.
 *
 * Without bubblewrap, as root, or on another system, `smthrs` runs as it is.
 */
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { constants as system } from "node:os"
import { delimiter, join } from "node:path"

/** The variable that carries the shared cache's token. */
export const tokenName = "SMITHERS_CACHE_TOKEN"

/** Tells the second start which descriptor its variables wait at. */
export const pipeName = "SMITHERS_START_PIPE"

/** The commands that run a repository's targets. */
export const targetCommands = new Set(["build", "test", "lint", "docs", "review", "run", "ci"])

/**
 * The variables the second start is started with: what the system and Node
 * read before any of the program runs, and what says where and how it runs.
 * None of them holds a credential.
 */
export const startVariables = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_NO_WARNINGS",
  "NODE_V8_COVERAGE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
])

/** The command a start names: its first argument that is not a flag. */
export const commandOf = (args) => args.find((argument) => !argument.startsWith("-"))

/** The first program of that name a search path holds, or `undefined`. */
export const findProgram = (name, searchPath) => {
  for (const directory of (searchPath ?? "").split(delimiter)) {
    if (directory === "") continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not in this directory.
    }
  }
  return undefined
}

/**
 * bubblewrap's arguments before the command: every file as it is, a process
 * table of its own, and the session's message bus and service manager out of
 * reach where the session has them.
 */
export const apartArguments = (uid, exists = existsSync) => {
  const session = `/run/user/${uid}`
  return [
    "--dev-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    ...(exists(`${session}/bus`) ? ["--ro-bind", "/dev/null", `${session}/bus`] : []),
    ...(exists(`${session}/systemd`) ? ["--tmpfs", `${session}/systemd`] : []),
    "--die-with-parent",
    "--"
  ]
}

/**
 * Why this start is not started again, or the bubblewrap that will hold the
 * second one. `starts` says whether a program runs under the arguments.
 */
export const plan = (
  { args, env, platform, uid },
  starts = (program, wrap) => spawnSync(program, [...wrap, "true"], { stdio: "ignore" }).status === 0
) => {
  if (env[pipeName] !== undefined) return { apart: false, why: "this is the second start" }
  // The token as the system shows it: among the variables this start was started with. A token that is only
  // answered by name, as a start that was handed it through a pipe holds it, is in no process to read.
  const startedWith = Object.entries(env).find(([name]) => name === tokenName)?.[1]
  if (!startedWith) return { apart: false, why: "no token" }
  if (!targetCommands.has(commandOf(args))) return { apart: false, why: "the command runs no target" }
  if (platform !== "linux") return { apart: false, why: "only Linux gives a process table of its own" }
  if (uid === 0) return { apart: false, why: "root reads every process" }
  const bwrap = findProgram("bwrap", env.PATH)
  if (bwrap === undefined) return { apart: false, why: "bwrap is not on PATH" }
  const wrap = apartArguments(uid)
  if (!starts(bwrap, wrap)) return { apart: false, why: "bubblewrap does not start here" }
  return { apart: true, bwrap, wrap }
}

/** The variables a second start is started with, and the rest, which wait at the pipe. */
export const divide = (env) => {
  const started = {}
  const piped = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (startVariables.has(name)) started[name] = value
    else piped[name] = value
  }
  return { started, piped }
}

/**
 * Starts the program again under bubblewrap and resolves to its exit code, or
 * to `undefined` when this start is the one that runs. A signal this start
 * gets is passed on. bubblewrap ends everything it holds when it ends, so a
 * stopped run leaves no process behind.
 */
export const startApart = async (proc = process) => {
  const decided = plan({
    args: proc.argv.slice(2),
    env: proc.env,
    platform: proc.platform,
    uid: proc.getuid?.()
  })
  if (!decided.apart) return undefined
  const { started, piped } = divide(proc.env)
  const child = spawn(
    decided.bwrap,
    [...decided.wrap, proc.execPath, ...proc.execArgv, ...proc.argv.slice(1)],
    { env: { ...started, [pipeName]: "3" }, stdio: ["inherit", "inherit", "inherit", "pipe"] }
  )
  // A program that ends before it reads leaves the pipe closed.
  child.stdio[3].on("error", () => {})
  child.stdio[3].end(JSON.stringify(piped))
  const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"]
  const pass = (signal) => child.kill(signal)
  for (const signal of forwarded) proc.on(signal, pass)
  return await new Promise((resolve) => {
    child.on("error", () => resolve(127))
    child.on("exit", (code, signal) => {
      for (const each of forwarded) proc.off(each, pass)
      resolve(code ?? 128 + (system.signals[signal] ?? 0))
    })
  })
}

/**
 * In a second start, takes the variables that wait at the pipe. Each is set as
 * the first start had it, which the system does not show as what the process
 * was started with. The token is not set: it is answered to whoever reads it
 * by name until it is removed, and is never among the variables a started
 * program inherits.
 */
export const receive = (proc = process, read = (descriptor) => readFileSync(descriptor, "utf8")) => {
  const at = proc.env[pipeName]
  if (at === undefined) return
  delete proc.env[pipeName]
  const { [tokenName]: held, ...rest } = JSON.parse(read(Number(at)))
  Object.assign(proc.env, rest)
  let token = held ?? ""
  proc.env = new Proxy(proc.env, {
    get: (variables, key) => (key === tokenName && token !== "" ? token : Reflect.get(variables, key)),
    has: (variables, key) => (key === tokenName && token !== "") || Reflect.has(variables, key),
    // A variable is set on the real environment, which takes a whole value and nothing less.
    set: (variables, key, value) => Reflect.set(variables, key, value),
    deleteProperty: (variables, key) => {
      if (key === tokenName) token = ""
      return Reflect.deleteProperty(variables, key)
    }
  })
}
