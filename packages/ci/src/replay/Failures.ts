/**
 * Why a CI step failed, as a person reads it: the step's name, its exit code
 * and the line of its output that says what failed. Both replays use it, the one that
 * generates targets and the one of a repository's own targets, so a failure
 * reads the same in each.
 *
 * Everything here comes from a repository's commands, so a value shaped like a
 * credential is withheld by the rule the CI reader uses, before any line is
 * chosen or cut.
 *
 * @since 0.1.0
 */

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { constants } from "node:os"
import { runnerEntry } from "../contract/Inventory.ts"
import type { StepFailure, StepNotReused } from "../contract/ReplayReport.ts"
import type { RunRecord, TargetResult } from "../contract/RunRecord.ts"
import { scrub } from "../inventory/Secrets.ts"

/**
 * How much of what `smthrs ci` prints for one failed target a replay keeps:
 * the target's command, which holds a step's whole runner text, and the end
 * of its error output and of what it printed, as `smthrs` prints them.
 */
const printedForOne = 256_000

/** The least a replay keeps of a run: a pattern names any number of targets. */
const printedFloor = 8_000_000

/**
 * How much of what `smthrs ci` prints a replay keeps of a run that was asked
 * for `targets` labels or patterns: enough to hold the reason of every one
 * that fails, so the first to fail keeps its reason however many fail after
 * it.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const printedLimitOf = (targets: number): number => Math.max(printedFloor, targets * printedForOne)

const lineLimit = 200
/** How much of a command or of a short text is read for a line. */
const sampleLimit = 4000
/**
 * How much of the end of each output of a step is kept and searched for the
 * line that says why it failed: as much as `smthrs` keeps of a failed
 * command's error output. It holds the error above a long stack trace, whose
 * every line names a file under the job's work directory, and it bounds the
 * work on a command that prints without end.
 *
 * @category constants
 * @since 0.1.0
 */
export const reasonOutputLimit = 64_000
/** The exit code a shell gives for a program it cannot find. */
const notFound = 127
const noOutput = "it printed nothing"
const noReason = "no reason was given"

/**
 * The first line of a text that says something, without control characters,
 * cut at 200 characters.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const firstLine = (text: string): string => {
  const line = text.split("\n").map((entry) => entry.replace(/\p{Cc}/gu, " ").trim()).find((entry) => entry !== "")
  return (line ?? "").slice(0, lineLimit)
}

/** A terminal's color code: the escape character or its one-character form, then the code. */
const colors = new RegExp(`(?:${String.fromCharCode(0x1b)}\\[|${String.fromCharCode(0x9b)})[0-9;?]*[ -/]*[@-~]`, "gu")

/**
 * Output without its terminal colors and without anything shaped like a
 * credential.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const readable = (text: string): string => scrub(text.replace(colors, ""))

/**
 * Words that report an error, as `error`, `failed`, `cannot`, `not found`
 * and `TypeError` do. npm's level word, which heads every line it writes on a
 * failure, says nothing by itself: `npm error A complete log of this run can
 * be found in: …` reports none.
 */
const reportsError =
  /\b(?:errors?|fail(?:s|ed|ing|ures?)?|fatal|panic(?:ked)?|exceptions?|refused|denied|cannot|can't|could ?n(?:o|')t|unable|not found|no such|invalid|missing|abort(?:ed)?|timed out)\b|[a-z](?:Error|Exception)\b|\bERR(?:!|_[A-Z0-9_]+)|\bE\d{3,4}\b/i

/** The level word npm and Yarn head a line with, and the HTTP status after it. */
const levelWord = /^(?:npm|yarn) (?:error|ERR!)(?: \d{3}(?!\d))?/

/**
 * What npm adds under a script that failed: that it failed, and its exit
 * code, directory, workspace and command. The script's own output above it
 * says what failed.
 */
const npmAccount =
  /^(?:npm|yarn) (?:error|ERR!) (?:Lifecycle script|code|path|workspace|location|command|errno|signal)\b/

/**
 * What a package manager prints to say which script it is about to run, never
 * what the script printed: npm's and pnpm's `> name@version script` and
 * `> command`, Yarn's `yarn run v1.22.22` and `$ command`, and pnpm's and
 * Bun's `$ command`.
 */
