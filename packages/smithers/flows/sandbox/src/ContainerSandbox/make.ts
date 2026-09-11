/**
 * Constructs the container-lifecycle sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { configurationFingerprint } from "../internal/configurationFingerprint.ts"
import { environmentInput } from "../internal/environmentInput.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { cancelGuard, killScript } from "../internal/killScript.ts"
import { gather, type GatheredRun, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * How the provider reaches and shapes its containers.
 *
 * The container CLI runs through the injected spawner, so the module owns no
 * host access: a Node composition passes the platform spawner, and pointing
 * `program` at `podman` or a wrapper script changes the engine without
 * changing the provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContainerSandboxOptions {
  /** The spawner the container CLI runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The image every session's container is created from. */
  readonly image: string
  /** The container CLI. Default `docker`; `podman` speaks the same verbs. */
  readonly program?: string | undefined
  /** The guest workspace path. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** Container-wide environment, sent through /dev/stdin as an env-file. CR, LF, and NUL values are refused. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** The engine's network mode for the container, passed verbatim. Default `none`; another value explicitly opts in. */
  readonly network?: string | undefined
  /** Extra `create` arguments, an escape hatch for engine-specific shaping. */
  readonly createArgs?: ReadonlyArray<string> | undefined
  /** The container-name prefix. Default `smthrs-sbx-`. */
  readonly namePrefix?: string | undefined
}

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

/** The session-private guest directory spawned commands record their pids in. */
const pidDirectory = "/tmp/.smthrs-sbx"
const fingerprintLabel = "smithers.dev/sandbox-fingerprint"
const inspectedContainer = Schema.Array(Schema.Struct({
  Config: Schema.Struct({
    Image: Schema.String,
    WorkingDir: Schema.String,
    Labels: Schema.Record(Schema.String, Schema.String)
  }),
  HostConfig: Schema.Struct({
    NetworkMode: Schema.String,
    Privileged: Schema.Boolean,
    Binds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
  }),
  Mounts: Schema.Array(Schema.Struct({ Type: Schema.String }))
}))

