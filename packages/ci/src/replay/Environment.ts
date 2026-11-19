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
import { runnerSoftware } from "../contract/Inventory.ts"

/**
 * The directories a replay makes for the steps of one way of running a
 * commit and removes when it ends: the home a step gets in place of the
 * person's, the temporary directory a jailed step finds in place of the
 * machine's, and `guard`, which holds the stand-ins first on every step's
 * `PATH`. The baseline, normal mode and fast mode each have their own home and
 * temporary directory, so each fills its caches itself. A baseline job has a
 * home and a temporary directory of its own beside its way's
 * (`Confine.machine`), as each job of a workflow starts on a runner of its
 * own, and a mode's are emptied before each commit (`Confine.renew`).
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
 * The variable that names, to Smithers build, the directory every job's home
 * starts as a copy of. In normal and fast mode Smithers build gives the
 * targets of each job a machine of their own, and makes its home.
 *
 * @category constants
 * @since 0.1.0
 */
export const jobHomeVariable = "SMTHRS_MACHINE_HOME"

/**
 * The variable that names, to Smithers build, the directory it keeps the
 * machines of its jobs in. Every way of a replay names the same one, so a
 * job's machine is at the same paths in the baseline and in each mode.
 *
 * @category constants
 * @since 0.1.0
 */
export const machinesVariable = "SMTHRS_MACHINES"

/**
 * The programs no step of a replay can start by name: each has a stand-in
 * that refuses, first on the step's `PATH`.
 *
 * @category constants
 * @since 0.1.0
 */
export const guardedPrograms = ["sudo", "su", "doas"] as const

/**
 * The programs that talk to a container daemon. Whoever talks to one can have
 * it mount any file of the machine, so a step that starts one by name finds a
 * stand-in that refuses, unless the person allows Docker.
 *
 * @category constants
 * @since 0.1.0
 */
export const containerPrograms = ["docker", "docker-compose", "podman", "nerdctl"] as const

/**
 * The stand-in for `program`. It prints one line on standard error, with what
 * it was asked to run on that one line, and exits 1. `unless` names what
 * would let the program run, as in `smithers-ci does not run docker without
 * --allow-docker: run alpine`. It uses nothing but the shell, so it works
 * where a step sees few programs.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const guardScript = (program: string, unless: string = ""): string =>
  [
    "#!/bin/sh",
    "set -f",
    "IFS=$(printf ' \\t\\n_')",
    "IFS=${IFS%_}",
    "set -- $*",
    `printf '%s\\n' "smithers-ci does not run ${program}${unless}: $*" >&2`,
    "exit 1",
    ""
  ].join("\n")

/**
 * What a container program's stand-in adds after the program's name.
 *
 * @category constants
 * @since 0.1.0
 */
export const withoutAllowDocker = " without --allow-docker"

/**
 * The stand-ins a replay puts first on its steps' `PATH`, each as a program
 * name and its script: one for each of {@link guardedPrograms}, and one for
 * each of {@link containerPrograms} unless the person allows Docker.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const standIns = (allowDocker: boolean): ReadonlyArray<readonly [program: string, script: string]> => [
  ...guardedPrograms.map((program) => [program, guardScript(program)] as const),
  ...(allowDocker
    ? []
    : containerPrograms.map((program) => [program, guardScript(program, withoutAllowDocker)] as const))
]

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
 * The push URL of every copy the replay makes. Nothing is there, so a step
 * that pushes to its remote fails. The fetch URL stays the repository's: it
 * names the repository to what reads the copy.
 *
 * @category constants
 * @since 0.1.0
 */
export const noPushUrl = "/dev/null/smithers-ci-replay-copies-do-not-push"

/**
 * The `.gitconfig` of a step's home. It says what {@link pushRefusal} says to
 * a `git` whose environment a tool has emptied on the way.
 *
 * @category constants
 * @since 0.1.0
 */
export const gitConfig = `[core]\n\thooksPath = ~/${hooksDirectory}\n[credential]\n\thelper =\n`

/**
 * What the `.gitconfig` adds when a repository's own targets run. Smithers
 * build passes such a target the home and not {@link pushRefusal}, and a
 * repository's configuration can name another hooks directory over this file.
 * So every address is rewritten, for a push alone, to one where nothing is:
 * the push fails before anything is sent.
 *
 * @category constants
 * @since 0.1.0
 */
export const pushesGoNowhere = `[url "${noPushUrl}"]\n\tpushInsteadOf =\n`

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
 * The variables of the person's that tell a step where a container daemon
 * is. A step gets them only when the person allows Docker.
 *
 * @category constants
 * @since 0.1.0
 */
export const daemonVariables: ReadonlyArray<string> = ["DOCKER_HOST"]

/**
 * What a step is told of the container daemon: nothing, or with
 * `allowDocker` the person's own {@link daemonVariables} that are set.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const daemonEnvironment = (
  allowDocker: boolean,
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    daemonVariables.flatMap((name) => {
      const value = environment[name]
      return allowDocker && value !== undefined ? [[name, value]] : []
    })
  )

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
 * What a step that runs as on a GitHub runner is told of the software this
 * machine has: each of {@link runnerSoftware} that is set to something.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const softwareEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    runnerSoftware.flatMap((name) => {
      const value = environment[name]
      return value === undefined || value === "" ? [] : [[name, value]]
    })
  )

/**
 * The variables of the person who runs the replay, as this process has them.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * The directories this machine looks for a program in.
 *
 * @category environment
 * @throws {never}
 * @since 0.1.0
 */
export const searchPath = (): ReadonlyArray<string> => (process.env["PATH"] as string).split(":")

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
