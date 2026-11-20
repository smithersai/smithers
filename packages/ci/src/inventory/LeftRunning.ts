/**
 * Which CI steps leave a program running for the steps after them, read from
 * their commands.
 *
 * On a GitHub runner a program a step starts and does not wait for, as
 * `python3 -m http.server 8000 &` or `redis-server --daemonize yes`, runs
 * until the job ends, so the job's next step can talk to it. A job whose
 * programs this machine cannot keep until the job ends is left out and listed
 * with the step, and `apply` writes it as the repository has it. Nothing here
 * runs anything: a step is read for a command it puts in the background and
 * never waits for or stops, and for a program started with a flag that makes
 * it a server of its own.
 *
 * @since 0.1.0
 */

import { type Job, leftRunning, type Step } from "../contract/Inventory.ts"
import { listed, startedIn } from "./MachineChanges.ts"

/** The programs that, started with one of these flags, carry on in the background on their own. */
const daemonizes = (args: ReadonlyArray<string>): boolean =>
  args.some((word, at) => /^--daemonize(=yes)?$/.test(word) && (word.endsWith("=yes") || args[at + 1] === "yes"))
const daemonFlags: ReadonlyMap<string, (args: ReadonlyArray<string>) => boolean> = new Map([
  ["redis-server", daemonizes],
  ["valkey-server", daemonizes],
  ["mongod", (args) => args.includes("--fork")],
  ["memcached", (args) => args.includes("-d") || args.includes("--daemon")],
  ["pg_ctl", (args) => args.includes("start")],
  ["pg_ctlcluster", (args) => args.includes("start")],
  ["start-stop-daemon", (args) => args.includes("--start") || args.includes("-S")],
  ["setsid", (args) => args.includes("-f") || args.includes("--fork")],
  ["daemonize", () => true],
  // `ssh-agent` with no command to run forks and stays: `eval "$(ssh-agent -s)"`.
  ["ssh-agent", (args) => args.every((word) => word.startsWith("-") || word === "")]
])

/** The commands with which a script waits for, or stops, what it put in the background. */
const settles: ReadonlySet<string> = new Set(["wait", "kill", "pkill", "killall", "fg"])

/** Where the closing `close` of the `open` at `start` is, past quotes and escapes, or the end of the text. */
const closingOf = (text: string, start: number, open: string, close: string): number => {
  let depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (char === "\\") at += 1
    else if (char === "'") at = Math.max(at, text.indexOf("'", at + 1))
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return at
  }
  return text.length
}

/**
 * Where each command a script puts in the background with `&` starts and
 * ends, as text offsets: the `&` of `&&`, `>&`, `&>` and `|&` is no such
 * mark. Quotes, `$( )`, backticks, comments and here-documents are passed
 * over; `( … ) &` puts the whole group there.
 */