const echo = /^(?:> |\$ |yarn run v\d)/

/**
 * What a package manager adds under a script that failed, which says only
 * that it failed and with which code: pnpm's `[ELIFECYCLE] Test failed.` and
 * `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, Yarn's `error Command failed with exit
 * code 1.` and `info Visit …`, and Bun's `error: script "test" exited with
 * code 1`. The script's own output above it says what failed.
 */
const managerAccount =
  /^(?:\[?ELIFECYCLE\]?\s|\[?ERR_PNPM_RECURSIVE_(?:RUN|EXEC)_FIRST_FAIL\]?\s|error Command failed with exit code -?\d+\.?$|info Visit https:\/\/yarnpkg\.com\/|error: script "[^"]*" exited with code -?\d+)/

/**
 * A line of a stack trace below the error it belongs to: JavaScript's and
 * Java's `at …` and Python's `File "…", line 3`. The path it names can hold any
 * word, as `lib/errors.js` does.
 */
const stackFrame = /^(?:at\s|File "[^"]*", line \d)/

/** True for a line a package manager wrote around a script, or a frame of a stack trace: never a reason. */
const isAround = (line: string): boolean => echo.test(line) || managerAccount.test(line) || stackFrame.test(line)

/**
 * A line the replay wrote for a step it stopped, as the hook that refuses a
 * push does. It says why the step failed, whatever git printed after it.
 */
const ownLine = /^smithers-ci: /

/** One count of a line of counts: `3 passed`, `resolved 12`, `+1`, `45%`, `done`, `in 0.12s`. */
const oneCount =
  /^(?:[+-]?\d[\d.,]*%?(?:\s+[a-z][\w-]*)?|[a-z][\w-]*\s+[+-]?\d[\d.,]*%?|done)(?:\s+in\s+[\d.]+\s*m?s)?$/i

