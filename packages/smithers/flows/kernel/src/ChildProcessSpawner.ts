/**
 * Permission-aware process spawning.
 *
 * Smithers has no shell service of its own — process execution is Effect's
 * `effect/process`. The only thing the kernel adds is the
 * `proc:spawn` capability check and the host confinement wrapper, applied to
 * the one primitive every other helper is derived from.
 *
 * There is no kernel spawner interface and no kernel spawner tag. Effect owns
 * both, and its tag fixes the error channel to `PlatformError`, so this module
 * is only the middleware: a `Layer` over Effect's own tag. A denied command is
 * projected into `PlatformError` by `Permission.toPlatformError`, which keeps
 * the structured kernel failure on the error's `cause`. Because the channel
 * stays `PlatformError`, the full six-method surface is derived from the one
 * guarded `spawn` through Effect's own `ChildProcessSpawner.make` without a
 * cast.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import { permissionDenied, toPlatformError } from "@smthrs/capability/Permission"
import { Effect, FileSystem, Layer, Option, Path, type Scope } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as ChildProcessEnvironment from "./ChildProcessEnvironment.ts"
import * as CommandLine from "./CommandLine.ts"
import { GrantStore } from "./GrantStore.ts"
import * as Containment from "./internal/Containment.ts"
import { makeCommandCapability } from "./internal/makeCapability.ts"
import * as ProcessConfinement from "./ProcessConfinement.ts"
import * as Rooted from "./Rooted.ts"
import { Workspace } from "./Workspace.ts"

const data = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`command ${String(name)} must be a data property`)
  }
  return descriptor.value
}

const optionalData = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor)) throw new TypeError(`command ${String(name)} must be a data property`)
  return descriptor.value
}

const snapshotRecord = <A extends string | Redacted.Redacted<string>>(
  value: Readonly<Record<string, A | undefined>> | undefined
): Record<string, A | undefined> | undefined => {
  if (value === undefined) return undefined
  const snapshot: Record<string, A | undefined> = Object.create(null)
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue
    if (
      !("value" in descriptor) ||
      (descriptor.value !== undefined && typeof descriptor.value !== "string" && !Redacted.isRedacted(descriptor.value))
    ) {
      throw new TypeError("command environment must contain string data properties")
    }
    snapshot[name] = descriptor.value
  }
  return Object.freeze(snapshot)
}

const snapshotStreamConfig = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (descriptors.stream === undefined) return value
  if (!("value" in descriptors.stream)) throw new TypeError("command stream must be a data property")
  const snapshot: Record<string, unknown> = { stream: descriptors.stream.value }
  for (const name of ["endOnDone", "encoding"] as const) {
    const descriptor = descriptors[name]
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new TypeError(`command ${name} must be a data property`)
      snapshot[name] = descriptor.value
    }
  }
  return Object.freeze(snapshot) as A
}

const snapshotAdditionalFds = (
  value: ChildProcess.CommandOptions["additionalFds"]
): ChildProcess.CommandOptions["additionalFds"] => {
  if (value === undefined) return undefined
  const snapshot: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {}
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue
    if (!("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null) {
      throw new TypeError("additional file descriptors must be data records")
    }
    const config = descriptor.value as ChildProcess.AdditionalFdConfig
    const type = data(config, "type")
    if (type !== "input" && type !== "output" && type !== "duplex") {
      throw new TypeError("additional file descriptor type is invalid")
    }
    const stream = type === "output" ? undefined : Object.getOwnPropertyDescriptor(config, "stream")
    const sink = type === "input" ? undefined : Object.getOwnPropertyDescriptor(config, "sink")
    snapshot[name as `fd${number}`] = Object.freeze({
      type,
      ...(stream === undefined ? {} : "value" in stream ? { stream: stream.value } : (() => {
        throw new TypeError("additional fd stream must be a data property")
      })()),
      ...(sink === undefined ? {} : "value" in sink ? { sink: sink.value } : (() => {
        throw new TypeError("additional fd sink must be a data property")
      })())
    })
  }
  return Object.freeze(snapshot)
}

const snapshotOptions = (options: ChildProcess.CommandOptions): ChildProcess.CommandOptions =>
  Object.freeze({
    killSignal: options.killSignal,
    forceKillAfter: options.forceKillAfter,
    cwd: options.cwd,
    env: snapshotRecord(options.env),
    extendEnv: options.extendEnv,
    shell: options.shell,
    detached: options.detached,
    windowsHide: options.windowsHide,
    stdin: snapshotStreamConfig(options.stdin),
    stdout: snapshotStreamConfig(options.stdout),
    stderr: snapshotStreamConfig(options.stderr),
    additionalFds: snapshotAdditionalFds(options.additionalFds)
  })

const snapshotCommand = (command: ChildProcess.Command): ChildProcess.Command => {
  const tag = data(command, "_tag")
  if (tag === "StandardCommand") {
    const executable = data(command, "command")
    const args = data(command, "args")
    const options = data(command, "options")
    if (
      typeof executable !== "string" || !Array.isArray(args) ||
      !args.every((arg): arg is string | Redacted.Redacted<string> =>
        typeof arg === "string" || (Redacted.isRedacted(arg) && typeof Redacted.value(arg) === "string")
      )
    ) {
      throw new TypeError("standard command executable and arguments are invalid")
    }
    if (typeof options !== "object" || options === null) throw new TypeError("command options are invalid")
    return ChildProcess.make(
      executable,
      Object.freeze([...args]),
      snapshotOptions(options)
    )
  }
  if (tag === "PipedCommand") {
    const left = data(command, "left")
    const right = data(command, "right")
    const options = data(command, "options")
    if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
      throw new TypeError("pipeline commands are invalid")
    }
    if (typeof options !== "object" || options === null) throw new TypeError("pipeline options are invalid")
    const from = optionalData(options, "from")
    const to = optionalData(options, "to")
    return ChildProcess.pipeTo(
      snapshotCommand(right as ChildProcess.Command),
      Object.freeze({
        ...(from === undefined ? {} : { from: from as ChildProcess.PipeFromOption }),
        ...(to === undefined ? {} : { to: to as ChildProcess.PipeToOption })
      })
    )(snapshotCommand(left as ChildProcess.Command))
  }
  throw new TypeError("unsupported command shape")
}

const replaceEnvironment = (command: ChildProcess.Command, platform: string | undefined): ChildProcess.Command => {
  if (command._tag !== "StandardCommand") {
    return ChildProcess.pipeTo(replaceEnvironment(command.right, platform), command.options)(
      replaceEnvironment(command.left, platform)
    )
  }
  const environment = ChildProcessEnvironment.make(
    command.options.extendEnv === false ? {} : ambientEnvironment(),
    command.options.env
  )
  // libuv restores an absent Windows PATH from the parent. An explicit empty
  // value preserves the caller's request to withhold executable search paths.
  if (platform === "win32" && !Object.keys(environment).some((name) => name.toUpperCase() === "PATH")) {
    environment.PATH = ""
  }
  return ChildProcess.make(command.command, command.args, { ...command.options, env: environment, extendEnv: false })
}

const maximumEnvironmentNames = 64

/**
 * Whether a stage hands a protected argument to a shell, which would parse
 * the hidden value as code no grant could see.
 */
