/**
 * The importer: reads what a repository's CI does today into contract 4.
 *
 * @since 0.1.0
 */

/**
 * Reads the CI of a repository, with the contract 10 type `ReadInventory`.
 *
 * @category parts
 * @since 0.1.0
 */
export { read } from "./Read.vibe"

/**
 * Reads the CI of a repository for the machine it is on: a CI job this
 * machine cannot run, for its operating system or for a tool it lacks, is
 * marked, so a replay leaves it out and lists it.
 *
 * @category parts
 * @since 0.1.0
 */
export { readHere } from "./Machine.vibe"
