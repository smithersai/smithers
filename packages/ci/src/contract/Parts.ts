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
 * something Smithers CI cannot run yet; the command-line program exits 3.
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
 * One file to write, by path relative to the repository root.
 *
 * @category models
 * @since 0.1.0
 */
export interface GeneratedFile {
  readonly path: string
  readonly content: string
}

/**
 * Choices the generated files carry. `cache` is the URL of the shared cache
 * the generated workspace and workflow name.
 *
 * @category models
 * @since 0.1.0
 */
export interface GenerateOptions {
  readonly cache?: string | undefined
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
 * `Selection.defaultSettings` applies without them.
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
}

/**
 * Renders a replay report as text. Pure.
 *
 * @category parts
 * @since 0.1.0
 */
export type RenderReport = (report: ReplayReport) => string

/**
 * Builds the rows fast mode scores for one commit, from that commit's
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
 * Scores rows: for each, the chance its target fails on its change.
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
