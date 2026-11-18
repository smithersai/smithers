/**
 * What a CI step run by the replay may see and reach of the machine it runs
 * on.
 *
 * @throws {never}
 * @since 0.1.0
 */

import { toolEnvironment } from "@smthrs/targets/Exec"

/**
 * The directories a replay makes for its steps and removes when it ends: the
 * home every step gets in place of the person's, and the temporary directory
 * a jailed step finds in place of the machine's. Both are kept for the whole
 * replay, so what a package manager caches at one commit is there at the
 * next.
 *
 * @category models
 * @since 0.1.0
 */
export interface Place {
  readonly home: string
  readonly tmp: string
}

/**
 * Where the hook that refuses a push is, from a step's home.
 *
 * @category constants
 * @since 0.1.0
 */
export const hooksDirectory = ".smithers-ci/hooks"

/**
 * What `git push` prints when a step tries it.
 *
 * @category constants
 * @since 0.1.0
 */
export const pushRefused = "smithers-ci: a replayed step may not push; nothing was sent"

/**
 * The `pre-push` hook: it refuses every push before anything is sent.
 *
 * @category constants
 * @since 0.1.0
 */
export const prePush = `#!/bin/sh\necho "${pushRefused}" >&2\nexit 1\n`

/**
 * What every `git` a step starts is told through its environment, which a
 * repository's own configuration cannot undo: the hook that refuses a push,
 * no credential helper, and no question asked on the terminal. Every value is
 * the same on every machine and in every replay, so a target that passes
 * these on keeps its key. `~` is the step's home.
 *
 * @category constants
 * @since 0.1.0
 */
export const pushRefusal: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: `~/${hooksDirectory}`,
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_TERMINAL_PROMPT: "0"
}

/**
 * The `.gitconfig` of a step's home. It says what {@link pushRefusal} says to
 * a `git` whose environment a tool has emptied on the way.
 *
 * @category constants
 * @since 0.1.0
 */
export const gitConfig = `[core]\n\thooksPath = ~/${hooksDirectory}\n[credential]\n\thelper =\n`

/**
 * Where a step's home and cache are: in the replay's own directory, never
 * the person's. The temporary directory keeps the machine's name; the jail
 * puts the replay's own behind it.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const placeEnvironment = (place: Place): Readonly<Record<string, string>> => ({
  HOME: place.home,
  XDG_CACHE_HOME: `${place.home}/.cache`
})

/**
 * The whole environment of a baseline step: what Smithers build gives a
 * target (a short list of host variables such as `PATH`, and fixed locale and
 * color settings), the replay's own home, the push refusal, then the step's
 * own `env`. A step is a past commit's command, so
 * it gets no other variable of the person running the replay, and the
 * baseline and the target see the same environment.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const stepEnvironment = (
  declared: Readonly<Record<string, string>>,
  place: Place
): Readonly<Record<string, string | undefined>> => ({
  ...toolEnvironment({ ...placeEnvironment(place), ...pushRefusal, ...declared }, [])
})

/**
 * The directories this machine looks for a program in.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const searchPath = (): ReadonlyArray<string> => (process.env["PATH"] as string).split(":")

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
