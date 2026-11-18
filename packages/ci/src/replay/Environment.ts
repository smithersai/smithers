/**
 * What a CI step run by the replay may see and reach of the machine it runs
 * on.
 *
 * @throws {never}
 * @since 0.1.0
 */

import { toolEnvironment } from "@smthrs/targets/Exec"

/**
 * The whole environment of a baseline step: what Smithers build gives a
 * target (a short list of host variables such as `PATH` and `HOME`, and
 * fixed locale and color settings), then the step's own `env`. A step is a
 * past commit's command, so it gets no other variable of the person running
 * the replay, and the baseline and the target see the same environment.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const stepEnvironment = (
  declared: Readonly<Record<string, string>>
): Readonly<Record<string, string | undefined>> => ({ ...toolEnvironment(declared, []) })

/**
 * The push URL of every copy the replay makes. Nothing is there, so a step
 * that pushes to its remote fails. The fetch URL stays the repository's: it
 * names the repository to what reads the copy.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const noPushUrl = "/dev/null/smithers-ci-replay-copies-do-not-push"

/**
 * This machine's operating system, in Node's names. A matrix variant for
 * another system is not replayed here.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const thisHost = (): string => process.platform
