/**
 * Contract 10: how the parts are called.
 *
 * Each part exports one or two functions with the types below from its own
 * directory. The command-line program calls only these, so a part can land
 * before or after any other.
 *
 * | Directory | Export | Type |
 * | --- | --- | --- |
 * | `src/inventory` | `read` | {@link ReadInventory} |
 * | `src/generate` | `files` | {@link GenerateFiles} |
 * | `src/replay` | `run` | {@link RunReplay} |
 * | `src/report` | `text`, `html` | {@link RenderReport} |
 * | `src/select` | `rows`, `score` | {@link BuildRows}, {@link ScoreRows} |
 *
 * `R` is whatever services a part needs from its host, such as a file system
 * or a process runner. The command-line program provides them.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Closure } from "./Closure.ts"
import type { Ci, Inventory } from "./Inventory.ts"
import type { Plan } from "./Plan.ts"
import type { ReplayReport } from "./ReplayReport.ts"
import type { Mode, RunRecord } from "./RunRecord.ts"
import type { Row, Score, Settings } from "./Selection.ts"

/**
 * Why a part could not finish. `unsupported` means the repository uses
 * something Smithers CI cannot run and `not-a-repository` that the directory
 * has no Git commit to read; the command-line program exits 3 for both.
 *
 * @category models
 * @since 0.1.0
 */
export const Failure = Schema.Struct({
  code: Schema.Literals(["unsupported", "not-a-repository", "command-failed", "invalid-document", "model-unavailable"]),
  message: Schema.NonEmptyString,
  part: Schema.Literals(["inventory", "generate", "replay", "report", "select", "cli", "closure", "decompose"])
})

/**
 * A decoded `Failure`.
 *
 * @category models
 * @since 0.1.0
 */
export type Failure = typeof Failure.Type

/**
 * Reads what the CI of the repository at `root` does today.
 *
 * @category parts
 * @since 0.1.0
 */
export type ReadInventory<R = never> = (root: string) => Effect.Effect<Inventory, Failure, R>

/**
 * One generated file, by path relative to the repository root. `written` is
 * `false` for a document the program reads from this list and no run of the
 * generated CI needs, such as the target map: `apply` and a replay write
 * every file but those, so the repository holds nothing a tool of its own
 * would read and nothing the CI does not use.
 *
 * @category models
 * @since 0.1.0
 */
export interface GeneratedFile {
  readonly path: string
  readonly content: string
  readonly written?: false | undefined
}

/**
 * The generated files that are written into a repository: every file but
 * those marked `written: false`.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const writtenFiles = (files: ReadonlyArray<GeneratedFile>): ReadonlyArray<GeneratedFile> =>
  files.filter((file) => file.written !== false)

/**
 * Choices the generated files carry. `cache` is the URL of the shared cache
 * the generated workspace and workflow name. `inheritEnv` names variables of
 * the machine every target passes to its step, beside the ones the step
 * names; a variable the step sets keeps the step's value. The replay names
 * the ones that tell git to refuse a push. `allowDocker` says the inventory
 * holds the jobs that start a container program (`Inventory.allowingDocker`):
 * the workflow's check that the files are up to date then allows them too.
 *
 * @category models
 * @since 0.1.0
 */
export interface GenerateOptions {
  readonly cache?: string | undefined
  readonly inheritEnv?: ReadonlyArray<string> | undefined
  readonly allowDocker?: boolean | undefined
}

/**
 * The Smithers workspace, target files and CI workflow for an inventory. It
 * returns text and writes nothing. One of the files is the target map
 * (contract 11), at `TargetMap.path`.
 *
 * @category parts
 * @since 0.1.0
 */
export type GenerateFiles<R = never> = (
  inventory: Ci,
  options?: GenerateOptions
) => Effect.Effect<ReadonlyArray<GeneratedFile>, Failure, R>