const shellsProtectedArgument = (stage: ChildProcess.StandardCommand): boolean =>
  stage.options.shell !== undefined && stage.options.shell !== false && stage.args.some(Redacted.isRedacted)

/**
 * The environment this process holds, which a child built with
 * `ChildProcessEnvironment.make` inherits its bootstrap names from. Empty on a
 * host with no process environment, such as a browser or a Cloudflare Worker,
 * so every declared bootstrap name counts as an override there.
 *
 * This module is the one place a library reads the ambient environment for a
 * child. A host object may be supplied explicitly; it defaults to `globalThis`.
 * Code that builds a child's environment itself, or names a host path
 * a child uses (a temporary or cache directory), reads it here rather than
 * from the `process` global, so it imports and runs on every host.
 *
 * @example
 * ```ts
 * import { ChildProcessEnvironment, ChildProcessSpawner } from "@smthrs/kernel"
 *
 * const env = ChildProcessEnvironment.make(ChildProcessSpawner.ambientEnvironment(), { CI: "1" })
 * ```
 *
 * @category accessors
 * @since 1.0.0-rc.16
 */
export const ambientEnvironment = (
  host: { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } } = globalThisHost()
): Readonly<Record<string, string | undefined>> => host.process?.env ?? {}

/**
 * `globalThis` as an ambient host. A package compiled without Node's types
 * (`"types": []`, as the browser views are) types `globalThis` without
 * `process`, so the weak host type rejects it as a default (TS2559). Widened
 * to `object` first, it is a host that may or may not carry `process` under
 * either set of types; an assertion would be unnecessary under Node's.
 */
