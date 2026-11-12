/**
 * The kernel's `ProcessConfinement` seam, filled with this host's native
 * sandbox: bubblewrap on Linux, seatbelt on macOS.
 *
 * `@smthrs/kernel`'s `ChildProcessSpawner.layer` hands every stage that passed
 * its `proc:spawn` check to the confinement in its context, together with the
 * `ProcessConfinement.Profile` the grants in force admit. This module turns
 * that profile into a {@link ProcessSandbox.Request}, plans it against the
 * workspace, and wraps the stage's argv in the mechanism the host has, so an
 * approved `bash` can write only where an `fs:write` grant says and reach the
 * network only when a `net:*` grant says. A stage that asked for the platform
 * shell is spelled out as `/bin/sh -c <line>` first: wrapping a `shell: true`
 * command line would otherwise leave its redirections and pipes to a shell
 * outside the sandbox.
 *
 * A host with no mechanism is the one decision this module leaves to its
 * caller: {@link Options.unavailable} either refuses the spawn, so nothing
 * runs that the profile would not have confined, or runs it unconfined with
 * a warning, the way every host did before this seam existed. A write set
 * the mechanism cannot enforce safely, a symbolic link below the workspace
 * root, is always refused.
 *
 * {@link Options.verification} is the second kind of run this module
 * confines: a project's own install, typecheck, and test commands, which
 * execute files an agent edited and need a toolchain an agent command does
 * not. See {@link Verification}.
 *
 * @since 1.0.0-rc.1
 */

import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as Redacted from "effect/Redacted"
import type * as Scope from "effect/Scope"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as ProcessSandbox from "./ProcessSandbox.ts"

/**
 * How the confinement is built.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Options {
  /**
   * What happens when this host has no mechanism to enforce a profile with.
   * `"refuse"` fails the spawn, so a command never runs with more than the
   * profile allows; `"unconfined"` runs it as given and logs a
   * warning naming what the host lacks.
   */
  readonly unavailable?: "refuse" | "unconfined" | undefined
  /** The host facts mechanism selection reads; defaults to the real host. */
  readonly host?: ProcessSandbox.Host | undefined
  /** Where each run's private temporary directory is created; defaults to the OS temporary directory. */
  readonly temporaryDirectory?: string | undefined
  /** Confines a project's own toolchain instead of one agent command; see {@link Verification}. */
  readonly verification?: Verification | undefined
}

/**
 * What a project's own verification commands get beyond an agent command.
 *
 * A package manager starts other programs by name and talks to the scripts it
 * runs, so three things change, and nothing else does:
 *
 * - The toolchain is readable. Every `PATH` entry of the command's
 *   environment and the install root of each package manager and runtime on
 *   it are bound read-only, as `ProcessSandbox.toolchainReads` computes them
 *   on the host. The rest of the home directory stays hidden.
 * - Linux admits `socketpair(AF_UNIX, SOCK_SEQPACKET)`, which pnpm starts
 *   every script through. Like the stream pair it is connection-oriented and
 *   unnamed, so it reaches only the processes that inherit it. `socket(AF_UNIX)`
 *   and the datagram pair, which can address a host endpoint, stay refused.
 * - Entries named by `hiddenPrefixes` are closed for reads and writes
 *   wherever they sit in the workspace.
 *
 * @category models
 * @since 1.0.0
 */
export interface Verification {
  /**
   * Absolute host paths the operator opens for reading. One outside the
   * workspace is bound read-only. One inside it reopens, for reading, the
   * hidden entries at or below it, and the run may not write there. Each
   * path is resolved once, when the service is made: one that does not exist
   * then opens nothing, and a run is refused once a path no longer names the
   * file or directory it named then.
   */
  readonly reads?: ReadonlyArray<string> | undefined
  /**
   * Entry-name prefixes hidden wherever they appear below the workspace
   * root, in any ASCII case: `.env` hides `.env`, `.env.local`, and `.ENV`.
   */
  readonly hiddenPrefixes?: ReadonlyArray<string> | undefined
}

