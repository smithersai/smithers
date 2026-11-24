/**
 * A container Durable Object's container as a `Sandbox.Session` from
 * `@smthrs/sandbox`: the seam through which `SandboxTools`, `Sandbox.layerHost`
 * and every other session consumer reach a Cloudflare container.
 *
 * {@link make} adapts a structural slice of an Effect container client, so an
 * Alchemy Durable Object's container handle passes in as is (`R` is its
 * `RuntimeContext`), and a test passes another. Every command runs with
 * `sh -c` as one user in one working directory; `readFile` and `writeFile`
 * are commands too, so the container needs `sh`, `cat` and `head`. File reads collect at most
 * `maxFileBytes` (4 MiB by default) and refuse larger files.
 *
 * It starts nothing: the object wakes its container (`SandboxObject.wake`)
 * before it hands the session out. A failure of the container itself
 * surfaces as a `ProviderError` with code `unavailable`, its message naming
 * the operation and never the command or a path.
 *
 * The user is a numeric `uid:gid`: a deployed container's `exec` refuses a
 * user name and runs a bare `uid` as root, while local Docker accepts both.
 * A session given anything else fails every command with `spawn_error`
 * before it reaches the container, so development fails as production
 * would. A command inherits only `PATH` from the image; `env` carries the
 * rest, such as `HOME`.
 *
 * @since 1.0.0-rc.17
 */

import { RetryPolicy } from "@smthrs/flow"
import { RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import type * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"

/**
 * The options of one command {@link make}'s session runs: the slice of a
 * container's exec options it sets.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ExecOptions {
  readonly user?: string
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: "pipe"
  readonly stdout: "pipe"
  readonly stderr: "pipe"
}

/**
 * A command running in the container: the slice of an Effect container
 * client's process {@link make} uses. `stdin` is present when the exec asked
 * for it, and completing it closes the command's input.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Process<E = never, R = never> {
  readonly stdin: Sink.Sink<unknown, Uint8Array, unknown, E, R> | undefined
  readonly stdout: Stream.Stream<Uint8Array, E, R> | undefined
  readonly stderr: Stream.Stream<Uint8Array, E, R> | undefined
  readonly exitCode: Effect.Effect<number, E, R>
}

/**
 * The slice of an Effect container client {@link make} uses: `exec`, which
 * runs an argument vector in the running container. The process belongs to
 * the scope that ran `exec`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Container<E = never, R = never> {
  exec(cmd: Array<string>, options: ExecOptions): Effect.Effect<Process<E, R>, E, R | Scope.Scope>
}

/**
 * Options for {@link make}.
 *
 * - `id`: the session's key, and the `remoteId` it reports.
 * - `workdir`: the absolute directory commands run in unless they name
 *   another; a relative `cwd` is taken under it.
 * - `user`: the `uid:gid` every command runs as, such as `1000:2000` or
 *   `0:0` for root; the image's user when absent.
 * - `env`: variables every command gets, under the command's own.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Options {
  readonly id: string
  readonly workdir: string
  readonly user?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Maximum bytes collected by readFile (default 4 MiB). */
  readonly maxFileBytes?: number | undefined
}

const { ProviderError } = RemoteChildProcessSpawner

const unavailable = (operation: string) => (cause: unknown) =>
  new ProviderError({ code: "unavailable", message: `container session: ${operation} failed`, cause })

/**
 * Logs the container's own failure of `operation` (`exec`, `stdout`, `stderr` or `exit`) as
 * `cloudflare.container_session`, with the failure's tag and never its text.
 */
const logged = (operation: string) => (cause: unknown) =>
  Effect.logWarning("cloudflare.container_session").pipe(
    Effect.annotateLogs({ operation, outcome: "failed", "error.type": RetryPolicy.errorTag(cause) ?? "unknown" })
  )

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const uidGid = /^\d{1,10}:\d{1,10}$/