const globalThisHost = (): { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } } => {
  const host: object = globalThis
  return host
}

const environmentNames = (command: ChildProcess.StandardCommand): ReadonlyArray<string> | undefined => {
  const environment = command.options.env
  if (environment === undefined) return undefined
  const names = Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .sort()
  if (names.length === 0) return undefined
  return names.length <= maximumEnvironmentNames
    ? names
    : [...names.slice(0, maximumEnvironmentNames), `+${names.length - maximumEnvironmentNames} more`]
}

/**
 * Effect's own process spawner tag, unchanged. Re-exported so the kernel
 * namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

/**
 * Derives the full six-method surface from one `spawn`, so `exitCode`,
 * `string`, `lines`, and both `stream*` helpers can never bypass whatever
 * `spawn` was given.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export { make } from "effect/process/ChildProcessSpawner"

/**
 * Constructs an unavailable spawner stub.
 *
 * Every derived helper reports the missing host as a `NotFound`
 * `PlatformError` naming the command line, so an unconfigured capability
 * answers rather than vanishing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): ChildProcessSpawner["Service"] => ({
  ...makeSpawner((command) =>
    Effect.fail(
      systemError({
        _tag: "NotFound",
        module: "ChildProcessSpawner",
        method: "spawn",
        description: `no process host for \`${CommandLine.render(command)}\``
      })
    )
  ),
  ...overrides
})

/**
 * Provides an unavailable spawner stub.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): Layer.Layer<ChildProcessSpawner> => Layer.succeed(ChildProcessSpawner)(makeNoop(overrides))

/**
 * Host configuration for the permission-aware process spawner.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * The platform the host spawner runs on, as `process.platform` spells it.
   * Windows explicitly empties an absent search path. Defaults to the current
   * host's platform.
   */
  readonly platform?: string | undefined
}

