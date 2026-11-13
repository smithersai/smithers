/**
 * Serves the session contract over a container something else runs.
 *
 * @since 1.0.0-rc.8
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import { ambientEnvironment } from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"
import { decodeBase64Bytes } from "../internal/base64.ts"
import { environmentInput } from "../internal/environmentInput.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { envPrefix } from "../internal/envPrefix.ts"
import { parentOf } from "../internal/guestPath.ts"
import { linuxFileSystem } from "../internal/linuxFileSystem.ts"
import { gather, type GatheredRun, remoteProcessOf } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * One program to run inside a container: the request half of
 * `@smthrs/std/Container`.
 *
 * @category models
 * @since 1.0.0-rc.8
 */
export interface TransportRequest {
  readonly container: string
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  /** Whether the program reads standard input. */
  readonly stdin: boolean
}

/**
 * The host command that satisfies a {@link TransportRequest}. `env` is the
 * environment that command needs beyond the least-authority one, such as the
 * variables a container CLI finds its daemon by.
 *
 * @category models
 * @since 1.0.0-rc.8
 */
export interface TransportPlan {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env?: Record<string, string> | undefined
}

/**
 * How a host reaches a container it already runs. It has the shape of
 * `@smthrs/std/Container`, so a host passes the transport its `bash` flow
 * uses rather than building a second route.
 *
 * @category models
 * @since 1.0.0-rc.8
 */
export interface Transport {
  readonly exec: (request: TransportRequest) => Effect.Effect<TransportPlan, unknown>
}

/**
 * What {@link existing} needs to reach the container.
 *
 * @category models
 * @since 1.0.0-rc.8
 */
export interface ExistingOptions {
  /** The container, as the transport names it. */
  readonly container: string
  /** The absolute guest path relative paths and commands resolve under. */
  readonly workdir: string
  /** The spawner the transport's host commands run through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /**
   * Bootstrap environment supplied by the host composition. Only the kernel's
   * bootstrap allowlist is inherited. Omission preserves the host defaults through
   * the kernel's browser-safe accessor; pass an empty record to inherit none.
   */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>> | undefined
  readonly transport: Transport
}

/** The read probe's answers for a path it will not read. */
const refusals: Readonly<Record<number, readonly [PlatformError.SystemErrorTag, string]>> = {
  9: ["NotFound", "nothing is there in the container"],
  11: ["BadResource", "it is a directory in the container"],
  12: ["PermissionDenied", "the container's user may not read it"]
}

/** Why the read probe refused: its own reason for a code it reserves, else the utility's words. */
const refused = (result: GatheredRun): string => refusals[result.code]?.[1] ?? result.stderr.trim()

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? `: ${error.message}`
    : ""

const readFailure = (path: string, tag: PlatformError.SystemErrorTag, description: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: path,
    description,
    cause
  })

/**
 * A session over a container that something else started and owns, such as
 * a benchmark's task container, reached through the host's container
 * transport.
 *
 * There is no lifecycle and nothing to prepare: no command runs until the
 * session is asked for one, and closing the caller's scope leaves the
 * container as it was. Every command, read, and write is one `/bin/sh -c`
 * through `transport`, run in {@link ExistingOptions.workdir} unless the
 * command names another directory. File bytes come back as base64, so a
 * transport whose output channel carries only text, such as a Smithers Cloud
 * workspace behind a `docker` shim, returns them intact; they go in on
 * standard input unchanged. The caller's environment travels to the command
 * the way `ContainerSandbox.make` sends it, through standard input to an
 * `env(1)` prefix, and the transport's host command gets the least-authority
 * environment plus the plan's own `env`.
 *
 * The file operations are the Linux ones every container session shares:
 * real mode and ownership from `stat`, exclusive creation, `chmod`, and
 * `chown`. `readFile` reports a directory, an absent path, and a path the
 * container's user may not read with the reasons the platform implementations
 * give them. The guest needs `sh`, `base64`, and the GNU or BusyBox utilities.
 *
 * The session declares no `kill`: closing a command's scope ends the
 * transport's host process, and a container engine does not pass that on to
 * the process it started. Use it for short commands, such as file
 * operations, and run long ones where they can be stopped.
 *
 * @category constructors
 * @since 1.0.0-rc.8
 */