/**
 * Builds a sandbox provider whose machines are containers this host's
 * container engine runs.
 *
 * `acquire` creates a deterministically named container from the configured
 * image (`create` then `start`, holding it on `sleep infinity`) and serves
 * the session contract over `exec`: commands run under the guest's `sh`,
 * reads stream bytes out through `cat`, writes stream bytes in through the
 * exec's stdin, and closing the scope removes the container with force,
 * which also ends everything running inside it. A container the name already
 * holds — a crashed run's leftover — is reattached only when its ownership and configuration match, so
 * resuming a session key lands in the machine it had.
 *
 * `spawn` honors the whole session contract, not just the command line. A
 * command's `stdin` bytes travel on the exec's own input channel
 * (`--interactive`), a relative `cwd` is resolved under {@link Session.workdir}
 * before it reaches `--workdir` (which requires an absolute path), and both
 * shells in the chain name `/bin/sh` absolutely, because the engine resolves a
 * bare `sh` through the exec environment's `PATH` and a caller's `env`
 * override would otherwise break the wrapper before the command ever ran. For
 * the same reason the caller's variables travel through stdin to an `env(1)` prefix on the
 * inner shell rather than as `--env` on the exec: they belong to the command,
 * not to the plumbing that starts it. Closing a
 * spawn's scope is the process's lifetime ending: the local CLI client is torn
 * down and, unless the command was already observed to end, the guest process
 * is signalled through the same pid-walk `kill` uses, so a scope cannot close
 * on a still-running guest.
 *
 * Per-command `kill` is real, and it has to be indirect: signalling the local
 * CLI client does not reach the guest process (Docker's exec client detaches
 * from it), which is exactly the silent-no-op kill the conformance suite
 * exists to catch. So every spawned command records its own pid in a
 * session-private guest directory first, and `kill` execs a second command
 * that signals that pid and every descendant found under `/proc`. The pidfile
 * directory is wiped on acquire, so a reattached container cannot mis-target
 * a previous incarnation's pids.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: ContainerSandboxOptions): Provider => {
  const program = options.program ?? "docker"
  const workdir = options.workdir ?? "/workspace"
  const network = options.network ?? "none"
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const run = (args: ReadonlyArray<string>, stdin?: Uint8Array): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(
          ChildProcess.make(program, [...args], stdin === undefined ? {} : { stdin: Stream.make(stdin) })
        ).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (
    what: string,
    args: ReadonlyArray<string>
  ): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.flatMap(run(args), (result) =>
      result.code === 0 ? Effect.succeed(result) : Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `${what}: \`${program} ${args[0]}\` exited ${result.code}: ${result.stderr.trim()}`
        })
      ))
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        yield* checkEnvironmentNames(options.env)
        const creationEnv = Object.entries(options.env ?? {})
        if (creationEnv.some(([, value]) => /[\r\n\0]/.test(value))) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message:
                "container creation environment values must not contain CR, LF, or NUL: the CLI env-file format cannot carry them"
            })
          )
        }
        const envFile = creationEnv.length === 0 ? undefined : new TextEncoder().encode(
          creationEnv.map(([key, value]) => `${key}=${value}\n`).join("")
        )
        const name = `${prefix}${sessionSlug(sessionKey)}`
        const fingerprint = yield* configurationFingerprint({
          provider: "ContainerSandbox/v1",
          owner: sessionKey,
          name,
          image: options.image,
          workdir,
          network,
          env: options.env ?? {},
          createArgs: options.createArgs ?? []
        })
        // CREATION IS ITS OWN RESOURCE, and starting and preparing come after
        // it rather than inside it. `acquireRelease` registers a finalizer only
        // once its acquire SUCCEEDS, so folding `start` and the workspace
        // preparation into the acquire meant a container that was created and
        // then failed to start was never removed: the run reported an honest
        // failure and left a machine behind on the engine, which the next
        // acquire of that key would silently reattach to.
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* run([
              "create",
              "--name",
              name,
              "--workdir",
              workdir,
              "--network",
              network,
              ...envFile === undefined ? [] : ["--env-file", "/dev/stdin"],
              ...options.createArgs ?? [],
              "--label",
              `${fingerprintLabel}=${fingerprint}`,
              options.image,
              "sleep",
              "infinity"
            ], envFile)
            if (created.code === 0) return
            // A refused create is either a name already taken, which is the
            // reattach this provider is built around, or anything else, which
            // is a failure. The engine says which in English prose, and the
            // prose is not a contract: podman words the conflict differently
            // from docker and a localized daemon differently again. The
            // question goes to the engine as a question instead.
            const existing = yield* run(["container", "inspect", name])
            if (existing.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the container ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                })
              )
            }
            const inspected = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(inspectedContainer)(JSON.parse(new TextDecoder().decode(existing.stdout))),
              catch: providerFailure("unavailable", `the container ${name} has no verifiable configuration`)
            })
            const held = inspected[0]
            if (
              held === undefined || inspected.length !== 1 ||
              held.Config.Labels[fingerprintLabel] !== fingerprint ||
              held.Config.Image !== options.image || held.Config.WorkingDir !== workdir ||
              held.HostConfig.NetworkMode !== network ||
              ((options.createArgs?.length ?? 0) === 0 && (held.HostConfig.Privileged ||
                (held.HostConfig.Binds?.length ?? 0) > 0 || held.Mounts.some((mount) => mount.Type === "bind")))
            ) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the container ${name} does not match the requested configuration or owner`
                })
              )
            }
          }),
          () => finalizeWithin(Effect.ignore(run(["rm", "--force", name]), { log: "Warn" }), `container ${name}`)
        )
        yield* step(`the container ${name} could not be started`, ["start", name])
        yield* step(`the workspace ${workdir} could not be prepared in ${name}`, [
          "exec",
          name,
          // The absolute path prevents a container-wide PATH override from
          // disabling the provider's own workspace-preparation shell.
          "/bin/sh",
          "-c",
          `mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`
        ])
        // Pidfiles are numbered per acquire; the wipe above means a reattached
        // container starts from a clean directory, so the counter cannot
        // collide with a previous incarnation's files.
        let nextPidfile = 0
        const pidfiles = new WeakMap<RemoteProcess, string>()
        const resolveCwd = rootedAt(workdir)
        const deliver = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
          Effect.flatMap(
            run([
              "exec",
              name,
              // The absolute path prevents a container-wide PATH override
              // from disabling the provider's own signal-delivery shell.
              "/bin/sh",
              "-c",
              killScript(pidfile, signal.replace(/^SIG/, ""))
            ]),
            (result) =>
              result.code === 0 ? Effect.void : Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the signal ${signal} could not be delivered in ${name}: ${result.stderr.trim()}`
                })
              )
          )
        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            yield* checkEnvironmentNames(spawnOptions.env)
            const pidfile = `${pidDirectory}/${nextPidfile++}.pid`
            const stdin = spawnOptions.stdin
            // The caller's variables reach the command, never the wrapper. As
            // `--env` they were part of the exec environment, so a `PATH`
            // override broke the wrapper's own `sh` one layer in, the same
            // failure the absolute `/bin/sh` below exists to prevent, moved
            // rather than fixed. `env(1)` does not widen which names survive:
            // the inner shell rebuilds its environment when it starts, so
            // `checkEnvironmentNames` above refuses a non-identifier name
            // whatever the delivery.
            //
            // GNU coreutils, busybox, and BSD `env` all support `-u`, so an
            // undefined value deletes a variable the container was created
            // with instead of silently keeping it: `undefined` means the same
            // "remove this one" here that it means for a local command. Every
            // `-u` precedes every assignment, because `env` stops reading
            // options at the first operand and `env A=1 -u B prog` runs `-u`
            // as the program.
            const entries = Object.entries(spawnOptions.env ?? {})
            const environment = [
              ...entries.flatMap(([key, value]) => value === undefined ? ["-u", CommandLine.quote(key)] : []),
              ...entries.flatMap(([key, value]) => value === undefined ? [] : [CommandLine.quote(`${key}=${value}`)])
            ]
            const input = environmentInput(environment, stdin)
            const args = [
              "exec",
              // The exec has a real input channel; it is asked for only when
              // there is input to carry, so an input-less command sees EOF.
              ...input.stdin === undefined ? [] : ["--interactive"],
              // `--workdir` requires an absolute guest path, so a relative
              // cwd is rooted at the session workdir before it gets here.
              "--workdir",
              resolveCwd(spawnOptions.cwd ?? ""),
              name,
              // Absolute on purpose: the engine resolves the exec's argv
              // through the exec environment's PATH, so a caller's PATH
              // override would keep a bare `sh` from ever starting.
              "/bin/sh",
              "-c",
              // The pid survives the whole chain: `exec` replaces the recorded
              // shell with env, env replaces itself with `/bin/sh`, and
              // `sh -c` execs a lone simple command.
              `echo $$ > ${pidfile}; ${cancelGuard(pidfile)}; ${input.script}exec ${input.prefix}/bin/sh -c ${
                CommandLine.quote(command)
              }`
            ]
            const handle = yield* options.spawner.spawn(
              ChildProcess.make(program, args, input.stdin === undefined ? {} : { stdin: input.stdin })
            ).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
            )
            const raw = remoteProcessOf(handle, command)
            let ended = false
            const process: RemoteProcess = {
              ...raw,
              exitCode: Effect.tap(raw.exitCode, () =>
                Effect.sync(() => {
                  ended = true
                }))
            }
            // Closing the process scope ends the local CLI client, which the
            // guest does not notice. The contract says the scope IS the
            // process's lifetime, so the finalizer signals the guest side
            // too, unless the command has already been seen to end.
            yield* Effect.addFinalizer(() =>
              ended
                ? Effect.void
                : finalizeWithin(
                  Effect.ignore(deliver(pidfile, "SIGTERM"), { log: "Warn" }),
                  `container ${name} process ${pidfile}`
                )
            )
            pidfiles.set(process, pidfile)
            return process
          }),
          kill: (process, signal) =>
            Effect.suspend(() => {
              const pidfile = pidfiles.get(process)
              /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
              if (pidfile === undefined) {
                return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
              }
              return deliver(pidfile, signal)
            }),
          readFile: (path) =>
            Effect.flatMap(
              run([
                "exec",
                name,
                // The absolute path prevents a container-wide PATH override
                // from disabling the provider's own file-read shell.
                "/bin/sh",
                "-c",
                `test -e ${CommandLine.quote(path)} || exit 9; cat ${CommandLine.quote(path)}`
              ]),
              (result) =>
                result.code === 0
                  ? Effect.succeed(result.stdout)
                  : result.code === 9
                  ? Effect.fail(
                    new ProviderError({ code: "not_found", message: `the container holds nothing at ${path}` })
                  )
                  : Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the container could not read ${path}: ${result.stderr.trim()}`
                    })
                  )
            ),
          writeFile: (path, content) =>
            Effect.scoped(
              Effect.gen(function*() {
                const parent = parentOf(path)
                const script = parent === undefined
                  ? `cat > ${CommandLine.quote(path)}`
                  : `mkdir -p ${CommandLine.quote(parent)} && cat > ${CommandLine.quote(path)}`
                const handle = yield* options.spawner.spawn(
                  ChildProcess.make(program, [
                    "exec",
                    "--interactive",
                    name,
                    // The absolute path prevents a container-wide PATH
                    // override from disabling the provider's own file-write shell.
                    "/bin/sh",
                    "-c",
                    script
                  ], {
                    stdin: Stream.make(content)
                  })
                ).pipe(Effect.mapError(providerFailure("spawn_error", `the write to ${path} could not start`)))
                const result = yield* gather(handle, script)
                if (result.code !== 0) {
                  return yield* Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the container could not write ${path}: ${result.stderr.trim()}`
                    })
                  )
                }
              })
            ),
          ping: Effect.flatMap(run(["exec", name, "true"]), (result) =>
            result.code === 0 ? Effect.void : Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `the container ${name} did not answer: ${result.stderr.trim()}`
              })
            ))
        }
        return session
      })
  }
}
