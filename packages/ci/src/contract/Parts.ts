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
import type { Inventory } from "./Inventory.ts"
import type { ReplayReport } from "./ReplayReport.ts"
import type { Mode, RunRecord } from "./RunRecord.ts"
import type { Row, Score } from "./Selection.ts"

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
  part: Schema.Literals(["inventory", "generate", "replay", "report", "select", "cli"])
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
 * The Smithers workspace, target files and CI workflow for an inventory. It
 * returns text and writes nothing.
 *
 * @category parts
 * @since 0.1.0
 */
export type GenerateFiles<R = never> = (
  inventory: Inventory
) => Effect.Effect<ReadonlyArray<GeneratedFile>, Failure, R>

/**
 * What to replay.
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
}

/**
 * Replays past commits and reports. It never changes the repository at
 * `root`; every run happens in a copy.
 *
 * @category parts
 * @since 0.1.0
 */
export type RunReplay<R = never> = (request: ReplayRequest) => Effect.Effect<ReplayReport, Failure, R>

/**
 * Renders a replay report as text. Pure.
 *
 * @category parts
 * @since 0.1.0
 */
export type RenderReport = (report: ReplayReport) => string

/**
 * Builds the rows fast mode scores for one commit, from that commit's
 * normal-mode run record.
 *
 * @category parts
 * @since 0.1.0
 */
export type BuildRows<R = never> = (
  root: string,
  record: RunRecord
) => Effect.Effect<ReadonlyArray<Row>, Failure, R>

/**
 * Scores rows: for each, the chance its target fails on its change.
 *
 * @category parts
 * @since 0.1.0
 */
export type ScoreRows<R = never> = (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<Score>, Failure, R>
