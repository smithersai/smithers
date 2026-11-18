/**
 * Fast mode: builds rows, scores them, measures the result.
 *
 * `rows` and `score` are this part's two functions under contract 10. A host
 * gives `rows` a {@link Repository}, a {@link Ledger} and the process runner
 * its `git` starts with, and gives `score`
 * the judge (`Evaluator` from `@smthrs/model`), a flow engine (`FlowRuntime`
 * from `@smthrs/flow`) and Effect's `Digest` and `SecureRandom`.
 *
 * @since 0.1.0
 */

import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { BuildRows, ScoreRows } from "../contract/Parts.ts"
import type { Ledger } from "./Ledger.vibe"
import type { Repository } from "./Repository.vibe"
import * as Rows from "./Rows.vibe"
import * as Score from "./Score.vibe"

/**
 * Builds the rows fast mode scores for one commit, from that commit's
 * normal-mode run record, and records them in the ledger.
 *
 * @category parts
 * @since 0.1.0
 */
export const rows: BuildRows<ChildProcessSpawner | Ledger | Repository> = Rows.rows

/**
 * Scores rows: for each, the chance its target fails on its change, from 0
 * to 1, with a one-line reason. Each request to the judge is a durable flow
 * step.
 *
 * @category parts
 * @since 0.1.0
 */
export const score: ScoreRows<Score.Host> = Score.score

/**
 * The six features and the labels, as pure functions.
 *
 * @category modules
 * @since 0.1.0
 */
export * as Features from "./Features.ts"

/**
 * The rows and plans fast mode keeps for one repository.
 *
 * @category modules
 * @since 0.1.0
 */
export * as Ledger from "./Ledger.vibe"

/**
 * What a repository's history says about one change, read with git.
 *
 * @category modules
 * @since 0.1.0
 */
export * as Repository from "./Repository.vibe"

/**
 * The scorer's flow and its durable step.
 *
 * @category modules
 * @since 0.1.0
 */
export * as Score from "./Score.vibe"

/**
 * What the scorer asks the judge and how it reads the answers.
 *
 * @category modules
 * @since 0.1.0
 */
export * as Scoring from "./Scoring.ts"