/** A verification read as it resolved when the service was made: the path given, its real path, and the file it named. */
interface Opened {
  readonly read: string
  readonly real: string
  readonly dev: number
  readonly ino: number
}

const shellLine = (command: ChildProcess.StandardCommand): string => [command.command, ...command.args].join(" ")

/**
 * The argv a stage executes, with a shell request made explicit.
 *
 * Node runs a `shell: true` stage as `/bin/sh -c <line>` on POSIX, and a
 * string shell as `<shell> -c <line>`; the wrapper needs that program to be
 * the one it confines, so the shell becomes the argv's first token and the
 * spawned stage no longer asks for one.
 */
const argvOf = (command: ChildProcess.StandardCommand): ReadonlyArray<string> => {
  const args = command.args.map((arg) => Redacted.isRedacted(arg) ? Redacted.value(arg) : arg)
  const shell = command.options.shell
  if (shell === undefined || shell === false) return [command.command, ...args]
  return [shell === true ? "/bin/sh" : shell, "-c", [command.command, ...args].join(" ")]
}

const failure = (
  tag: "NotFound" | "PermissionDenied" | "Unknown",
  command: ChildProcess.StandardCommand,
  description: string,
  cause: unknown
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "ProcessConfinement",
    method: "confine",
    pathOrDescriptor: shellLine(command),
    description,
    cause
  })

const messageOf = (cause: unknown): string =>
  ProcessSandbox.isUnenforceable(cause)
    ? cause.message
    : cause instanceof Error
    ? cause.message
    : String(cause)

/** Classic BPF for seccomp_data: deny host Unix sockets and io_uring, preserving stream socketpair.
 * `sequenced` also preserves the SOCK_SEQPACKET pair, which is connection-oriented like the stream pair.
 * Closed networking additionally denies every IP socket family.
 * Wrong ABI and x32 syscall encodings fail closed rather than bypassing socket(). */
const networkFilter = (architecture: string, network: "none" | "open", sequenced: boolean): Uint8Array => {
  const abi = architecture === "x64"
    ? { audit: 0xc000003e, socket: 41, socketpair: 53 }
    : architecture === "arm64"
    ? { audit: 0xc00000b7, socket: 198, socketpair: 199 }
    : undefined
  if (abi === undefined) throw new Error(`native-network seccomp is unavailable on ${architecture}`)
  const instructions: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4], // load audit architecture
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, 0x80000000], // kill unsupported ABI
    [0x20, 0, 0, 0], // load syscall number
    [0x35, 0, 1, 0x40000000],
    [0x06, 0, 0, 0x80000000], // kill x32 / invalid high syscall numbers
    [0x15, 0, 1, 425], // io_uring_setup on both supported ABIs
    [0x06, 0, 0, 0x00050001], // io_uring can otherwise create sockets without socket()
    [0x15, 0, sequenced ? 7 : 6, abi.socketpair],
    [0x20, 0, 0, 16], // socketpair domain
    [0x15, 0, sequenced ? 5 : 4, 1], // AF_UNIX
    [0x20, 0, 0, 24], // socketpair type, low 32 bits of args[1]
    [0x54, 0, 0, 0xf], // strip SOCK_NONBLOCK and SOCK_CLOEXEC
    // Only connection-oriented pairs; Linux aliases SOCK_RAW to datagram
    // operations, and a datagram pair can address a host endpoint.
    [0x15, sequenced ? 2 : 1, 0, 1], // SOCK_STREAM
    ...(sequenced ? [[0x15, 1, 0, 5] as const] : []), // SOCK_SEQPACKET
    [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 0] // reload syscall number before the socket() policy
  ]
  if (network === "none") {
    instructions.push([0x15, 0, 1, abi.socket], [0x06, 0, 0, 0x00050001]) // EPERM for every socket family
  } else {
    instructions.push(
      [0x15, 0, 3, abi.socket],
      [0x20, 0, 0, 16], // socket domain, low 32 bits of args[0]
      [0x15, 0, 1, 1], // AF_UNIX; IP families remain available
      [0x06, 0, 0, 0x00050001]
    )
  }
  instructions.push([0x06, 0, 0, 0x7fff0000]) // SECCOMP_RET_ALLOW
  const bytes = new Uint8Array(instructions.length * 8)
  const view = new DataView(bytes.buffer)
  for (const [index, [code, jt, jf, value]] of instructions.entries()) {
    view.setUint16(index * 8, code, true)
    view.setUint8(index * 8 + 2, jt)
    view.setUint8(index * 8 + 3, jf)
    view.setUint32(index * 8 + 4, value, true)
  }
  return bytes
}

