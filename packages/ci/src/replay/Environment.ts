/**
 * What a CI step run by the replay may see and reach of the machine it runs
 * on.
 *
 * @throws {never}
 * @since 0.1.0
 */

import { toolEnvironment } from "@smthrs/targets/Exec"
import { availableParallelism } from "node:os"
import { delimiter } from "node:path"

/**
 * The directories a replay makes for its steps and removes when it ends: the
 * home every step gets in place of the person's, the temporary directory a
 * jailed step finds in place of the machine's, and `guard`, which holds the
 * stand-ins first on every step's `PATH`. The first two are kept for the whole
 * replay, so what a package manager caches at one commit is there at the next.
 *
 * @category models
 * @since 0.1.0
 */
export interface Place {
  readonly home: string
  readonly tmp: string
  readonly guard: string
}

/**
 * The programs no step of a replay can start by name: each has a stand-in
 * that refuses, first on the step's `PATH`.
 *
 * @category constants
 * @since 0.1.0
 */
export const guardedPrograms = ["sudo", "su", "doas"] as const

/**
 * The stand-in for `program`. It prints one line on standard error, with what
 * it was asked to run on that one line, and exits 1. It uses nothing but the
 * shell, so it works where a step sees few programs.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const guardScript = (program: string): string =>
  [
    "#!/bin/sh",
    "set -f",
    "IFS=$(printf ' \\t\\n_')",
    "IFS=${IFS%_}",
    "set -- $*",
    `printf '%s\\n' "smithers-ci does not run ${program}: $*" >&2`,
    "exit 1",
    ""
  ].join("\n")

/**
 * A `PATH` that finds the stand-ins in `guard` first. With no `PATH` to add
 * to it is `guard` alone: an empty entry would mean the working directory.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const guardedPath = (guard: string, path: string | undefined): string =>
  path === undefined || path === "" ? guard : `${guard}${delimiter}${path}`

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
 * puts the replay's own behind it. Its `PATH` is the machine's, after the
 * stand-ins, and it reaches a target through the `smthrs` that starts it.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const placeEnvironment = (place: Place): Readonly<Record<string, string>> => ({
  HOME: place.home,
  XDG_CACHE_HOME: `${place.home}/.cache`,
  PATH: guardedPath(place.guard, process.env["PATH"])
})

/**
 * The whole environment of a baseline step: what Smithers build gives a
 * target (a short list of host variables such as `PATH`, and fixed locale and
 * color settings), the replay's own home, the push refusal, then the step's
 * own `env`. A step is a past commit's command, so
 * it gets no other variable of the person running the replay, and the
 * baseline and the target see the same environment. A `PATH` of the step's
 * own still starts with the stand-ins.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const stepEnvironment = (
  declared: Readonly<Record<string, string>>,
  place: Place
): Readonly<Record<string, string | undefined>> => ({
  ...toolEnvironment({
    ...placeEnvironment(place),
    ...pushRefusal,
    ...declared,
    ...(declared["PATH"] === undefined ? {} : { PATH: guardedPath(place.guard, declared["PATH"]) })
  }, [])
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

/**
 * How many steps this machine runs at once when nobody says: its cores, as
 * Smithers build counts them for a run with no `--jobs`.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const coreCount = (): number => Math.max(1, availableParallelism())