/**
 * The container as a session. Needs `R`, the container client's own
 * requirement, once, here; the session's operations carry it.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const make = <E, R>(container: Container<E, R>, options: Options): Effect.Effect<Sandbox.Session, never, R> =>
  Effect.map(Effect.context<R>(), (context) => {
    const workdir = options.workdir
    const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError("container session: invalid maxFileBytes")
    }
    const spawnWithInput = (command: string, spawnOptions: Parameters<Sandbox.Session["spawn"]>[1], strict = false) =>
      Effect.gen(function*() {
        if (options.user !== undefined && !uidGid.test(options.user)) {
          return yield* Effect.fail(
            new ProviderError({ code: "spawn_error", message: "container session: the user is not a numeric uid:gid" })
          )
        }
        const env: Record<string, string> = { ...options.env }
        const removed: Array<string> = []
        for (const [name, value] of Object.entries({ ...options.env, ...spawnOptions.env })) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            return yield* Effect.fail(
              new ProviderError({ code: "spawn_error", message: "container session: invalid environment name" })
            )
          }
          if (value === undefined) {
            delete env[name]
            removed.push(name)
          } else env[name] = value
        }
        const cwd = spawnOptions.cwd === undefined
          ? workdir
          : spawnOptions.cwd.startsWith("/")
          ? spawnOptions.cwd
          : `${workdir}/${spawnOptions.cwd}`
        const stdin = spawnOptions.stdin
        const process = yield* container.exec([
          "sh",
          "-c",
          removed.length === 0 ? command : `unset ${removed.join(" ")} || exit 125; ${command}`
        ], {
          ...options.user === undefined ? {} : { user: options.user },
          cwd,
          env,
          ...stdin === undefined ? {} : { stdin: "pipe" as const },
          stdout: "pipe",
          stderr: "pipe"
        }).pipe(Effect.tapError(logged("exec")), Effect.mapError(unavailable("exec")))
        const { stdout, stderr } = process
        if (stdout === undefined || stderr === undefined || (stdin !== undefined && process.stdin === undefined)) {
          return yield* Effect.fail(unavailable("exec")("a stream the command needs is missing"))
        }
        const feed = stdin === undefined ? undefined : yield* Stream.run(Stream.make(stdin), process.stdin!).pipe(
          Effect.tapError(logged("stdin")),
          Effect.mapError(unavailable("stdin")),
          Effect.forkScoped
        )
        const exitCode = process.exitCode.pipe(Effect.tapError(logged("exit")), Effect.mapError(unavailable("exit")))
        return {
          stdout: stdout.pipe(Stream.tapError(logged("stdout")), Stream.mapError(unavailable("stdout")))
            .pipe(Stream.provideContext(context)),
          stderr: stderr.pipe(Stream.tapError(logged("stderr")), Stream.mapError(unavailable("stderr")))
            .pipe(Stream.provideContext(context)),
          exitCode: (feed === undefined
            ? exitCode
            : strict
            ? Effect.all([Fiber.join(feed), exitCode], { concurrency: "unbounded" }).pipe(
              Effect.map(([, code]) => code)
            )
            : Effect.flatMap(exitCode, (code) =>
              Effect.gen(function*() {
                yield* Fiber.interrupt(feed)
                return code
              }))).pipe(Effect.provideContext(context))
        }
      }).pipe(Effect.provideContext(context))

    const spawn: Sandbox.Session["spawn"] = (command, spawnOptions) => spawnWithInput(command, spawnOptions)

    /** Collect during consumption so a guest cannot force an unbounded allocation. */
    const collect = (stream: Stream.Stream<Uint8Array, InstanceType<typeof ProviderError>>) =>
      Effect.suspend(() => {
        let bytes = new Uint8Array()
        let used = 0
        return Stream.runForEach(stream, (chunk) => {
          if (chunk.length > maxFileBytes - used) {
            return Effect.fail(
              new ProviderError({ code: "unknown", message: "container session: file byte limit exceeded" })
            )
          }
          const end = used + chunk.length
          if (end > bytes.length) {
            const grown = new Uint8Array(Math.min(maxFileBytes, Math.max(end, bytes.length * 2, 256)))
            grown.set(bytes)
            bytes = grown
          }
          bytes.set(chunk, used)
          used = end
          return Effect.void
        }).pipe(Effect.map(() => bytes.subarray(0, used)))
      })

    /** Runs `command` to completion: its exit code and bounded standard output. */
    const run = (command: string, stdin?: Uint8Array) =>
      Effect.scoped(Effect.gen(function*() {
        const process = yield* spawnWithInput(command, stdin === undefined ? {} : { stdin }, stdin !== undefined)
        const [stdout, , code] = yield* Effect.all([
          collect(process.stdout),
          Stream.runDrain(process.stderr),
          process.exitCode
        ], { concurrency: "unbounded" })
        return { bytes: stdout, code }
      }))

    const session: Sandbox.Session = {
      id: options.id,
      remoteId: options.id,
      workdir,
      spawn,
      readFile: (path) =>
        Effect.flatMap(
          run(`[ -f ${quote(path)} ] || exit 44; head -c ${maxFileBytes + 1} -- ${quote(path)}`),
          ({ bytes, code }) =>
            code === 0
              ? Effect.succeed(bytes)
              : Effect.fail(
                new ProviderError({
                  code: code === 44 ? "not_found" : "unknown",
                  message: `container session: read failed (${code})`
                })
              )
        ),
      writeFile: (path, content) =>
        Effect.flatMap(
          run(`mkdir -p -- "$(dirname -- ${quote(path)})" && cat >${quote(path)}`, content),
          ({ code }) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                new ProviderError({ code: "unknown", message: `container session: write failed (${code})` })
              )
        ),
      ping: Effect.flatMap(run("true"), ({ code }) =>
        code === 0
          ? Effect.void
          : Effect.fail(
            new ProviderError({ code: "unavailable", message: `container session: ping failed (${code})` })
          ))
    }
    return session
  })
