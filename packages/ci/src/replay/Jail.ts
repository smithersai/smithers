/**
 * The file-system jail a replayed step runs in, where the machine can hold
 * one: the whole file system read-only but the places the step is given, and
 * the person's credentials out of sight.
 *
 * @since 0.1.0
 */

import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The files and directories of a home directory that hold a credential: the
 * keys, the tokens of the package registries, the clouds and the hosts, and
 * what a git credential helper stores. A jailed step cannot read them.
 *
 * @category constants
 * @since 0.1.0
 */
export const credentials: ReadonlyArray<string> = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".gitconfig",
  ".git-credentials",
  ".git-credential-cache",
  ".cache/git/credential",
  ".config/git",
  ".config/gh"
]

/**
 * Where a container daemon listens on a machine: Docker's socket under its
 * two names, the sockets of a rootless Docker and of Podman in the session's
 * runtime directory, and the socket `DOCKER_HOST` names. Whoever talks to one
 * can have the daemon mount any file of the machine, so a jailed step finds
 * none of them.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const daemonSockets = (
  uid: number | undefined,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  const runtime = environment["XDG_RUNTIME_DIR"] ?? `/run/user/${uid}`
  const named = /^unix:\/\/(\/.+)$/.exec(environment["DOCKER_HOST"] ?? "")?.[1]
  return [
    ...new Set([
      "/var/run/docker.sock",
      "/run/docker.sock",
      `${runtime}/docker.sock`,
      `${runtime}/podman/podman.sock`,
      ...(named === undefined ? [] : [named])
    ])
  ]
}

/**
 * What a machine answers when asked whether it can jail a step: why it
 * cannot, or the bubblewrap program with what the jail is built around. `home`
 * is the person's home directory, and `hidden` the other paths a step must
 * find empty. `daemons` are the sockets of the container daemons, which a
 * step finds empty too unless the person allows Docker. `tmp` is the
 * machine's temporary directory, which a step finds replaced, and `caches`
 * the directories in it a step still reads.
 *
 * @category models
 * @since 0.1.0
 */
export type Probe =
  | {
    readonly bwrap: string
    readonly home: string
    readonly hidden: ReadonlyArray<string>
    readonly daemons: ReadonlyArray<string>
    readonly tmp: string
    readonly caches: ReadonlyArray<string>
  }
  | { readonly refusal: string }

/**
 * Asks a machine, this one unless `facts` describes another. It can jail a
 * step when it runs Linux and bubblewrap starts; `refuses` starts bubblewrap
 * once to know, and says why when it cannot. Beside the credentials of the home, a step must not reach the
 * person's runtime directory: the key agents and the secret service of a
 * session listen there. Nor may it reach a container daemon's socket
 * ({@link daemonSockets}). The caches kept in sight are where a `smthrs`
 * started from source keeps its compiled code, TypeScript's and VibeLang's:
 * without them every replay would compile `smthrs` again. An installed
 * `smthrs` has neither.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const probe = (
  facts: ExecSandbox.Host = ExecSandbox.host(),
  refuses: (facts: ExecSandbox.Host) => string | undefined = ExecSandbox.writeProtectionRefusal
): Probe => {
  const refusal = refuses(facts)
  return refusal === undefined
    ? {
      bwrap: facts.executable("bwrap") as string,
      home: facts.home as string,
      hidden: [`/run/user/${facts.uid}`],
      daemons: daemonSockets(facts.uid, process.env),
      tmp: tmpdir(),
      caches: [join(tmpdir(), `tsx-${facts.uid}`), join(tmpdir(), `vibelang-cache-${facts.uid}`)]
    }
    : { refusal }
}

/**
 * A path a jailed step finds empty: a credential of the person's, or the
 * socket of a container daemon. `kept` are the paths inside a hidden
 * directory a step still reaches: a daemon's socket in the session's runtime
 * directory, when the person allows Docker.
 *
 * @category models
 * @since 0.1.0
 */
export interface Mask {
  readonly path: string
  readonly directory: boolean
  readonly kept?: ReadonlyArray<string> | undefined
}

/**
 * The jail of one replay: the program that holds it, what it hides, the
 * directory its steps find in place of each of the machine's `temporary`
 * directories, and what they still read of those.
 *
 * @category models
 * @since 0.1.0
 */
export interface Jail {
  readonly bwrap: string
  readonly masks: ReadonlyArray<Mask>
  readonly tmp: string
  readonly temporary: ReadonlyArray<string>
  readonly visible: ReadonlyArray<string>
}

/**
 * The directories a jailed step finds replaced by the replay's own: `/tmp`,
 * where Smithers build keeps its sockets whatever `TMPDIR` says, and the
 * machine's temporary directory when it is another.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const temporaryOf = (tmp: string): ReadonlyArray<string> => [...new Set(["/tmp", tmp])]

/**
 * The entries of the `temporary` directories that hold `paths`, each once. A
 * jailed step finds those directories replaced, and what the replay itself
 * runs from one, as `bunx` installs a program in `/tmp`, must stay in sight.
 * A path in two of them belongs to the deeper one.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const temporaryRoots = (
  paths: ReadonlyArray<string>,
  temporary: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const deepestFirst = [...temporary].sort((left, right) => right.length - left.length)
  const rootOf = (path: string): ReadonlyArray<string> => {
    const holder = deepestFirst.find((directory) => path.startsWith(`${directory}/`))
    const name = holder === undefined ? "" : path.slice(holder.length + 1).split("/")[0] as string
    const root = `${holder}/${name}`
    return name === "" || temporary.includes(root) ? [] : [root]
  }
  return [...new Set(paths.flatMap(rootOf))]
}

/**
 * What the program says, once, on a machine that cannot jail a step. With
 * `allowDocker` a step starts the machine's container programs, so the line
 * does not say it cannot.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const unjailed = (refusal: string, allowDocker: boolean = false): string =>
  `steps run without a file-system jail: ${refusal}. Each step still gets a home directory of its own and cannot ` +
  `push with git${allowDocker ? "" : " or start docker or podman by name"}`

/**
 * The command that runs `argv` in the jail, or `argv` itself with no jail.
 *
 * In the jail every file of the machine is read-only, the masks are empty
 * but for what each keeps, and only `writable` can be written; `sealed` names paths under a writable
 * one that stay read-only. The machine's temporary directories are the
 * replay's own, so a step that writes `/tmp` writes nothing of the machine's
 * and finds nothing another program left there. The step has its own device
 * and process trees, and it ends, with everything it started, when the
 * replay does. The network stays as it is.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const jailed = (
  jail: Jail | undefined,
  writable: ReadonlyArray<string>,
  sealed: ReadonlyArray<string>,
  argv: readonly [string, ...Array<string>]
): readonly [string, ...Array<string>] =>
  jail === undefined ? argv : [
    jail.bwrap,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-pid",
    "--proc",
    "/proc",
    ...jail.masks.flatMap((mask) =>
      mask.directory
        ? [
          "--tmpfs",
          mask.path,
          ...(mask.kept ?? []).flatMap((path) => ["--bind", path, path]),
          "--remount-ro",
          mask.path
        ]
        : ["--ro-bind", "/dev/null", mask.path]
    ),
    ...jail.temporary.flatMap((directory) => ["--bind", jail.tmp, directory]),
    ...jail.visible.flatMap((path) => ["--ro-bind", path, path]),
    ...writable.flatMap((path) => ["--bind", path, path]),
    ...sealed.flatMap((path) => ["--ro-bind", path, path]),
    "--new-session",
    "--die-with-parent",
    "--",
    ...argv
  ]
