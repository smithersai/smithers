/**
 * The file-system jail a replayed step runs in, where the machine can hold
 * one: the whole file system read-only but the places the step is given, and
 * the person's credentials out of sight.
 *
 * @since 0.1.0
 */

import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { spawnSync } from "node:child_process"
import { readdirSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { inPlainWords } from "./Reads.vibe"

/**
 * The files and directories of a home directory that hold a credential: the
 * keys, the tokens of the package registries, the clouds and the hosts, and
 * what a git credential helper stores. A jailed step finds the whole home
 * empty, so it reads none of them there. One that is a link out of the home is
 * hidden where it leads as well.
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
 * cannot, or the bubblewrap program with what the jail is built around. A
 * machine that cannot still says which links a step's own home needs
 * (`homes`), because a step has a home of its own there too. `home`
 * is the person's home directory, which a step finds empty but for `tools`,
 * and `hidden` the other paths a step must find empty. `daemons` are the sockets of the container daemons, which a
 * step finds empty too unless the person allows Docker. `tmp` is the
 * machine's temporary directory, which a step finds replaced, and `caches`
 * the directories in it a step still reads. `scope` is the perl that keeps a
 * step from the abstract sockets of the machine, where the kernel can
 * ({@link scopeProgram}).
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
    readonly tools: Tools
    readonly scope?: string | undefined
  }
  | { readonly refusal: string; readonly homes?: ReadonlyArray<Link> | undefined; readonly trustedRepository?: boolean }

/**
 * A link: where it is and what it names.
 *
 * @category models
 * @since 0.1.0
 */
export interface Link {
  readonly path: string
  readonly target: string
}

/**
 * The tools a step finds by name on a machine whose home it cannot read, as
 * Smithers build finds them for a confined run: `reads` are the installs the
 * programs on `PATH` live in, `links` the links a program is reached through
 * that no install holds, and `homes` the links a step's own home needs so a
 * version manager finds its versions there, such as `.rustup` or each package
 * manager corepack keeps, each from the step's home.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tools {
  readonly reads: ReadonlyArray<string>
  readonly links: ReadonlyArray<Link>
  readonly homes: ReadonlyArray<Link>
}

/** A directory no tool is in: Smithers build's search leaves out what lies in the workspace it is told. */
const nowhere = "/nonexistent/smithers-ci"

/**
 * The tools on a search path, for a machine described by `facts`.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const toolsOn = (
  searchPath: string | undefined,
  facts: ExecSandbox.Host,
  environment: Readonly<Record<string, string | undefined>> = {}
): Tools => {
  const found = ExecSandbox.toolchain(searchPath, nowhere, facts)
  const corepack = corepackVersions(facts.home, environment)
  return {
    reads: [...found.reads, ...corepack.map((link) => link.target)],
    links: found.links,
    homes: [
      ...found.privateLinks.flatMap((link) =>
        link.path.startsWith("home/") ? [{ path: link.path.slice("home/".length), target: link.target }] : []
      ),
      ...corepack
    ]
  }
}

/**
 * The package managers the person's corepack keeps, `<cache>/v1/<name>/<version>`:
 * a tool home, as a version manager's is. A step's corepack looks under the
 * step's own home (`.cache/node/corepack`) and finds each of them linked
 * there, read where it is and never written. A version the cache does not
 * hold it fetches into the step's own home, as on a runner. The cache is where
 * the person's corepack keeps it: `COREPACK_HOME`, else `node/corepack` in
 * `XDG_CACHE_HOME`, else in the home's `.cache`.
 */
const corepackVersions = (
  home: string | undefined,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<Link> => {
  const caches = environment["XDG_CACHE_HOME"] ?? (home === undefined ? undefined : join(home, ".cache"))
  const cache = environment["COREPACK_HOME"] ?? (caches === undefined ? undefined : join(caches, "node", "corepack"))
  if (cache === undefined) return []
  return entries(join(cache, "v1")).flatMap((name) =>
    entries(join(cache, "v1", name)).flatMap((version) => {
      const real = realDirectory(join(cache, "v1", name, version))
      return real === undefined ? [] : [{ path: `.cache/node/corepack/v1/${name}/${version}`, target: real }]
    })
  )
}

/** The names in a directory, in order; none where there is no directory to read. */
const entries = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

/** Where a directory really is, or nothing for a path that is not a directory. */
const realDirectory = (path: string): string | undefined => {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * The places outside the person's home where a machine keeps what a step has
 * no use for and must not read: the home of every other user and of root,
 * the mail and the scheduled commands of its users, the secrets a container
 * platform mounts, and the stores of the container daemons.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const elsewhere = (facts: ExecSandbox.Host): ReadonlyArray<string> => [
  ...(facts.entries?.("/home") ?? []).map((name) => `/home/${name}`).filter((home) => home !== facts.home),
  ...["/root"].filter((home) => home !== facts.home),
  "/var/mail",
  "/var/spool/mail",
  "/var/spool/cron",
  "/run/secrets",
  "/var/run/secrets",
  "/var/lib/docker",
  "/var/lib/containers"
]

/**
 * What perl runs in the jail before a step: it tells the kernel that this
 * process and everything it starts may connect to no abstract socket made
 * outside of them, then becomes the step's command.
 *
 * An abstract socket has a name and no file, so no file-system jail hides
 * it: any program on the same network connects to it, and a step keeps the
 * machine's network. An older D-Bus session bus listens on one and takes
 * its caller for the person. The kernel's Landlock scope, from Linux 6.12,
 * is what refuses the connection. The call numbers are the same on every
 * processor. A kernel that refuses the scope after the machine was found to
 * have it ends the step before it starts.
 *
 * @category constants
 * @since 0.1.0
 */
export const scopeProgram = [
  "my $scoped = pack('x16 L< L<', 1, 0);",
  "my $rules = syscall(444, $scoped, 24, 0);",
  "if ($rules < 0 || syscall(446, $rules, 0) != 0) {",
  "  print STDERR \"smithers-ci: the kernel did not keep abstract sockets out of the jail: $!\\n\";",
  "  exit 126;",
  "}",
  "exec { $ARGV[0] } @ARGV;",
  "print STDERR \"could not run $ARGV[0]\\n\";",
  "exit 127;"
].join("\n")

/**
 * Whether the kernel keeps a process started by `perl` from the abstract
 * sockets of the machine: it has Landlock, in the version that scopes them.
 * Asks by starting `perl` once.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const scopes = (perl: string): boolean =>
  spawnSync(perl, ["-e", "exit(syscall(444, 0, 0, 1) >= 6 ? 0 : 1)"], { stdio: "ignore" }).status === 0

/**
 * A machine's answer for a person whose variables are `environment`: they say
 * where the person's session and container daemon are.
 */
const answer = (
  facts: ExecSandbox.Host,
  refuses: (facts: ExecSandbox.Host) => string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  scoped: (perl: string) => boolean
): Probe => {
  const refusal = refuses(facts)
  // With no jail a step still has a home of its own, where a tool looks for its versions.
  if (refusal !== undefined) return { refusal, homes: toolsOn(environment["PATH"], facts, environment).homes }
  const perl = facts.executable("perl")
  return {
    bwrap: facts.executable("bwrap") as string,
    home: facts.home as string,
    hidden: [
      ...new Set([
        `/run/user/${facts.uid}`,
        ...[environment["XDG_RUNTIME_DIR"]].filter((entry): entry is string =>
          entry !== undefined && isAbsolute(entry)
        ),
        ...elsewhere(facts)
      ])
    ],
    daemons: daemonSockets(facts.uid, environment),
    tmp: tmpdir(),
    caches: [join(tmpdir(), `tsx-${facts.uid}`), join(tmpdir(), `vibelang-cache-${facts.uid}`)],
    tools: toolsOn(environment["PATH"], facts, environment),
    ...(perl !== undefined && scoped(perl) ? { scope: perl } : {})
  }
}

/**
 * Asks a machine, this one unless `facts` describes another. It can jail a
 * step when it runs Linux and bubblewrap starts; `refuses` starts bubblewrap
 * once to know, and says why when it cannot. Beside the home, a step must not reach the
 * person's runtime directory, where the key agents and the secret service of a
 * session listen, nor what {@link elsewhere} names. Nor may it reach a container daemon's socket
 * ({@link daemonSockets}). The caches kept in sight are where a `smthrs`
 * started from source keeps its compiled code, TypeScript's and VibeLang's:
 * without them every replay would compile `smthrs` again. An installed
 * `smthrs` has neither. The person's variables are read from this process;
 * {@link probeWith} asks for a person whose variables are held elsewhere.
 * `scoped` says whether the kernel keeps what a perl starts from the
 * machine's abstract sockets; without it the kernel is asked ({@link scopes}).
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const probe = (
  facts: ExecSandbox.Host = ExecSandbox.host(),
  refuses: (facts: ExecSandbox.Host) => string | undefined = ExecSandbox.writeProtectionRefusal,
  scoped: (perl: string) => boolean = scopes
): Probe => answer(facts, refuses, process.env, scoped)

/**
 * Asks this machine, for a person whose variables are `environment`.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const probeWith = (environment: Readonly<Record<string, string | undefined>>): Probe =>
  answer(ExecSandbox.host(), ExecSandbox.writeProtectionRefusal, environment, scopes)

/**
 * A path a jailed step finds empty: the person's home, a credential a link
 * leads to, or the socket of a container daemon. Inside a hidden directory a
 * step still reaches `kept`, a daemon's socket when the person allows Docker;
 * reads `readable`, the tools installed there and the replay's own programs;
 * and finds `links`, the links a tool is reached through.
 *
 * @category models
 * @since 0.1.0
 */
export interface Mask {
  readonly path: string
  readonly directory: boolean
  readonly kept?: ReadonlyArray<string> | undefined
  readonly readable?: ReadonlyArray<string> | undefined
  readonly links?: ReadonlyArray<Link> | undefined
}

/**
 * The directory a program's files are installed in, so a step that starts the
 * program reads all of it: the directory that holds the first `node_modules`
 * on the program's path, else the nearest directory above it that `marks` a
 * checkout of its source, else the directory the program is in.
 *
 * @throws {never}
 * @category resolution
 * @since 0.1.0
 */
export const installOf = (program: string, marks: (directory: string) => boolean): string => {
  const parts = program.split("/")
  const modules = parts.indexOf("node_modules")
  if (modules > 0) return parts.slice(0, modules).join("/")
  for (let depth = parts.length - 1; depth > 1; depth--) {
    const directory = parts.slice(0, depth).join("/")
    if (marks(directory)) return directory
  }
  return parts.slice(0, -1).join("/")
}

/**
 * The jail of one replay: the program that holds it, what it hides, the
 * directory its steps find in place of each of the machine's `temporary`
 * directories, and what they still read of those. `filter` is the file that
 * holds {@link keyringFilter}, and `scope` the perl that runs
 * {@link scopeProgram} where the kernel can.
 *
 * @category models
 * @since 0.1.0
 */
export interface Jail {
  readonly bwrap: string
  readonly masks: ReadonlyArray<Mask>
  readonly tmp: string
  readonly temporary: ReadonlyArray<string>
  readonly runtime?: ReadonlyArray<readonly [string, string]> | undefined
  /** The planner sees its own machine storage at the baseline jobs' path inside the jail. */
  readonly machineMount?: readonly [source: string, destination: string]
  readonly visible: ReadonlyArray<string>
  readonly filter: string
  readonly scope?: string | undefined
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
    notImplemented
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
  `steps run without a file-system jail: ${
    inPlainWords(refusal)
  }. Each step still gets a home directory of its own and cannot ` +
  `push with git${allowDocker ? "" : " or start docker or podman by name"}`

/**
 * The command that runs `argv` in the jail, or on its own with no jail. Either
 * way a shell starts it, with no descriptor but standard input, output and
 * error.
 *
 * In the jail every file of the machine is read-only, the masks are empty
 * but for what each keeps and lets be read, and only `writable` can be written; `sealed` names paths under a writable
 * one that stay read-only. The machine's temporary directories are the
 * replay's own, so a step that writes `/tmp` writes nothing of the machine's
 * and finds nothing another program left there. A directory is put in place
 * before what lies in it, so a temporary directory inside one that stays in
 * sight, as `TMPDIR=/tmp/x/tmp` beside a program in `/tmp/x`, is still the
 * replay's own and can be written. The step has its own device
 * and process trees, the kernel refuses it the keys of the person's session
 * ({@link keyringFilter}) and, where it can, the abstract sockets of the
 * machine ({@link scopeProgram}), and it ends, with everything it started,
 * when the replay does. The network stays as it is.
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
  jail === undefined ? ["/bin/bash", "-c", bare, "smithers-ci", ...argv] : [
    "/bin/bash",
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
          ...(mask.readable ?? []).flatMap((path) => ["--ro-bind", path, path]),
          ...(mask.links ?? []).flatMap((link) => ["--dir", dirname(link.path), "--symlink", link.target, link.path]),
          ...(mask.kept ?? []).flatMap((path) => ["--bind", path, path]),
          "--remount-ro",
          mask.path
        ]
        : ["--ro-bind", "/dev/null", mask.path]
    ),
    ...[
      ...jail.temporary.map((directory) => ["--bind", jail.tmp, directory] as const),
      ...jail.visible.map((path) => ["--ro-bind", path, path] as const)
    ].sort(([, , left], [, , right]) => left.length - right.length).flat(),
    ...(jail.runtime ?? []).flatMap(([source, target]) => ["--ro-bind", source, target]),
    ...writable.flatMap((path) => ["--bind", path, path]),
    ...(jail.machineMount === undefined ? [] : [
      writable.includes(jail.machineMount[0]) ? "--bind" : "--ro-bind",
      ...jail.machineMount
    ]),
    ...sealed.flatMap((path) => ["--ro-bind", path, path]),
    "--new-session",
    "--die-with-parent",
    "--",
    ...(jail.scope === undefined ? [] : [jail.scope, "-e", scopeProgram, "--"]),
    ...argv
  ]