/**
 * What to replay. `settings` are fast mode's two settings;
 * `Selection.defaultSettings` applies without them. With `allowDocker`, a
 * job that starts a container program is replayed
 * (`Inventory.allowingDocker`) and a step may reach a container daemon;
 * without it no step does.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReplayRequest {
  readonly root: string
  readonly commits: number
  readonly modes: ReadonlyArray<Mode>
  readonly jobs?: number | undefined
  readonly cache?: string | undefined
  /** Smithers build patterns to replay, on a repository that already builds with Smithers build. */
  readonly targets?: ReadonlyArray<string> | undefined
  readonly settings?: Settings | undefined
  readonly allowDocker?: boolean | undefined
  /**
   * How many minutes a step may go with no CPU used by its whole process tree
   * and nothing printed before it is stopped and has failed. The default is
   * 10; a fraction is allowed.
   */
  readonly stallMinutes?: number | undefined
  /**
   * Runs the baseline once before any counted commit, at the first commit the
   * replay runs, and replays only the jobs that pass there. A job that fails
   * runs once more, at the newest commit; one that fails again is listed with
   * the reason `Inventory.failsHere`.
   */
  readonly trial?: boolean | undefined
  /**
   * Runs the newest commit once more, in normal mode, in a copy made as
   * `apply` leaves the repository: the generated files written and
   * committed. A step that passes on the commit's files and fails there is a
   * mismatch of normal mode at that commit, with `Mismatch.cause`. The run
   * is in no time but `ReplayReport.appliedMs`. A commit that already holds
   * the files has nothing more to run.
   */
  readonly applied?: boolean | undefined
  /**
   * Runs every way once at the parent of the oldest replayed commit before
   * the first counted commit, so each starts with the caches a CI run finds.
   * That run is in no time but `ReplayReport.firstRun`. With `trial`, the
   * baseline's run there is the one that finds the jobs that pass. Without
   * `warm`, or when there is no such commit to run, the first counted commit
   * starts with an empty cache and `ReplayReport.cold` says why.
   */
  readonly warm?: boolean | undefined
  /**
   * How many times a failed step runs again to tell a flaky failure from a
   * broken one; 0 is never. A step that failed the same way, with the same
   * exit code and first line of error, in the same way's run of the commit
   * before, or in the first run, is not run again. Without it, the replay
   * uses the number its host sets.
   */
  readonly reruns?: number | undefined
}

/**
 * Renders a replay report as text. Pure.
 *
 * @category parts
 * @since 0.1.0
 */
export type RenderReport = (report: ReplayReport) => string

/**
 * Builds the entries fast mode asks the model about for one commit, from that commit's
 * normal-mode run record. With the commit's plan it measures each target's
 * distance from the changed files; without it that distance is unknown.
 *
 * @category parts
 * @since 0.1.0
 */
export type BuildRows<R = never> = (
  root: string,
  record: RunRecord,
  plan?: Plan
) => Effect.Effect<ReadonlyArray<Row>, Failure, R>

/**
 * Asks the model about entries: for each, the chance its target fails on its
 * change.
 *
 * @category parts
 * @since 0.1.0
 */
export type ScoreRows<R = never> = (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<Score>, Failure, R>

/**
 * Splits coarse CI steps into finer ones that name what they read, so a
 * change reruns only the steps it reaches: a step that runs a task over a
 * whole workspace becomes one step per package. It is given the CI
 * (`Inventory.ci`) and returns it with those steps replaced; each new step
 * has `inputs` and `from`. A step it cannot split is returned as it was.
 * Exported as `split` from `src/decompose`.
 *
 * @category parts
 * @since 0.1.0
 */
export type Decompose<R = never> = (root: string, inventory: Ci) => Effect.Effect<Ci, Failure, R>

/**
 * The parts a replay calls. The command-line program passes them, so the
 * replay imports no other part. Without `decompose` the CI is run unsplit.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReplayParts<R = never> {
  readonly read: ReadInventory<R>
  readonly decompose?: Decompose<R> | undefined
  readonly files: GenerateFiles<R>
  readonly rows: BuildRows<R>
  readonly score: ScoreRows<R>
}

/**
 * Replays past commits and reports. It never changes the repository at
 * `root`; every run happens in a copy.
 *
 * For each commit it reads the inventory from that commit's own tree,
 * narrows it with `Inventory.ci`, runs that as the baseline, then generates
 * targets from the decomposed CI and runs them. The newest commit's CI must
 * be replayable, or the replay fails `unsupported`. An older commit whose CI
 * is not is left out of `commits` and listed in
 * `ReplayReport.notReplayedCommits`. It compares each baseline step's verdict with
 * `RunRecord.combine` of the verdicts of the step's targets, found with
 * `TargetMap.labelsOf` in the target map among the generated files.
 *
 * Not everything in a `Ci` is replayed. A matrix variant whose runner is
 * another operating system (`Inventory.hostOf`) is not run in the baseline
 * and its targets are not named to Smithers build (`Inventory.otherSystem`).
 * A job with a step the generator made no target for is not replayed
 * (`Inventory.noTarget`), and neither is a job that needs a job left out.
 * Each is listed in `ReplayReport.notReplayed`.
 *
 * @category parts
 * @since 0.1.0
 */
export type RunReplay<R = never> = (
  request: ReplayRequest,
  parts: ReplayParts<R>
) => Effect.Effect<ReplayReport, Failure, R>

/**
 * One language's strategy for contract 9: the closure of each entry, in the
 * repository at `root`. Each strategy exports it as `close` from
 * `src/closure/<language>`.
 *
 * @category parts
 * @since 0.1.0
 */
export type CloseEntries<R = never> = (
  root: string,
  entries: ReadonlyArray<string>
) => Effect.Effect<ReadonlyArray<Closure>, Failure, R>