const backgrounded = (script: string): ReadonlyArray<readonly [start: number, end: number]> => {
  const found: Array<readonly [number, number]> = []
  let start = 0
  let at = 0
  // The words that end the here-documents of the current line, read after it ends.
  const pending: Array<string> = []
  const separate = (next: number) => {
    start = next
  }
  while (at < script.length) {
    const char = script[at] as string
    if (char === "\\") at += 2
    else if (char === "'") at = (script.indexOf("'", at + 1) + 1) || script.length
    else if (char === "\"") {
      at += 1
      while (at < script.length && script[at] !== "\"") at += script[at] === "\\" ? 2 : 1
      at += 1
    } else if (char === "`") {
      at += 1
      while (at < script.length && script[at] !== "`") at += script[at] === "\\" ? 2 : 1
      at += 1
    } else if (char === "$" && script[at + 1] === "(") at = closingOf(script, at + 1, "(", ")") + 1
    else if (char === "#" && (at === 0 || /[\s;&|(]/.test(script[at - 1] as string))) {
      while (at < script.length && script[at] !== "\n") at += 1
    } else if (char === "<" && script[at + 1] === "<" && script[at + 2] !== "<") {
      const mark = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(script.slice(at))
      if (mark !== null) pending.push(mark[2] as string)
      at += mark === null ? 2 : mark[0].length
    } else if (char === "\n") {
      at += 1
      for (const word of pending.splice(0)) {
        // The body runs to the line that holds the word alone, leading tabs aside.
        while (at < script.length) {
          const end = script.indexOf("\n", at)
          const line = script.slice(at, end < 0 ? script.length : end)
          at = end < 0 ? script.length : end + 1
          if (line.replace(/^\t+/, "") === word) break
        }
      }
      separate(at)
    } else if (char === "(") {
      // A group put in the background whole: `( server ) &`.
      const end = closingOf(script, at, "(", ")")
      at = end + 1
    } else if (char === "&") {
      const before = script[at - 1]
      const after = script[at + 1]
      if (after === "&") {
        at += 2
        separate(at)
      } else if (before === ">" || before === "<" || after === ">" || before === "|") at += 1
      else {
        found.push([start, at])
        at += 1
        separate(at)
      }
    } else if (char === ";" || char === "|") {
      at += script[at + 1] === char ? 2 : 1
      separate(at)
    } else at += 1
  }
  return found
}

/** The words before a program that only say how it is started. */
const starters: ReadonlySet<string> = new Set(["cd", "nohup", "exec", "setsid", "time"])

/**
 * The first program a piece of a script starts, as a person names it: what
 * the reader of commands sees, else the first word that is no variable
 * assignment and no `nohup`, by its file name, as `./bin/server` is
 * `server`. A word that is a variable is `a program`.
 */
const nameOf = (text: string, env: Readonly<Record<string, string>>): string => {
  const inner = text.trim().replace(/^\(\s*/, "").replace(/\s*\)$/, "")
  const seen = startedIn(inner, env).find(({ name }) => !starters.has(name))
  if (seen !== undefined) return seen.name
  const word = inner.split(/\s+/).find((each) =>
    each !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(each) && !starters.has(each)
  )
  return word === undefined || word.startsWith("$") ? "a program" : word.slice(word.lastIndexOf("/") + 1)
}

/**
 * The programs a step's command leaves running when it ends, each once in
 * the order met: a command it puts in the background with `&` and never
 * waits for or stops (no `wait`, `kill`, `pkill`, `killall` or `fg` after it),
 * and a program started with a flag that keeps it running on its own, as
 * `redis-server --daemonize yes`, `mongod --fork`, `pg_ctl start` and
 * `ssh-agent` are.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const leftRunningIn = (command: string, env: Readonly<Record<string, string>> = {}): ReadonlyArray<string> => {
  const programs: Array<string> = []
  for (const [start, end] of backgrounded(command)) {
    const after = startedIn(command.slice(end + 1), env)
    if (!after.some(({ name }) => settles.has(name))) programs.push(nameOf(command.slice(start, end), env))
  }
  for (const { args, name } of startedIn(command, env)) {
    if (daemonFlags.get(name)?.(args) === true) programs.push(name)
  }
  return [...new Set(programs)]
}

/** The longest a step's name is in a report: a command's first line is cut there. */
const nameLength = 60

/**
 * How a report names a step: by the name its CI gives it, else as GitHub
 * does, `Run` and the first line of its command, cut to {@link nameLength}.
 *
 * @category rendering
 * @since 0.1.0
 * @throws {never}
 */
export const stepName = (step: Step): string => {
  const name = step.name?.trim() ?? ""
  if (name !== "") return name
  const line = `Run ${(step.command.trim().split("\n")[0] as string).trim()}`
  return line.length <= nameLength ? line : `${line.slice(0, nameLength - 1)}…`
}

/**
 * A job with one `left-running` entry for each step that leaves a program
 * running while a step after it is still to run: `"Start the server" leaves
 * python3 running`. What the last step leaves ends with the job on a runner too, so
 * it is not marked. A job with no such step is returned as it is.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const markLeftRunning = <J extends Job>(job: J): J => {
  const found = job.steps.slice(0, -1).flatMap((step) => {
    const programs = leftRunningIn(step.command, step.env)
    return programs.length === 0
      ? []
      : [{ feature: leftRunning, detail: `"${stepName(step)}" leaves ${listed(programs)} running` }]
  })
  return found.length === 0 ? job : { ...job, unsupported: [...job.unsupported, ...found] }
}
