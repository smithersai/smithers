/**
 * Smithers CI: the contracts every part builds against.
 *
 * @since 0.1.0
 */

/**
 * Contract 9: the dependency closure, one strategy per language.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Closure from "./contract/Closure.ts"

/**
 * Contract 7: the commands, flags and exit codes of `smithers-ci`.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Command from "./contract/Command.ts"

/**
 * Contract 4: what a repository's CI does today.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Inventory from "./contract/Inventory.ts"

/**
 * Contract 2: the targets a change selects.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Plan from "./contract/Plan.ts"

/**
 * Contract 5: the replay report.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as ReplayReport from "./contract/ReplayReport.ts"

/**
 * Contract 1: the record of one run.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as RunRecord from "./contract/RunRecord.ts"

/**
 * Contract 6: fast mode's data, scorer and metrics.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Selection from "./contract/Selection.ts"

/**
 * Contract 8: dividing one run across machines.
 *
 * @category contracts
 * @since 0.1.0
 */
export * as Shard from "./contract/Shard.ts"