/** The marks a line of progress or a heading is drawn with. */
const marks = /[\s=*_#+~.|<>()[\]-]/g

/** What a build tool prints as it goes, as cargo's `Compiling cr v0.1.0` is. */
const statusWord =
  /^(?:Compiling|Checking|Downloading|Downloaded|Fresh|Finished|Blocking|Updating|Updated|Locking|Adding|Running|Documenting|Building|Installing|Resolving|Fetching)\b/

/**
 * True for a line that is never the reason a step failed: a progress line,
 * as pnpm's `Progress: resolved 1, reused 0`, a bar or a percentage, a
 * spinner, a status a build tool prints as it goes, or a line of only counts,
 * such as pytest's `1 failed, 3 passed in 0.12s`, which says how many failed
 * but not what.
 */
const isProgress = (line: string): boolean => {
  if (line.replace(marks, "") === "" || /^[\u2800-\u28ff\u25d0-\u25d3]/.test(line)) return true
  if (/^\[[#=>.\s-]+\]/.test(line) || statusWord.test(line)) return true
  if (/\d%/.test(line) && !reportsError.test(line)) return true
  const counts = line.replace(/^[\s=*_#~|-]+|[\s=*_#~|-]+$/g, "").replace(
    /^(?!(?:error|fatal|panic):)[A-Za-z][\w ]*:\s*/i,
    ""
  )
  return /\d/.test(counts) && counts.split(/[,;]\s*/).every((count) => oneCount.test(count.trim()))
}

/**
 * The lines of an output as a terminal shows them: a line rewritten in place
 * with a carriage return shows what was written last, with no control
 * character.
 */
const shownLines = (text: string): ReadonlyArray<string> =>
  text.split("\n").map((line) => (line.split("\r").at(-1) as string).replace(/\p{Cc}/gu, " ").trim())
    .filter((line) => line !== "")

/**
 * The line of an output that says why the command failed: the last line the
 * replay wrote for a step it stopped, else the last line that reports an
 * error. Never a progress line, a line of only counts, a frame of a stack
 * trace, a package manager's echo of its script or its account of a script
 * that failed. Empty when no line reports an error.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const errorLine = (text: string): string => {
  const shown = shownLines(text)
  const reports = (line: string): boolean =>
    !isProgress(line) && !isAround(line) && !npmAccount.test(line) && reportsError.test(line.replace(levelWord, ""))
  return firstLine(shown.findLast((line) => ownLine.test(line)) ?? shown.findLast(reports) ?? "")
}

/**
 * The last line of an output that is no progress line, else its last line
 * as it is. A line a package manager wrote around the script is never one:
 * an output of only those printed nothing.
 */
const lastLine = (text: string): string => {
  const shown = shownLines(text).filter((line) => !echo.test(line) && !managerAccount.test(line))
  return firstLine(shown.findLast((line) => !isProgress(line)) ?? shown.at(-1) ?? "")
}

/** How a shell, or `env` on a script's first line, says a program does not exist. */
const missingProgramLines = [
  /(?:^|: )([^\s:/]+): (?:command )?not found$/,
  /(?:^|: )command not found: ([^\s:/]+)$/,
  /(?:^|\/)env: ['‘]?([^\s'’/]+)['’]?: No such file or directory$/
]

const missingProgram = (stderr: string): string | undefined => {
  for (const line of stderr.split("\n").reverse()) {
    for (const shape of missingProgramLines) {
      const program = shape.exec(line.trim())?.[1]
      if (program !== undefined) return program
    }
  }
  return undefined
}

/**
 * What a finished command left behind. `exitCode` is absent when it never
 * gave one.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepOutput {
  readonly exitCode?: number | undefined
  readonly stderr: string
  readonly stdout: string
}

/**
 * Why a command failed, in one line: that a program is not installed, when
 * that is what its exit code and error output say; else, reading its error
 * output and then what it printed, the last line that reports an error
 * ({@link errorLine}); else the last line that is no progress line; else its
 * last line as it is. Each output is read from its end, where the last error
 * is.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const reasonOf = (output: StepOutput): string => {
  const program = output.exitCode === notFound ? missingProgram(readable(output.stderr.slice(-sampleLimit))) : undefined
  if (program !== undefined) return firstLine(`\`${program}\` is not installed on this machine`)
  // Error output first, then what it printed: the order `smthrs` prints a failed target's output in.
  const errors = readable(output.stderr.slice(-reasonOutputLimit))
  const printed = readable(output.stdout.slice(-reasonOutputLimit))
  const text = `${errors}\n${printed}`
  return errorLine(text) || lastLine(text) || noOutput
}

const stallPrefix = "it made no progress for "

/**
 * Why a step that was stopped for making no progress failed.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const noProgress = (minutes: number): string =>
  `${stallPrefix}${minutes} ${minutes === 1 ? "minute" : "minutes"}`

/**
 * True for a result that failed for making no progress. Running it again
 * would wait as long and tell nothing, so it is not rerun.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const madeNoProgress = (result: Pick<TargetResult, "error">): boolean =>
  result.error?.startsWith(stallPrefix) === true

/**
 * What tells one failure of a step from another: its exit code and the first
 * line of its error.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const failureMark = (result: Pick<TargetResult, "error" | "exitCode">): string =>
  `${result.exitCode ?? ""} ${firstLine(readable(result.error ?? ""))}`

/**
 * What each step last failed with in one way of running commits, by label
 * (`failureMark`). A step that passed since is not in it.
 *
 * @category models
 * @since 0.1.0
 */
export type LastFailures = Map<string, string>

/**
 * True for a result that failed the same way the step failed in the run
 * before: twice the same is broken, not flaky, so it is not run again.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const failedAsBefore = (last: ReadonlyMap<string, string>, result: TargetResult): boolean =>
  result.status === "failed" && last.get(result.label) === failureMark(result)

/**
 * Keeps what a run's results say for the run after it: a failed step's mark
 * replaces what was known of it, and a step that passed is forgotten. A step
 * that did not run leaves what was known.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const remember = (last: LastFailures, results: ReadonlyArray<TargetResult>): void => {
  for (const result of results) {
    if (result.status === "failed") last.set(result.label, failureMark(result))
    else if (result.status !== "skipped") last.delete(result.label)
  }
}

/**
 * How many times failed steps ran again in a replay, and how long those runs
 * took together.
 *
 * @category models
 * @since 0.1.0
 */
export interface RerunTally {
  count: number
  ms: number
}

/**
 * The results of a run of `smthrs` that was stopped for making no progress.
 * A target that failed after running at least `limitMs` was one of those
 * stopped. With no run record, every target asked for counts as stopped:
 * nothing says which of them had finished.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const stoppedResults = (
  recorded: ReadonlyArray<TargetResult> | undefined,
  asked: ReadonlyArray<string>,
  limitMs: number,
  reason: string
): ReadonlyArray<TargetResult> =>
  recorded === undefined
    ? asked.map((label) => ({ label, status: "failed", key: "", durationMs: limitMs, error: reason }))
    : recorded.map((result) => {
      if (result.status !== "failed" || result.durationMs < limitMs) return result
      const { exitCode: _exitCode, ...rest } = result
      return { ...rest, error: reason }
    })

/**
 * A command as one line of a report.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const commandLine = (command: string): string => firstLine(readable(command.slice(0, sampleLimit)))

/** The part of the error `smthrs` prints for a target whose command failed that a report uses. */
const PrintedError = Schema.fromJsonString(Schema.Struct({
  _tag: Schema.Literal("smithers-build/ExecError"),
  argv: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
}))

const decodePrinted = Schema.decodeUnknownOption(PrintedError)

/** The command of an argument list: what a shell is given to run, else the whole list. */
const commandOfArgv = (argv: ReadonlyArray<string>): string =>
  argv.at(-2) === "-c" ? argv.at(-1) as string : argv.join(" ")

/** How `smthrs` heads the output of a shell target whose command failed. The command and the output follow. */
const failedCommand = /^command failed \(exit (-?\d+)\): /

/** How many lines of a printed command may come before the script a shell is given as one quoted word. */
const leadingLines = 8

/**
 * How a step's runner text, printed inside the script word it is given to a
 * shell in, starts its last line: the call that runs the step's command,
 * which follows as one quoted word.
 */
const stepCall = `\n${runnerEntry} '\\''`

/**
 * Where a printed shell command ends. A command can hold many lines: a
 * script given to a shell as one quoted word after `-c`, with short
 * statements on the lines before it. So it ends at the first line break
 * outside quotes after such a word, when one opens in the command's first
 * lines and holds a line break; else at its first line break outside quotes.
 * A script word that closes where the text ends is followed by nothing: the
 * command printed nothing. A command whose quotes never close ends at its
 * first line break.
 *
 * A step's runner text ends with the call that runs the step's command. No
 * line before the end of that call is output, whatever the lines before it
 * quote, so the command is read from the call on; and when the call's word
 * never closes, the whole text is the command.
 */
const endOfCommand = (text: string): number => {
  const call = text.indexOf(stepCall)
  const runner = call !== -1
  // The call stands inside the script word, so its own word starts by closing that one.
  let quote: string | undefined = runner ? "'" : undefined
  // The first line break outside quotes, how many there were, and the script word: open, and closed over lines.
  let first: number | undefined
  let lines = 0
  let script = runner
  let spanned = runner
  for (let index = runner ? call + stepCall.length - 4 : 0; index < text.length; index++) {
    const character = text[index]
    if (character === "\\" && quote !== "'") index++
    else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else if (character === "\n" && script) spanned = true
    } else if (character === "'" || character === "\"") {
      quote = character
      script ||= text.slice(index - 3, index) === "-c "
    } else if (character === "\n") {
      if (spanned) return index
      first ??= index
      lines++
      // Past the first lines, what follows is what the command printed.
      if (lines >= leadingLines) break
    } else if (character === " " && !spanned) script = false
  }
  // Nothing follows the script: the command printed nothing.
  if (spanned && (quote === undefined || runner)) return text.length
  if (first !== undefined) return first
  const firstBreak = text.indexOf("\n")
  return quote === undefined || firstBreak === -1 ? text.length : firstBreak
}

/**
 * The exit code a shell gives for a program a signal ended: 128 and the
 * signal's number, or 128 alone for a name this machine has no signal for.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const signalExit = (signal: string): number =>
  128 + ((constants.signals as Readonly<Record<string, number | undefined>>)[signal] ?? 0)

/** The line `smthrs` adds under the error output of a command a signal ended. The command did not print it. */
const endedBySignal = /^the tool was terminated by (SIG[A-Z0-9]+)$/m

const failedWith = (
  output: StepOutput & { readonly exitCode: number },
  command: string
): Pick<TargetResult, "command" | "error" | "exitCode"> => {
  const signal = endedBySignal.exec(output.stderr)?.[1]
  // A command that was stopped or never started has no exit code; `smthrs` writes -1. One a signal ended has the
  // code a shell gives for the signal, as it has in the baseline.
  const exitCode = signal === undefined ? output.exitCode : signalExit(signal)
  return {
    error: reasonOf({ ...output, stderr: output.stderr.replace(endedBySignal, "") }),
    command: commandLine(command),
    ...(Number.isInteger(exitCode) && exitCode >= 0 ? { exitCode } : {})
  }
}

/**
 * What `smthrs` printed for a failed target, as the fields of its result. A
 * failed command gives its exit code, its command and the reason its output
 * holds, whichever of its two forms `smthrs` printed it in. Any other text
 * gives its first line.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const printedFailure = (printed: string): Pick<TargetResult, "command" | "error" | "exitCode"> => {
  // The error stands on its own line; what `smthrs` prints after it, such as a note about the machine, is not part of it.
  const decoded = decodePrinted(printed.split("\n", 1)[0])
  if (Option.isSome(decoded)) {
    const { argv, exitCode, stderr, stdout } = decoded.value
    return failedWith({ exitCode, stderr, stdout }, commandOfArgv(argv))
  }
  const heading = failedCommand.exec(printed)
  if (heading === null) return { error: firstLine(readable(printed.slice(0, sampleLimit))) }
  const rest = printed.slice(heading[0].length)
  const end = endOfCommand(rest)
  // The output follows the command, error output first, as one text.
  const output = { exitCode: Number(heading[1]), stderr: rest.slice(end + 1), stdout: "" }
  return failedWith(output, rest.slice(0, end).replace(/^\S+ -c /, ""))
}

/**
 * The name a person knows a result by, and the command behind it, by the
 * result's label. `after` is how many steps follow it in its job, and
 * `variantOf` its name without the matrix variant it ran in.
 *
 * @category models
 * @since 0.1.0
 */
export type StepNames = ReadonlyMap<
  string,
  {
    readonly step: string
    readonly command: string
    readonly after?: number | undefined
    readonly variantOf?: string | undefined
  }
>

/**
 * Every failed result as a report states it, in order.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const failuresOf = (
  results: ReadonlyArray<TargetResult>,
  names: StepNames = new Map()
): ReadonlyArray<StepFailure> =>
  results.filter((result) => result.status === "failed").map((result) => {
    const named = names.get(result.label)
    const command = commandLine(named?.command ?? result.command ?? "")
    return {
      step: firstLine(named?.step ?? result.label) || result.label,
      reason: firstLine(readable(result.error ?? "")) || noReason,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(command === "" ? {} : { command }),
      ...(result.fix === undefined ? {} : { fix: firstLine(readable(result.fix)) })
    }
  })

/** `npm install` or `npm i` with flags and no package: the install of what `package.json` names. */
const npmInstall = /^\s*npm\s+(?:install|i)(?:\s+-\S+)*\s*$/

/**
 * What a person does about a step that is never kept for want of a lockfile.
 * Smithers build says so itself for `cargo` and `go` (`..., with no Cargo.lock
 * to say what it fetches`). `npm install` reaches the registry whatever the
 * repository holds, and only `npm ci` installs exactly what a lockfile pins.
 * When the program that opened the connection is `uv` (as `uvx` and `uv run`
 * are), only `uv run --locked` keeps it to what `uv.lock` pins: the line
 * follows the recording, not the words of the command.
 * `after` steps follow it in its job; they read what it leaves, so they run
 * when it ran.
 */
const fixOf = (reason: string, command: string, after: number): string | undefined => {
  const named = /, with no (\S+) to say what it fetches/.exec(reason)?.[1]
  const reacher = /^it opened a network connection \((\S+) to /.exec(reason)?.[1]
  const lockfile = named !== undefined
    ? `commit ${named}`
    : reason.startsWith("it opened a network connection") && npmInstall.test(command)
    ? "commit package-lock.json, install with `npm ci`,"
    : reacher === "uv"
    ? "commit uv.lock, run it with `uv run --locked`,"
    : undefined
  if (lockfile === undefined) return undefined
  return `${lockfile} and this step${after === 0 ? "" : ` and the ${after} after it`} can be reused`
}

/**
 * Every step that ran and whose run says why an earlier result of it was not
 * used, in order. The reason a result is never kept comes first: a step that
 * reaches the network runs at every commit, whatever else changed.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const notReusedOf = (
  results: ReadonlyArray<TargetResult>,
  names: StepNames = new Map()
): ReadonlyArray<StepNotReused> =>
  results.flatMap((result) => {
    const reason = firstLine(readable(result.notStored ?? result.notReused ?? ""))
    if (result.status === "hit" || result.status === "skipped" || reason === "") return []
    const named = names.get(result.label)
    const fix = result.notStored === undefined ? undefined : fixOf(reason, named?.command ?? "", named?.after ?? 0)
    const command = commandLine(named?.command ?? "")
    const variantOf = firstLine(named?.variantOf ?? "")
    return [{
      step: firstLine(named?.step ?? result.label) || result.label,
      reason,
      kept: result.notStored === undefined,
      ...(fix === undefined ? {} : { fix }),
      ...(command === "" ? {} : { command }),
      ...(variantOf === "" ? {} : { variantOf })
    }]
  })

/**
 * One failure in a sentence: `lint failed with exit code 2: bad file`.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const sentenceOf = (failure: StepFailure): string =>
  `${failure.step} failed${
    failure.exitCode === undefined ? "" : ` with exit code ${failure.exitCode}`
  }: ${failure.reason}`

const detailsOf = (failure: StepFailure): ReadonlyArray<string> => [
  `  step     ${failure.step}`,
  ...(failure.command === undefined ? [] : [`  command  ${failure.command}`]),
  ...(failure.exitCode === undefined ? [] : [`  exit     ${failure.exitCode}`]),
  `  error    ${failure.reason}`,
  ...(failure.fix === undefined ? [] : [`  fix      ${failure.fix}`])
]

/**
 * Why there is nothing to measure when no job passed the first run: the
 * commit it ran at, the commit its failed jobs ran once more at when that is
 * another, and the first failure.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const noJobPassed = (commit: string, first: StepFailure, again: string = commit): string => {
  const at = commit.slice(0, 7)
  const where = again === commit ? at : `${at} or at ${again.slice(0, 7)}`
  return [
    `this repository's CI does not pass on this machine, so there is no speedup to measure. No job passed at ${where}.`,
    `First failure at ${at}:`,
    ...detailsOf(first)
  ].join("\n")
}

/**
 * Why there is nothing to measure, or `undefined` when a step passed in a
 * baseline. With no pass at any commit the repository's CI does not run on
 * this machine, and the reason is the newest commit's first failure.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const nothingPassed = (
  baselines: ReadonlyArray<RunRecord>,
  names: StepNames = new Map()
): string | undefined => {
  const passed = baselines.some((record) =>
    record.results.some((result) => result.status !== "failed" && result.status !== "skipped")
  )
  const newest = baselines.at(-1)
  if (passed || newest === undefined) return undefined
  const where = baselines.length === 1 ? "the 1 replayed commit" : `any of the ${baselines.length} replayed commits`
  const at = (newest.commit ?? "").slice(0, 7)
  const first = failuresOf(newest.results, names)[0]
  return [
    `this repository's CI does not pass on this machine, so there is no speedup to measure. No step passed at ${where}.`,
    ...(first === undefined
      ? [`At ${at}, the patterns selected nothing that ran.`]
      : [`First failure at ${at}:`, ...detailsOf(first)])
  ].join("\n")
}
