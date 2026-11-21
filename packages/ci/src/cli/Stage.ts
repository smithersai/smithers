/**
 * What the program was doing when it last said so, and the one line it ends
 * with when its work stops before it has an exit code of its own.
 *
 * @since 0.1.0
 */

import { errorLine, exitCodes, name } from "../contract/Command.ts"

/**
 * A stage of a replay: what was running, and at which commit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Stage {
  readonly doing: string
  readonly commit: string
}

/**
 * What a replay has told the program: the stage it began last, and every
 * directory it keeps its copies in.
 *
 * @category models
 * @since 0.1.0
 */
export interface Told {
  readonly stage: Stage | undefined
  readonly directories: ReadonlyArray<string>
}

/**
 * Nothing told: no replay has begun.
 *
 * @category constants
 * @since 0.1.0
 */
export const nothingTold: Told = { stage: undefined, directories: [] }

/** What a replay runs at a commit, as its progress line names it and as a sentence does. */
const ways: Readonly<Record<string, string>> = {
  baseline: "the baseline",
  normal: "normal mode",
  fast: "fast mode",
  "with the files apply writes": "normal mode with the files apply writes"
}

const running = /^(first run|\d+\/\d+) ([0-9a-f]{7,40}) (baseline|normal|fast|with the files apply writes)$/

const checking = /^(checking which (?:jobs|targets) pass on this machine) at ([0-9a-f]{7,40})$/

/**
 * The stage a progress line of a replay begins: `2/5 3f2a1c9 baseline` is the
 * baseline at `3f2a1c9`. Nothing for a line that begins none, such as a note
 * or a job that fails here.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const stageOf = (line: string): Stage | undefined => {
  const run = running.exec(line)
  if (run !== null) {
    const [, position, commit, way] = run as unknown as readonly [string, string, string, string]
    return { doing: `running ${position === "first run" ? "the first run of " : ""}${ways[way] as string}`, commit }
  }
  const check = checking.exec(line)
  if (check === null) return undefined
  const [, doing, commit] = check as unknown as readonly [string, string, string]
  return { doing, commit }
}

/** Where the program was, for the end of a line: the replay's stage, the replay before its first, or nowhere. */
const where = (told: Told): string =>
  told.stage !== undefined
    ? ` while ${told.stage.doing} at ${told.stage.commit}`
    : told.directories.length > 0
    ? " while preparing the replay"
    : ""

/** Who speaks: the replay once one has begun, else the program. */
const speaker = (told: Told): string =>
  told.stage !== undefined || told.directories.length > 0 ? `${name}: replay:` : `${name}:`

/**
 * The line for a program whose work stopped with nothing left that could
 * wake it: something it waited for will never answer.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const unanswered = (told: Told): string => `${speaker(told)} stopped without an answer${where(told)}`

/**
 * What went wrong, in one line; see `errorLine`.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const reasonOf = (cause: unknown): string => errorLine(cause)

/**
 * The line for a program stopped by an error no part of it answers for.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const broken = (told: Told, cause: unknown): string =>
  `${speaker(told)} stopped on an error of its own${where(told)}: ${reasonOf(cause)}`

/**
 * The exit code of a program that stopped without one of its own.
 *
 * @category constants
 * @since 0.1.0
 */
export const stoppedCode: number = exitCodes.failed
