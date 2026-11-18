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
 * A machine's answer for a person whose variables are `environment`: they say
 * where the person's session and container daemon are.
 */
const answer = (
  facts: ExecSandbox.Host,
  refuses: (facts: ExecSandbox.Host) => string | undefined,
  environment: Readonly<Record<string, string | undefined>>
): Probe => {
  const refusal = refuses(facts)
  return refusal === undefined
    ? {
      bwrap: facts.executable("bwrap") as string,
      home: facts.home as string,
      hidden: [`/run/user/${facts.uid}`],
      daemons: daemonSockets(facts.uid, environment),
      tmp: tmpdir(),
      caches: [join(tmpdir(), `tsx-${facts.uid}`), join(tmpdir(), `vibelang-cache-${facts.uid}`)]
    }
    : { refusal }
}

/**
 * Asks a machine, this one unless `facts` describes another. It can jail a
 * step when it runs Linux and bubblewrap starts; `refuses` starts bubblewrap
 * once to know, and says why when it cannot. Beside the credentials of the home, a step must not reach the
 * person's runtime directory: the key agents and the secret service of a
 * session listen there. Nor may it reach a container daemon's socket
 * ({@link daemonSockets}). The caches kept in sight are where a `smthrs`
 * started from source keeps its compiled code, TypeScript's and VibeLang's:
 * without them every replay would compile `smthrs` again. An installed
 * `smthrs` has neither. The person's variables are read from this process;
 * {@link probeWith} asks for a person whose variables are held elsewhere.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const probe = (
  facts: ExecSandbox.Host = ExecSandbox.host(),
  refuses: (facts: ExecSandbox.Host) => string | undefined = ExecSandbox.writeProtectionRefusal
): Probe => answer(facts, refuses, process.env)

/**
 * Asks this machine, for a person whose variables are `environment`.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const probeWith = (environment: Readonly<Record<string, string | undefined>>): Probe =>
  answer(ExecSandbox.host(), ExecSandbox.writeProtectionRefusal, environment)

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
 * directories, and what they still read of those. `filter` is the file that
 * holds {@link keyringFilter}.
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
  readonly filter: string
}

/**
 * The kernel's three key calls, `add_key`, `request_key` and `keyctl`, by the
 * number each processor gives them: x86-64 with its x32 form, 32-bit x86,
 * 64-bit Arm and 32-bit Arm. A 64-bit kernel also runs its 32-bit programs,
 * so both forms are named.
 */
const keyCalls: ReadonlyArray<readonly [processor: number, calls: ReadonlyArray<number>]> = [
  [0xC000003E, [248, 249, 250, 0x40000000 + 248, 0x40000000 + 249, 0x40000000 + 250]],
  [0x40000003, [286, 287, 288]],
  [0xC00000B7, [217, 218, 219]],
  [0x40000028, [309, 310, 311]]
]

/** One instruction of a seccomp filter: an operation, two jumps and a value. */
const instruction = (operation: number, whenTrue: number, whenFalse: number, value: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, operation, true)
  view.setUint8(2, whenTrue)
  view.setUint8(3, whenFalse)
  view.setUint32(4, value, true)
  return bytes
}

/**
 * The seccomp filter a jailed step runs under, as bubblewrap loads it. It
 * refuses the kernel's key calls with "not implemented" and allows every
 * other call.
 *
 * A session's kernel keyring is inherited by every process the session
 * starts, the jail's included: without the filter a step reads the keys the
 * person's session holds, such as a Kerberos ticket. With it, a tool that
 * looks for a keyring finds a kernel that has none.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const keyringFilter = (): Uint8Array => {
  const load = (offset: number) => instruction(0x20, 0, 0, offset)
  const equal = (value: number, whenTrue: number, whenFalse: number) => instruction(0x15, whenTrue, whenFalse, value)
  const answer = (value: number) => instruction(0x06, 0, 0, value)
  const allow = answer(0x7FFF0000)
  const notImplemented = answer(0x00050000 + 38)
  // For each processor: skip the block when the call is another processor's, else refuse its key calls.
  const program = [
    ...keyCalls.flatMap(([processor, calls]) => [
      load(4),
      equal(processor, 0, calls.length + 3),
      load(0),
      ...calls.map((call, index) => equal(call, calls.length - index, 0)),
      allow,
      notImplemented
    ]),
    allow
  ]
  const bytes = new Uint8Array(program.length * 8)
  program.forEach((each, index) => bytes.set(each, index * 8))
  return bytes
}

/**
 * Closes every descriptor but standard input, output and error. A program
 * passes on to what it starts each descriptor it was started with and never
 * closed: a file its caller opened, or the channel a tool that started
 * `smithers-ci` talks to it through. A step gets none of them.
 */
const closes = [
  "for d in /proc/self/fd/* /dev/fd/*; do",
  "  n=${d##*/}",
  "  case $n in *[!0-9]*|[012]) ;; *) eval \"exec $n<&-\" ;; esac",
  "done"
].join("\n")

/**
 * What the shell runs to start a command with its three descriptors only. A
 * command that is not there is named, as the system names one it cannot start.
 */
const bare = [
  closes,
  "command -v -- \"$1\" > /dev/null 2>&1 || { printf 'could not run %s\\n' \"$1\" >&2; exit 127; }",
  "exec \"$@\""
].join("\n")

/** The same, with the jail's filter open as descriptor 9 for bubblewrap to load. */
const withFilter = `${closes}\nexec "$@" 9< "$0"`

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
 * The command that runs `argv` in the jail, or on its own with no jail. Either
 * way a shell starts it, with no descriptor but standard input, output and
 * error.
 *
 * In the jail every file of the machine is read-only, the masks are empty
 * but for what each keeps, and only `writable` can be written; `sealed` names paths under a writable
 * one that stay read-only. The machine's temporary directories are the
 * replay's own, so a step that writes `/tmp` writes nothing of the machine's
 * and finds nothing another program left there. The step has its own device
 * and process trees, the kernel refuses it the keys of the person's session
 * ({@link keyringFilter}), and it ends, with everything it started, when the
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
  jail === undefined ? ["bash", "-c", bare, "smithers-ci", ...argv] : [
    "bash",
    "-c",
    withFilter,
    jail.filter,
    jail.bwrap,
    "--seccomp",
    "9",
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
