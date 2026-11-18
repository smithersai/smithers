/**
 * Why a CI step failed, as a person reads it: the step's name, its exit code
 * and the first line of its error output. Both replays use it, the one that
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
import type { StepFailure } from "../contract/ReplayReport.ts"
import type { RunRecord, TargetResult } from "../contract/RunRecord.ts"
import { scrub } from "../inventory/Secrets.ts"

/**
 * How much of what `smthrs ci` prints a replay keeps: enough to hold the
 * reason of every failed target.
 *
 * @category constants
 * @since 0.1.0
 */
export const printedLimit = 256_000

const lineLimit = 200
/** How much of an output is searched for a line. It bounds the work on a command that prints without end. */
const sampleLimit = 4000
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

/** Output without its terminal colors and without anything shaped like a credential. */
const readable = (text: string): string => scrub(text.replace(/\p{Cc}\[[0-9;?]*[ -/]*[@-~]/gu, ""))

const lastLine = (text: string): string => text.split("\n").findLast((line) => line.trim() !== "") ?? ""

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
 * that is what its exit code and error output say; else the first line of its
 * error output; else the last line it printed, where a test runner puts its
 * result.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const reasonOf = (output: StepOutput): string => {
  const program = output.exitCode === notFound ? missingProgram(readable(output.stderr.slice(-sampleLimit))) : undefined
  if (program !== undefined) return firstLine(`\`${program}\` is not installed on this machine`)
  return firstLine(readable(output.stderr.slice(0, sampleLimit)))
    || firstLine(lastLine(readable(output.stdout.slice(-sampleLimit))))
    || noOutput
}

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

/**
 * Where a printed shell command ends: at the first line break outside its
 * quotes, since a command can hold many lines. A command whose quotes never
 * close ends at its first line break.
 */
const endOfCommand = (text: string): number => {
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === "\\" && quote !== "'") index++
    else if (quote !== undefined) quote = character === quote ? undefined : quote
    else if (character === "'" || character === "\"") quote = character
    else if (character === "\n") return index
  }
  const firstBreak = text.indexOf("\n")
  return quote === undefined || firstBreak === -1 ? text.length : firstBreak
}

const failedWith = (
  output: StepOutput & { readonly exitCode: number },
  command: string
): Pick<TargetResult, "command" | "error" | "exitCode"> => ({
  error: reasonOf(output),
  command: commandLine(command),
  // A command that was stopped or never started has no exit code; `smthrs` writes -1.
  ...(Number.isInteger(output.exitCode) && output.exitCode >= 0 ? { exitCode: output.exitCode } : {})
})

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
  const decoded = decodePrinted(printed)
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
 * result's label.
 *
 * @category models
 * @since 0.1.0
 */
export type StepNames = ReadonlyMap<string, { readonly step: string; readonly command: string }>

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
      ...(command === "" ? {} : { command })
    }
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
  `  error    ${failure.reason}`
]

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