/**
 * Decorates the process spawner in place with a `proc:spawn` capability check.
 *
 * The check is suspended into the spawn itself, so building a `Command` or a
 * stream neither requests permission nor starts a process; only running one
 * does. Every pipeline stage is checked as its own capability, left to right,
 * and no stage starts until all pass. A stage's resource is
 * `CommandLine.resource`: the command line `CommandLine.render` produces, with
 * each protected (`Redacted`) argument fingerprinted under a key drawn once per
 * layer, a `shell: true` line that holds shell control syntax marked as
 * `sh -c '<line>'`, any environment variable the child would not inherit from
 * this process named in an `env <NAME>… -- ` prefix, and a working directory
 * outside `Workspace.root` named in a `cwd <path> -- ` prefix. Custom shell
 * paths are included explicitly in the resource; browser and remote adapters
 * reject them rather than silently substituting a different shell.
 *
 * A stage that passes a protected argument through a shell (`shell: true` or
 * a custom shell) fails with an `InvalidData` `PlatformError` before any
 * check: the shell would parse the hidden value as code. Pass secrets in
 * `env`, which the resource names but never shows.
 *
 * Every approved stage requires `ProcessConfinement` in the host context.
 * A missing service refuses spawning; its `layerNoop` is the explicit choice
 * for an unconfined host.
 *
 * Pipeline `from`/`to` routing remains outside the grant. The working
 * directory and overridden environment names also reach attended surfaces as
 * display metadata; environment values never leave the command.
 *
 * The layer provides the tag it also requires: compose it over a host spawner
 * layer with `Layer.provide` and a `ChildProcess.Command` run as a plain
 * `Effect` is checked too.
 *
 * A command with no `cwd`, or a relative one, runs in `Workspace.root`, never
 * the process's own directory; the check sees that resolved directory. When
 * the host filesystem is in the layer's context, the working directory and
 * `Workspace.root` are compared by real path, so a symlink inside the
 * workspace that leads out of it is named, as its target, in the `cwd` prefix.
 * The working directory is resolved again once the grant decision arrives: a
 * stage whose directory now resolves elsewhere is refused, and an approved
 * stage starts in the directory that was judged.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerWith = (options: Options): Layer.Layer<
  ChildProcessSpawner,
  never,
  ChildProcessSpawner | GrantStore | Path.Path | Workspace
> =>
  Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const grants = yield* GrantStore
      const confinement = yield* Effect.serviceOption(ProcessConfinement.ProcessConfinement)
      const path = yield* Path.Path
      const rooted = Rooted.path(path, path.resolve((yield* Workspace).root))
      const root = rooted.resolve(".")
      // The raw host filesystem this layer is composed over, when there is one.
      // A symlink inside the workspace can lead out of it, so containment is
      // judged on real paths; a directory that cannot be resolved (it does not
      // exist, or the host has no filesystem) is judged lexically.
      const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
      // Fingerprints protected arguments in resources. Drawn per layer, so a
      // fingerprint in a prompt or a journal cannot be tested against guesses.
      const redactionKey = yield* Effect.sync(() => crypto.getRandomValues(new Uint8Array(32)))
      const real = (directory: string) =>
        Option.match(fileSystem, {
          onNone: () => Effect.succeed(directory),
          onSome: (fs) => fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory))
        })
      const within = (base: string) => (directory: string) => {
        const relative = path.relative(base, directory)
        return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
      }
      // What a stage is judged as: the directory its cwd resolves to and the
      // resource that resolution renders.
      const judge = (stage: ChildProcess.StandardCommand) =>
        Effect.gen(function*() {
          // Rooted.command gives every stage an absolute cwd.
          const cwd = stage.options.cwd!
          const realRoot = yield* real(root)
          const resolvedCwd = yield* real(cwd)
          const contains = resolvedCwd === cwd
            ? (directory: string) => within(root)(directory) || within(realRoot)(directory)
            : within(realRoot)
          return {
            resolvedCwd,
            rendered: CommandLine.resource(stage, {
              ambient: ambientEnvironment(),
              contains,
              resolvedCwd,
              redactionKey
            })
          }
        })
      const checkStage = (stage: ChildProcess.StandardCommand) =>
        Effect.gen(function*() {
          const judged = yield* judge(stage)
          yield* checkResolved(stage, judged.rendered)
          // The grant decision can suspend: an attended request waits for a
          // human. What was authorized is the directory the cwd resolved to at
          // check time, so it must still resolve there when the decision
          // arrives, and the child starts in that resolved directory. A symlink
          // swapped in during the wait is refused, never followed.
          const settled = yield* judge(stage)
          if (settled.resolvedCwd !== judged.resolvedCwd || settled.rendered !== judged.rendered) {
            return yield* refuseMoved(judged.rendered)
          }
          return ChildProcess.setCwd(stage, judged.resolvedCwd)
        })
      const refuseMoved = (rendered: string) =>
        makeCommandCapability("proc:spawn", rendered).pipe(
          Effect.flatMap((capability) =>
            Effect.fail(permissionDenied(capability, "cwd no longer names the directory that was authorized"))
          ),
          Effect.mapError((error) =>
            toPlatformError({
              module: "ChildProcessSpawner",
              method: "spawn",
              pathOrDescriptor: rendered,
              error
            })
          )
        )
      const checkResolved = (stage: ChildProcess.StandardCommand, rendered: string) => {
        const environment = environmentNames(stage)
        return makeCommandCapability("proc:spawn", rendered).pipe(
          Effect.flatMap((capability) =>
            grants.check(capability, {
              ...(capability.resource === rendered ? {} : { commandLine: rendered }),
              cwd: stage.options.cwd,
              ...(environment === undefined ? {} : { env: environment })
            })
          ),
          Effect.mapError((error) =>
            toPlatformError({
              module: "ChildProcessSpawner",
              method: "spawn",
              pathOrDescriptor: rendered,
              error
            })
          )
        )
      }
      // Checks every stage left to right and returns the command with each
      // stage's cwd replaced by the directory that was authorized.
      const check = (command: ChildProcess.Command): Effect.Effect<ChildProcess.Command, PlatformError> =>
        ChildProcess.isStandardCommand(command)
          ? checkStage(command)
          : Effect.gen(function*() {
            const left = yield* check(command.left)
            const right = yield* check(command.right)
            return ChildProcess.pipeTo(left, right, command.options)
          })
      const confine = (
        command: ChildProcess.Command
      ): Effect.Effect<
        ChildProcess.Command,
        PlatformError,
        Scope.Scope
      > =>
        Option.match(confinement, {
          onNone: () =>
            Effect.fail(systemError({
              _tag: "NotFound",
              module: "ProcessConfinement",
              method: "confine",
              description:
                "process confinement is required; use ProcessConfinement.layerNoop to explicitly run unconfined"
            })),
          onSome: (service) =>
            Effect.gen(function*() {
              const profile = yield* ProcessConfinement.profile(grants, root, path).pipe(
                Effect.mapError((error) => toPlatformError({ module: "ChildProcessSpawner", method: "spawn", error }))
              )
              const wrap = (
                command: ChildProcess.Command
              ): Effect.Effect<
                ChildProcess.Command,
                PlatformError,
                Scope.Scope
              > =>
                command._tag === "StandardCommand"
                  ? service.confine(command, profile)
                  : Effect.gen(function*() {
                    const left = yield* wrap(command.left)
                    const right = yield* wrap(command.right)
                    return ChildProcess.pipeTo(right, command.options)(left)
                  })
              return yield* wrap(command)
            })
        })
      return Containment.inherit(
        spawner,
        makeSpawner(
          Effect.fn("ChildProcessSpawner.spawn")((command: ChildProcess.Command) =>
            Effect.try({
              try: () => snapshotCommand(command),
              catch: () =>
                systemError({
                  _tag: "InvalidData",
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "command must be an immutable supported process description"
                })
            }).pipe(
              Effect.filterOrFail(
                (snapshot) => !CommandLine.stages(snapshot).some(shellsProtectedArgument),
                () =>
                  systemError({
                    _tag: "InvalidData",
                    module: "ChildProcessSpawner",
                    method: "spawn",
                    description: "a protected argument cannot pass through a shell; pass the secret in env instead"
                  })
              ),
              Effect.map((snapshot) => Rooted.command(snapshot, rooted)),
              Effect.flatMap((rooted) =>
                check(rooted).pipe(
                  Effect.flatMap((authorized) =>
                    confine(replaceEnvironment(
                      authorized,
                      options.platform ??
                        (globalThis as { readonly process?: { readonly platform?: string } }).process?.platform
                    ))
                  ),
                  Effect.flatMap(spawner.spawn)
                )
              )
            )
          )
        )
      )
    })
  )

/**
 * Decorates the process spawner using the current host's platform.
 *
 * See {@link layerWith} for the permission and confinement contract and
 * explicit host configuration.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = layerWith({})