/**
 * Builds the native confinement.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const make = (options: Options = {}): KernelProcessConfinement.Service => {
  const hostFacts = options.host ?? ProcessSandbox.host()
  const temporaryRoot = options.temporaryDirectory ?? NodeOs.tmpdir()
  const unavailable = options.unavailable ?? "refuse"
  const verification = options.verification
  // Resolved here, before any command runs. A confined command can rename
  // what it may write, so resolving a name again before a later command
  // would let the earlier one aim it at a file the operator never opened.
  const opens = (verification?.reads ?? []).flatMap((read): ReadonlyArray<Opened | string> => {
    if (!NodePath.isAbsolute(read)) return [read]
    try {
      const real = NodeFs.realpathSync(read)
      const { dev, ino } = NodeFs.statSync(real)
      return [{ read, real, dev, ino }]
    } catch {
      return []
    }
  })
  const confine = Effect.fn("ProcessConfinement.confine")(function*(
    command: ChildProcess.StandardCommand,
    profile: KernelProcessConfinement.Profile
  ): Effect.fn.Return<ChildProcess.StandardCommand, PlatformError.PlatformError, Scope.Scope> {
    const request: ProcessSandbox.Request = {
      network: profile.network,
      unixSockets: false,
      strict: true,
      reads: profile.reads,
      writes: profile.writes,
      readOnly: profile.readOnly
    }
    const selected = ProcessSandbox.select(request, hostFacts)
    if (ProcessSandbox.isUnenforceable(selected)) {
      if (unavailable === "refuse") {
        return yield* failure(
          "NotFound",
          command,
          `${selected.message} This host refuses to spawn unconfined.`,
          selected
        )
      }
      yield* Effect.logWarning(`${selected.message} Running unconfined.`)
      return command
    }
    // The stage's directory is absolute: the kernel spawner roots it first.
    const cwd = command.options.cwd ?? profile.workspaceRoot
    const within = (root: string, path: string): boolean => {
      const relative = NodePath.relative(root, path)
      return relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
    }
    if (!within(profile.workspaceRoot, cwd)) {
      return yield* failure("PermissionDenied", command, "command directory is outside the workspace", undefined)
    }
    // A lexical workspace path can enter an unrelated host directory through
    // a symlink. Check the real directory before granting or preparing a run.
    const canonical = yield* Effect.try({
      try: () => {
        const root = NodeFs.realpathSync(profile.workspaceRoot)
        const directory = NodeFs.realpathSync(cwd)
        if (!within(root, directory)) throw new Error("command directory is outside the workspace")
        for (const relative of profile.reads) {
          const lexical = NodePath.resolve(root, relative)
          if (!within(root, lexical)) continue
          // A read bind follows its source symlink. Refuse a grant that would
          // therefore mount unrelated host bytes inside the workspace.
          if (NodeFs.existsSync(lexical)) {
            const real = NodeFs.realpathSync(lexical)
            if (!within(root, real)) throw new Error("read grant resolves outside the workspace")
            if (real !== lexical) throw new Error("read grant is a symbolic link")
          }
        }
        return { root, cwd: directory }
      },
      catch: (cause) => failure("PermissionDenied", command, messageOf(cause), cause)
    })
    // The private tmp lives as long as the spawn's scope, however preparation
    // ends; the declared write directories are created so the mechanism has
    // something to bind, which the grant that opened them already permits.
    const allocatedTmp = yield* Effect.acquireRelease(
      Effect.try({
        try: () => NodeFs.mkdtempSync(NodePath.join(temporaryRoot, "smithers-confinement-")),
        catch: (cause) => failure("Unknown", command, `could not prepare the confinement: ${messageOf(cause)}`, cause)
      }),
      (directory) =>
        Effect.sync(() => {
          try {
            NodeFs.rmSync(directory, { recursive: true, force: true })
          } catch {
            // Cleanup is best-effort when the host refuses directory removal.
          }
        })
    )
    const tmp = yield* Effect.try({
      try: () => NodeFs.realpathSync(allocatedTmp),
      catch: (cause) => failure("Unknown", command, `could not prepare the confinement: ${messageOf(cause)}`, cause)
    })
    const planned = yield* Effect.try({
      try: () => ProcessSandbox.plan(request, { workspaceRoot: canonical.root, cwd: canonical.cwd, tmp }, hostFacts),
      catch: (cause) => failure("Unknown", command, `could not plan the confinement: ${messageOf(cause)}`, cause)
    })
    if (ProcessSandbox.isUnenforceable(planned)) {
      return yield* failure("PermissionDenied", command, planned.message, planned)
    }
    // Only the target receives its requested environment. Dynamic-loader and
    // other startup variables must never configure the host sandbox launcher.
    // A null prototype keeps an own `__proto__` entry instead of running the setter.
    const targetEnvironment: Record<string, string> = Object.create(null)
    const inherited = command.options.env === undefined || command.options.extendEnv === true
    for (const [name, value] of Object.entries(inherited ? process.env : {})) {
      // Bash exports functions as names such as BASH_FUNC_which%%. These
      // ambient entries cannot be exported by the portable inner launcher.
      if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) targetEnvironment[name] = value
    }
    for (const [name, value] of Object.entries(command.options.env ?? {})) {
      if (Redacted.isRedacted(value)) targetEnvironment[name] = Redacted.value(value)
      else if (typeof value === "string") targetEnvironment[name] = value
      else delete targetEnvironment[name]
    }
    // A workspace link does not grant authority to its target on the host.
    // Verification adds what the host itself chose and what the operator named.
    const opened = yield* Effect.try({
      try: () => {
        if (verification === undefined) return { externalReads: [] }
        const outside: Array<string> = []
        const restored: Array<string> = []
        for (const open of opens) {
          if (typeof open === "string") throw new Error("a verification read is not an absolute path")
          const now = NodeFs.statSync(open.read, { throwIfNoEntry: false })
          if (
            now === undefined || now.dev !== open.dev || now.ino !== open.ino ||
            NodeFs.realpathSync(open.read) !== open.real
          ) {
            throw new Error("a verification read no longer names what it named when the run began")
          }
          if (within(canonical.root, open.real)) restored.push(open.real)
          else outside.push(open.read, open.real)
        }
        const prefixes = verification.hiddenPrefixes ?? []
        return {
          externalReads: [
            ...ProcessSandbox.toolchainReads(targetEnvironment.PATH, canonical.root, hostFacts),
            ...outside
          ],
          hidden: {
            prefixes,
            // Seatbelt closes the names by pattern and needs no list.
            paths: planned.mechanism._tag === "bubblewrap"
              ? ProcessSandbox.hiddenEntries(canonical.root, prefixes, restored, hostFacts)
              : [],
            restored
          }
        }
      },
      catch: (cause) => failure("PermissionDenied", command, messageOf(cause), cause)
    })
    const confinement: ProcessSandbox.Plan = { ...planned, ...opened }
    yield* Effect.try({
      try: () => {
        ProcessSandbox.validateWrites(confinement, hostFacts)
        NodeFs.mkdirSync(NodePath.join(tmp, "home"), { recursive: true })
        NodeFs.mkdirSync(NodePath.join(tmp, "cache"), { recursive: true })
        for (const write of planned.writes) NodeFs.mkdirSync(write, { recursive: true })
      },
      catch: (cause) => failure("Unknown", command, `could not prepare the confinement: ${messageOf(cause)}`, cause)
    })
    const privateEnvironment = ProcessSandbox.environment(confinement)
    const script = yield* Effect.try({
      try: () => {
        const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
        const exports: Array<string> = []
        for (const [name, value] of Object.entries({ ...targetEnvironment, ...privateEnvironment })) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("environment variable name is not portable")
          if (value.includes("\0")) throw new Error("environment variable contains a null byte")
          exports.push(`export ${name}=${quote(value)}`)
        }
        const file = NodePath.join(tmp, "environment.sh")
        // Values stay off argv and journal receipts; the script is private,
        // removed with the scope, and interpreted only inside confinement.
        NodeFs.writeFileSync(
          file,
          [
            "#!/bin/sh",
            "unset ENV BASH_ENV CDPATH PWD OLDPWD SHLVL _",
            ...exports,
            "exec \"$@\"",
            ""
          ].join("\n"),
          { flag: "wx", mode: 0o600 }
        )
        return file
      },
      catch: (cause) => failure("PermissionDenied", command, messageOf(cause), cause)
    })
    // Resolve the actual program before wrapping it in the environment shell.
    // Otherwise the sandbox sees only /usr/bin/env and omits a native helper
    // installed outside its ordinary runtime paths.
    const originalArgv = argvOf(command)
    const launch = ProcessSandbox.launcher(
      originalArgv[0]!,
      targetEnvironment.PATH,
      [...confinement.reads, ...confinement.writes, ...confinement.externalReads],
      confinement.workspaceRoot,
      hostFacts
    )
    const targetArgv = ["/usr/bin/env", "-i", "/bin/sh", script, launch.program, ...originalArgv.slice(1)]
    const wrapped = yield* Effect.try({
      try: () =>
        ProcessSandbox.wrap(
          { ...confinement, externalReads: [...confinement.externalReads, ...launch.reads, script] },
          targetArgv,
          targetEnvironment,
          hostFacts
        ),
      catch: (cause) => failure("Unknown", command, `could not render the confinement: ${messageOf(cause)}`, cause)
    })
    let [executable, ...args] = wrapped.argv
    if (selected._tag === "bubblewrap") {
      const filter = yield* Effect.try({
        try: () => {
          const file = NodePath.join(tmp, "network.seccomp")
          NodeFs.writeFileSync(file, networkFilter(process.arch, profile.network, verification !== undefined), {
            flag: "wx",
            mode: 0o600
          })
          return file
        },
        catch: (cause) => failure("PermissionDenied", command, messageOf(cause), cause)
      })
      let fd = 3
      while (command.options.additionalFds?.[`fd${fd}`] !== undefined) fd++
      // A regular file avoids a filter-input pipe whose early closure can
      // surface as an unhandled ECONNRESET before bwrap reports its refusal.
      args = [
        "-c",
        `exec ${fd}<"$1"; shift; exec "$@"`,
        "smithers-seccomp",
        filter,
        executable!,
        "--seccomp",
        String(fd),
        ...args
      ]
      executable = "/bin/sh"
    }
    return ChildProcess.make(executable!, args, {
      ...command.options,
      cwd: canonical.cwd,
      shell: false,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", ...privateEnvironment },
      extendEnv: false
    })
  })
  return KernelProcessConfinement.ProcessConfinement.of({ confine })
}

/**
 * Provides the native confinement.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layer = (options: Options = {}): Layer.Layer<KernelProcessConfinement.ProcessConfinement> =>
  Layer.succeed(KernelProcessConfinement.ProcessConfinement)(make(options))
