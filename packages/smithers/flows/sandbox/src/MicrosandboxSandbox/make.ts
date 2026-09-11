/**
 * Constructs the Microsandbox microVM provider.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { attemptIn } from "../internal/attempt.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { parentOf } from "../internal/guestPath.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

const defaultImage = "oven/bun:1"
const defaultNixImage = "nixos/nix"
const defaultWorkdir = "/workspace"
const defaultShell = "/bin/sh"
const defaultNixExecutable = "nix"
const namePrefix = "smthrs-msb-"

/**
 * The Nix environment a microVM's commands run under: the workspace's
 * `S.Nix.Environment` flake, carried as text because this package reads no
 * host files. The provider plants the flake and its lock in the guest, warms
 * the closure once with `nix develop --command true`, and runs every
 * command as `nix develop <flake> --command <shell> -c <command>`, so the
 * session holds the declared toolchain rather than what the image shipped.
 *
 * The image must carry `nix`; with an environment and no `image`, the
 * provider boots `nixos/nix`. A sticky session keeps the realised closure in
 * the microVM's store across acquires, and a `snapshot` taken after the warm
 * boots with it already realised.
 *
 * @category models
 * @since 0.1.0
 */
export interface NixEnvironment {
  /** The `flake.nix` text. */
  readonly flake: string
  /** The `flake.lock` text; without it the guest resolves inputs at warm time. */
  readonly lock?: string | undefined
  /** The dev shell attribute; the default dev shell when absent. */
  readonly attr?: string | undefined
  /** The guest directory the flake is planted in. Default `<workdir>/.smithers/nix`. */
  readonly directory?: string | undefined
  /** The `nix` executable in the guest. Default `nix`. */
  readonly nix?: string | undefined
}

/** A declared environment with its guest directory and `nix` executable settled. */
interface PlantedEnvironment {
  readonly directory: string
  readonly executable: string
  readonly environment: NixEnvironment
}

/** The `nix develop` installable for a planted environment. */
const installable = (directory: string, environment: NixEnvironment): string =>
  environment.attr === undefined ? `path:${directory}` : `path:${directory}#${environment.attr}`

/**
 * How the provider reaches its SDK and shapes each session's microVM.
 *
 * @category models
 * @since 0.1.0
 */
export interface MicrosandboxSandboxOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** Boot from this image. Default `oven/bun:1`. */
  readonly image?: string | undefined
  /** Boot from a snapshot instead of an image. The two options are exclusive. */
  readonly snapshot?: string | undefined
  /** The guest workspace and default command directory. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** The guest shell used for command lines. Default `/bin/sh`. */
  readonly shell?: string | undefined
  /** Static environment delivered to every command. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
   * `ephemeral` stops the microVM on release. `sticky` deliberately leaves it
   * running so the next acquire of the same session key can reconnect.
   */
  readonly persistence?: "ephemeral" | "sticky" | undefined
  /** Initial virtual CPU count. */
  readonly cpus?: number | undefined
  /** Maximum hotpluggable virtual CPU count. */
  readonly maxCpus?: number | undefined
  /** Initial memory in MiB. */
  readonly memoryMib?: number | undefined
  /** Maximum hotpluggable memory in MiB. */
  readonly maxMemoryMib?: number | undefined
  /** Maximum microVM lifetime in seconds. */
  readonly maxDurationSecs?: number | undefined
  /** Idle reclamation window in seconds. */
  readonly idleTimeoutSecs?: number | undefined
  /** Guest security profile. */
  readonly security?: "default" | "restricted" | undefined
  /** Vendor image pull policy. */
  readonly pullPolicy?: string | undefined
  /** Labels recorded on the microVM. */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Named guest scripts planted at boot. */
  readonly scripts?: Readonly<Record<string, string>> | undefined
  /** Run detached from the host process. Sticky sessions default to detached. */
  readonly detached?: boolean | undefined
  /** Boot without guest networking. */
  readonly disableNetwork?: boolean | undefined
  /** The Nix environment every command runs under; see {@link NixEnvironment}. */
  readonly environment?: NixEnvironment | undefined
}

type Builder = ReturnType<Sdk["Sandbox"]["builder"]>
type VendorSandbox = Awaited<ReturnType<Builder["create"]>>
type ExecOutput = Awaited<ReturnType<Awaited<ReturnType<VendorSandbox["execStreamWith"]>>["collect"]>>

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const failure = (code: ProviderErrorCode, message: string, cause: unknown): ProviderError =>
  new ProviderError({ code, message: `microsandbox: ${message}`, cause })

const attempt = attemptIn("microsandbox")