export const existing = (options: ExistingOptions): Session => {
  const { container, workdir } = options
  const resolveCwd = rootedAt(workdir)
  const unreachable = (error: unknown) =>
    new ProviderError({
      code: "unavailable",
      message: `the container ${container} could not be reached${messageOf(error)}`,
      cause: error
    })
  const launch = (script: string, cwd: string, stdin: Stream.Stream<Uint8Array> | undefined) =>
    Effect.flatMap(
      Effect.mapError(
        options.transport.exec({ container, file: "/bin/sh", args: ["-c", script], cwd, stdin: stdin !== undefined }),
        unreachable
      ),
      (plan) =>
        Effect.mapError(
          options.spawner.spawn(ChildProcess.make(plan.file, [...plan.args], {
            env: ChildProcessEnvironment.make(options.hostEnvironment ?? ambientEnvironment(), plan.env),
            extendEnv: false,
            ...stdin === undefined ? {} : { stdin }
          })),
          unreachable
        )
    )
  const run = (script: string, stdin?: Uint8Array): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.flatMap(
        launch(script, workdir, stdin === undefined ? undefined : Stream.make(stdin)),
        (handle) => gather(handle, script)
      )
    )
  /** The file's bytes as base64 on exit 0, or one of the {@link refusals} codes. */
  const read = (path: string) => {
    const target = CommandLine.quote(path)
    return run(
      `if [ -d ${target} ]; then exit 11; elif [ ! -e ${target} ]; then exit 9; ` +
        `elif [ ! -r ${target} ]; then exit 12; fi; base64 < ${target}`
    )
  }
  const session: Session = {
    id: container,
    remoteId: container,
    workdir,
    spawn: Effect.fnUntraced(function*(command, spawnOptions) {
      yield* checkEnvironmentNames(spawnOptions.env)
      const input = environmentInput(envPrefix(spawnOptions.env), spawnOptions.stdin)
      const handle = yield* launch(
        `${input.script}exec ${input.prefix}/bin/sh -c ${CommandLine.quote(command)}`,
        resolveCwd(spawnOptions.cwd ?? ""),
        input.stdin
      )
      return remoteProcessOf(handle, command)
    }),
    readFile: (path) =>
      Effect.flatMap(read(path), (result) =>
        result.code === 0
          ? decodeBase64Bytes(result.stdout, `for ${path}`)
          : Effect.fail(
            new ProviderError(
              result.code === 9
                ? { code: "not_found", message: `the container holds nothing at ${path}` }
                : { code: "unknown", message: `the container could not read ${path}: ${refused(result)}` }
            )
          )),
    writeFile: (path, content) => {
      const parent = parentOf(path)
      const write = `cat > ${CommandLine.quote(path)}`
      return Effect.flatMap(
        run(parent === undefined ? write : `mkdir -p ${CommandLine.quote(parent)} && ${write}`, content),
        (result) =>
          result.code === 0 ? Effect.void : Effect.fail(
            new ProviderError({
              code: "unknown",
              message: `the container could not write ${path}: ${result.stderr.trim()}`
            })
          )
      )
    }
  }
  const readFile: FileSystem.FileSystem["readFile"] = (path) =>
    Effect.flatMap(
      Effect.mapError(read(path), (error) => readFailure(path, "Unknown", error.message, error)),
      (result) => {
        if (result.code === 0) {
          return Effect.mapError(
            decodeBase64Bytes(result.stdout, `for ${path}`),
            (error) => readFailure(path, "InvalidData", error.message, error)
          )
        }
        return Effect.fail(
          readFailure(path, refusals[result.code]?.[0] ?? "Unknown", `\`${path}\`: ${refused(result)}`)
        )
      }
    )
  return {
    ...session,
    files: {
      ...linuxFileSystem(session, "container"),
      readFile,
      readFileString: (path) => Effect.map(readFile(path), (bytes) => new TextDecoder().decode(bytes))
    }
  }
}
