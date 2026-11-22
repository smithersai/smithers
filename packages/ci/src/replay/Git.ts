/**
 * How smithers-ci starts git, wherever it starts it: in the person's
 * repository, in the replay's own clone and in the copies its steps run in.
 *
 * Git 2.29 and later run `git maintenance run --auto` after a command that
 * writes objects, such as a commit or a fetch, and git 2.47 and later start
 * it detached: it goes on after the call has ended, takes
 * `.git/objects/maintenance.lock` and may repack. smithers-ci reads the
 * person's repository and writes only in copies it removes, so every git it
 * starts runs with automatic maintenance and garbage collection off for that
 * call. The person's configuration is not changed.
 *
 * @throws {never}
 * @since 0.1.0
 */

/**
 * The options every git smithers-ci starts is given before its own:
 * `maintenance.auto` for git 2.29 and later, `gc.auto` for the `git gc --auto`
 * older releases run in its place.
 *
 * @category running
 * @since 0.1.0
 */
export const noUpkeep: ReadonlyArray<string> = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"]

/**
 * The arguments that run git with `args` and no upkeep of its own.
 *
 * @throws {never}
 * @category running
 * @since 0.1.0
 */
export const gitArguments = (args: ReadonlyArray<string>): Array<string> => [...noUpkeep, ...args]