const configure = (builder: Builder, options: MicrosandboxSandboxOptions, sticky: boolean): Builder => {
  let configured = options.snapshot === undefined
    ? builder.image(options.image ?? (options.environment === undefined ? defaultImage : defaultNixImage))
    : builder.fromSnapshot(options.snapshot)
  if (options.cpus !== undefined) configured = configured.cpus(options.cpus)
  if (options.maxCpus !== undefined) configured = configured.maxCpus(options.maxCpus)
  if (options.memoryMib !== undefined) configured = configured.memory(options.memoryMib)
  if (options.maxMemoryMib !== undefined) configured = configured.maxMemory(options.maxMemoryMib)
  if (options.security !== undefined) configured = configured.security(options.security)
  if (options.pullPolicy !== undefined) configured = configured.pullPolicy(options.pullPolicy)
  if (options.labels !== undefined) configured = configured.labels({ ...options.labels })
  if (options.scripts !== undefined) configured = configured.scripts({ ...options.scripts })
  if (options.maxDurationSecs !== undefined) configured = configured.maxDuration(options.maxDurationSecs)
  if (options.idleTimeoutSecs !== undefined) configured = configured.idleTimeout(options.idleTimeoutSecs)
  if (options.disableNetwork === true) configured = configured.disableNetwork()
  return configured.ephemeral(!sticky).detached(options.detached ?? sticky)
}

const isAlreadyExists = (cause: unknown): boolean => Reflect.get(Object(cause), "code") === "sandboxAlreadyExists"

const openMachine = (
  options: MicrosandboxSandboxOptions,
  name: string,
  sticky: boolean
): Effect.Effect<{ readonly sandbox: VendorSandbox; readonly created: boolean }, ProviderError> =>
  attempt(
    async () => {
      try {
        return {
          sandbox: await configure(options.sdk.Sandbox.builder(name), options, sticky).create(),
          created: true
        }
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause
        const handle = await options.sdk.Sandbox.get(name)
        const detached = options.detached ?? sticky
        return {
          sandbox: handle.status === "running"
            ? await handle.connect()
            : detached
            ? await handle.startDetached()
            : await handle.start(),
          created: false
        }
      }
    },
    "unavailable",
    `the microVM ${name} could not be opened`
  )

const environment = (
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...base, ...override }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )

/**
 * The program and arguments one command line runs as: the shell itself, or
 * `nix develop` of the planted environment around the shell.
 *
 * `-c`, not `-lc`: a login shell runs the image's profile scripts, and
 * anything those print lands ahead of the command's own output.
 */
const commandLine = (
  shell: string,
  command: string,
  nix: PlantedEnvironment | undefined
): { readonly program: string; readonly args: Array<string> } =>
  nix === undefined
    ? { program: shell, args: ["-c", command] }
    : {
      program: nix.executable,
      args: ["develop", installable(nix.directory, nix.environment), "--command", shell, "-c", command]
    }

const execute = (
  sandbox: VendorSandbox,
  line: { readonly program: string; readonly args: Array<string> },
  cwd: string,
  env: Record<string, string>,
  stdin: Uint8Array | undefined,
  code: ProviderErrorCode,
  message: string
): Effect.Effect<ExecOutput, ProviderError> =>
  attempt(
    async () => {
      const handle = await sandbox.execStreamWith(line.program, (builder) => {
        const configured = builder.args([...line.args]).cwd(cwd).envs(env)
        return stdin === undefined ? configured : configured.stdinBytes(stdin)
      })
      // Microsandbox exposes one drain for stdout, stderr, and status. Calling
      // collect more than once consumes an already-drained command handle.
      return await handle.collect()
    },
    code,
    message
  )

const processOf = (output: ExecOutput): RemoteProcess => ({
  stdout: Stream.make(output.stdoutBytes()),
  stderr: Stream.make(output.stderrBytes()),
  exitCode: Effect.succeed(output.code)
})

/**
 * The SDK wraps every guest filesystem failure in one error kind, so absence
 * is recognized by the guest's own ENOENT text riding in the message.
 */
const isMissingFile = (cause: unknown): boolean =>
  Reflect.get(Object(cause), "code") === "sandboxFsOps" &&
  /no such file or directory/i.test(messageOf(cause))

/**
 * Builds a sandbox provider backed by local Microsandbox microVMs.
 *
 * Machine creation is registered as a scoped resource before guest setup, so
 * a microVM that boots but cannot prepare its workspace is stopped. Commands
 * apply the workdir per execution because Microsandbox validates a builder
 * workdir before the selected image has booted; a relative `cwd` is rooted at
 * the session workdir and standard input rides the exec builder's own byte
 * channel. File transfer in both directions uses the SDK's byte-typed
 * operations, and process output is surfaced as the SDK's raw output bytes.
 *
 * Ephemeral persistence is the default and stops the machine when the scope
 * closes. Sticky persistence leaves a successfully prepared machine running
 * and reconnects to its deterministic name on the next acquire. With an
 * `environment`, the flake is planted and warmed before the session is
 * returned and every command runs under `nix develop` of it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MicrosandboxSandboxOptions): Provider => ({
  acquire: (sessionKey) =>
    Effect.gen(function*() {
      const name = `${namePrefix}${sessionSlug(sessionKey)}`
      const sticky = options.persistence === "sticky"
      const workdir = options.workdir ?? defaultWorkdir
      const shell = options.shell ?? defaultShell
      if (options.image !== undefined && options.snapshot !== undefined) {
        return yield* Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: "microsandbox: image and snapshot are exclusive; name one"
          })
        )
      }

      let prepared = false
      const opened = yield* Effect.acquireRelease(
        openMachine(options, name, sticky),
        ({ created, sandbox }) =>
          !sticky || created && !prepared
            ? Effect.ignore(
              attempt(() => sandbox.stop(), "unavailable", `the microVM ${name} could not be stopped`).pipe(
                Effect.tapError((error) => warnTeardown("microsandbox", "stop", error))
              )
            )
            : Effect.void
      )

      yield* attempt(
        () => opened.sandbox.fs().mkdir(workdir),
        "unavailable",
        `the workspace ${workdir} could not be prepared in ${name}`
      )

      // The Nix environment is planted and warmed before the session is
      // handed out, so the first command never pays for realising the
      // closure and a flake that does not evaluate fails the acquire, not a
      // later spawn. The warm failure carries the guest's own words.
      const nix: PlantedEnvironment | undefined = options.environment === undefined
        ? undefined
        : {
          directory: options.environment.directory ?? `${workdir}/.smithers/nix`,
          executable: options.environment.nix ?? defaultNixExecutable,
          environment: options.environment
        }
      if (nix !== undefined) {
        const files: Array<readonly [string, string]> = [[`${nix.directory}/flake.nix`, nix.environment.flake]]
        if (nix.environment.lock !== undefined) files.push([`${nix.directory}/flake.lock`, nix.environment.lock])
        yield* attempt(
          async () => {
            await opened.sandbox.fs().mkdir(nix.directory)
            for (const [path, text] of files) await opened.sandbox.fs().write(path, text)
          },
          "unavailable",
          `the Nix environment could not be planted at ${nix.directory} in ${name}`
        )
        const warmed = yield* execute(
          opened.sandbox,
          {
            program: nix.executable,
            args: ["develop", installable(nix.directory, nix.environment), "--command", "true"]
          },
          workdir,
          environment(options.env, undefined),
          undefined,
          "unavailable",
          `the Nix environment at ${nix.directory} could not be realised in ${name}`
        )
        if (warmed.code !== 0) {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: `microsandbox: the Nix environment at ${nix.directory} could not be realised in ${name} ` +
                `(nix develop exited ${warmed.code}): ${warmed.stderr().trim()}`
            })
          )
        }
      }
      prepared = true

      const resolveCwd = rootedAt(workdir)

      const session: Session = {
        id: sessionKey,
        remoteId: opened.sandbox.name,
        workdir,
        spawn: (command, spawnOptions) =>
          Effect.gen(function*() {
            yield* checkEnvironmentNames(spawnOptions.env)
            if (!shell.startsWith("/") && Object.values(spawnOptions.env ?? {}).includes(undefined)) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "spawn_error",
                  message: "microsandbox: environment deletion requires an absolute shell path"
                })
              )
            }
            const guest = environmentCommand(command, { ...options.env, ...spawnOptions.env }, shell)
            return yield* Effect.map(
              execute(
                opened.sandbox,
                commandLine(shell, guest.command, nix),
                resolveCwd(spawnOptions.cwd ?? ""),
                guest.env,
                spawnOptions.stdin,
                "spawn_error",
                `\`${command}\` could not run in ${name}`
              ),
              processOf
            )
          }),
        readFile: (path) =>
          Effect.tryPromise({
            try: () => opened.sandbox.fs().read(path),
            catch: (cause) =>
              isMissingFile(cause)
                ? new ProviderError({
                  code: "not_found",
                  message: `the microVM holds nothing at ${path}`,
                  cause
                })
                : failure("unknown", `the microVM could not read ${path}`, cause)
          }),
        writeFile: (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              yield* attempt(
                () => opened.sandbox.fs().mkdir(parent),
                "unknown",
                `the parent of ${path} could not be created in ${name}`
              )
            }
            yield* attempt(
              () => opened.sandbox.fs().write(path, content),
              "unknown",
              `the microVM could not write ${path}`
            )
          }),
        ping: Effect.asVoid(
          attempt(
            () => opened.sandbox.fs().readToString("/etc/hostname"),
            "unavailable",
            `the microVM ${name} did not answer`
          )
        )
      }
      return session
    })
})
