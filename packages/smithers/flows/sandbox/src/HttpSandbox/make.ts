/**
 * Constructs the HTTP sandbox provider.
 *
 * @since 1.0.0-rc.17
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import type * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Queue from "effect/Queue"
import * as Random from "effect/Random"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { cancelGuard, killScript } from "../internal/killScript.ts"
import type { RemoteOptions, RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { type ResourceLimits, validateResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import { Acquire, Command, CommandResult, Failure, LimitsQuery, SessionInfo } from "./protocol.ts"

/**
 * How the provider reaches the service and paces its requests.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface HttpSandboxOptions {
  /** The service's base URL; routes are under `<url>/v1`. */
  readonly url: string
  /** The bearer token the service expects. */
  readonly token: string
  /** The HTTP client every request goes through. */
  readonly client: HttpClient.HttpClient
  /** The session's machine ceilings, sent with every request; the service picks its provider by them. */
  readonly limits?: ResourceLimits | undefined
  /** The largest file body one request carries; a larger write is sent in chunks. Default {@link defaults}. */
  readonly chunkBytes?: number | undefined
  /** How long a running command waits between polls that found no new output. Default {@link defaults}. */
  readonly pollInterval?: Duration.Input | undefined
  /** The most bytes of each stream one poll answers. Default {@link defaults}. */
  readonly pollBytes?: number | undefined
  /** How long one request may take before it counts as lost. Default {@link defaults}. */
  readonly requestTimeout?: Duration.Input | undefined
  /** How many times a request lost on the way is sent again. Default {@link defaults}. */
  readonly retries?: number | undefined
  /** The wait before the first resend, doubling for each after it. Default {@link defaults}. */
  readonly retryDelay?: Duration.Input | undefined
  /**
   * The absolute guest directory each command's output and exit status are
   * kept under, outside the workdir. Letters, digits, `.`, `_`, `-` and `/`
   * only. Default {@link defaults}.
   */
  readonly processDirectory?: string | undefined
}

/**
 * The provider's defaults: 16 MiB file chunks, a poll every 250 ms of at most
 * 1 MiB per stream, a minute per request, four resends from 200 ms, and
 * command records under `/tmp/.smthrs-http`.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const defaults = {
  chunkBytes: 16 * 1024 * 1024,
  pollInterval: "250 millis",
  pollBytes: 1024 * 1024,
  requestTimeout: "1 minute",
  retries: 4,
  retryDelay: "200 millis",
  processDirectory: "/tmp/.smthrs-http"
} as const

/** A request that failed on the way and may be sent again. */
class Lost extends Data.TaggedError("Lost")<{ readonly reason: string }> {}

const q = CommandLine.quote
const decoder = new TextDecoder()
const encodeAcquire = Schema.encodeSync(Schema.fromJsonString(Acquire))
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Command))
const encodeLimits = Schema.encodeSync(LimitsQuery)
const decodeInfo = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionInfo))
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CommandResult))
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Failure))

/**
 * The detached runner of one command under directory `d`: it records its own
 * pid, runs the command in a shell that records its pid in `d/pid` and checks
 * the cancel marker `killScript` plants, then records the exit status. Every
 * file is written whole and renamed, so a reader never sees half of one. With
 * `d` removed, the redirections fail and the command never runs.
 */
const runnerScript = (d: string, command: string, input: boolean) => {
  const pid = `${d}/pid`
  const inner = `echo $$ >${q(pid)} || exit 125; ${cancelGuard(pid)}; exec /bin/sh -c "$0"`
  return `printf '%s\\n' "$$" >${q(`${d}/runner.tmp`)} && mv ${q(`${d}/runner.tmp`)} ${
    q(`${d}/runner`)
  } || exit 125\n` +
    `/bin/sh -c ${q(inner)} ${q(command)} <${input ? q(`${d}/in`) : "/dev/null"} >${q(`${d}/out`)} 2>${
      q(`${d}/err`)
    }\n` +
    `printf '%s\\n' "$?" >${q(`${d}/exit.tmp`)} && mv ${q(`${d}/exit.tmp`)} ${q(`${d}/exit`)}`
}

/**
 * Starts the runner the first time directory `d` is made, in a session of its
 * own (`setsid`) or else a process group of its own, so it outlives the
 * request that started it; a start sent again finds `d` and starts nothing.
 * Either way it answers once the runner recorded its pid.
 */
const startScript = (root: string, d: string, command: string, input: boolean) =>
  `mkdir -p ${q(root)} || exit 125\n` +
  `if mkdir ${q(d)} 2>/dev/null; then\n` +
  (input ? `cat >${q(`${d}/in`)} || exit 125\n` : "") +
  `r=${q(runnerScript(d, command, input))}\n` +
  `if command -v setsid >/dev/null 2>&1; then setsid /bin/sh -c "$r" </dev/null >/dev/null 2>&1 &\n` +
  `else (set -m 2>/dev/null; /bin/sh -c "$r" </dev/null >/dev/null 2>&1 &); fi\n` +
  (input ? `else cat >/dev/null\n` : "") +
  `fi\n` +
  `i=0; while [ ! -f ${q(`${d}/runner`)} ]; do i=$((i+1)); [ "$i" -lt 500 ] || exit 125; ` +
  `sleep 0.01 2>/dev/null || sleep 1; done`

/**
 * One poll of the command under `d`: a status line (`x <code>` once it
 * exited, `r` while its runner lives, `l` when neither holds), then up to
 * `max` bytes of its stdout from byte `out`; up to `max` bytes of its stderr
 * from byte `err` go to stderr. The exit is read before the output, so an
 * exited command's output is complete when it is read.
 */
const pollScript = (d: string, out: number, err: number, max: number) =>
  `d=${q(d)}\n` +
  `if [ -f "$d/exit" ]; then read -r x <"$d/exit"; s="x $x"\n` +
  `elif read -r p 2>/dev/null <"$d/runner" && kill -0 "$p" 2>/dev/null; then s=r\n` +
  `elif [ -f "$d/exit" ]; then read -r x <"$d/exit"; s="x $x"\n` +
  `else s=l; fi\n` +
  `printf '%s\\n' "$s"\n` +
  `tail -c +${out + 1} "$d/out" 2>/dev/null | head -c ${max}\n` +
  `tail -c +${err + 1} "$d/err" 2>/dev/null | head -c ${max} >&2\n` +
  `exit 0`

const wholeNumber = (name: string, value: number, least: number) => {
  if (!Number.isSafeInteger(value) || value < least) {
    throw new TypeError(`http-sandbox: ${name} must be a whole number from ${least}: ${value}`)
  }
}

/**
 * Builds a provider whose machines are held by a service that mounts
 * `HttpSandbox.serve`, reached through `options.client`.
 *
 * `acquire` asks the service for the session key's machine and destroys it
 * when the acquiring scope closes. `readFile` is one `GET`, so a file is read
 * whole and must fit one response. `writeFile` sends a file over
 * `chunkBytes` as a first `PUT` and appends at each further offset.
 *
 * `spawn` never holds a request for the command's lifetime. One short request
 * starts the command detached in the machine, with its output and exit status
 * in files under `processDirectory`; the streams are fed by polls that ask
 * for the bytes after those already read, and `exitCode` resolves once the
 * exit status is there and the output read to its end. Closing the spawn's
 * scope before then signals the command and every process it started
 * (`SIGTERM`), and the files are removed either way, except after a start
 * whose answer never came: its directory stays as the fence that keeps a
 * late start from running. A runner that ended without recording an exit
 * fails the process with `unavailable`.
 *
 * Every request is safe to send again: the start of a command by the id this
 * provider chose for it, a chunk by its offset. So a request that failed on
 * the way (a transport failure, a `5xx`, no answer within `requestTimeout`)
 * is sent again up to `retries` times, and then fails `unavailable`. A
 * refusal keeps the service's code; a `401` is `unknown`.
 *
 * Throws a `TypeError` for a malformed `url`, an empty `token`, a
 * non-positive `chunkBytes` or `pollBytes`, a negative `retries`, a
 * `processDirectory` that is not an absolute plain path, or invalid `limits`.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const make = (options: HttpSandboxOptions): Provider => {
  const base = new URL(options.url).href.replace(/\/+$/, "")
  if (options.token === "") throw new TypeError("http-sandbox: token must not be empty")
  const chunkBytes = options.chunkBytes ?? defaults.chunkBytes
  const pollBytes = options.pollBytes ?? defaults.pollBytes
  const retries = options.retries ?? defaults.retries
  const root = options.processDirectory ?? defaults.processDirectory
  wholeNumber("chunkBytes", chunkBytes, 1)
  wholeNumber("pollBytes", pollBytes, 1)
  wholeNumber("retries", retries, 0)
  if (!/^\/[A-Za-z0-9._/-]*$/.test(root) || root.split("/").includes("..")) {
    throw new TypeError(`http-sandbox: processDirectory must be an absolute plain path: ${root}`)
  }
  const limits = options.limits === undefined ? undefined : validateResourceLimits("http-sandbox", options.limits)
  const limitsQuery = limits === undefined ? {} : encodeLimits(limits)
  const pollInterval = options.pollInterval ?? defaults.pollInterval
  const timeout = options.requestTimeout ?? defaults.requestTimeout
  const retry = Schedule.exponential(options.retryDelay ?? defaults.retryDelay)

  /** Sends `request` until it is answered, reading the answer with `read`. */
  const send = <A>(
    what: string,
    request: HttpClientRequest.HttpClientRequest,
    read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, ProviderError | Lost>
  ): Effect.Effect<A, ProviderError> =>
    options.client.execute(HttpClientRequest.bearerToken(request, options.token)).pipe(
      Effect.flatMap((response) =>
        response.status >= 500
          ? Effect.fail(new Lost({ reason: `HTTP ${response.status}` }))
          : response.status === 401
          ? Effect.fail(
            new ProviderError({ code: "unknown", message: `http-sandbox: the service refused the token (${what})` })
          )
          : response.status >= 400
          ? Effect.flatMap(
            Effect.mapError(response.text, (error) => new Lost({ reason: error.message })),
            (text) => {
              const failure = decodeFailure(text)
              return Effect.fail(
                failure._tag === "Some"
                  ? new ProviderError({ code: failure.value.code, message: failure.value.message })
                  : new ProviderError({
                    code: "unknown",
                    message: `http-sandbox: ${what} answered HTTP ${response.status}`
                  })
              )
            }
          )
          : read(response)
      ),
      Effect.timeout(timeout),
      Effect.catchTags({
        HttpClientError: (error) => Effect.fail(new Lost({ reason: error.message })),
        TimeoutError: () => Effect.fail(new Lost({ reason: "no answer within the request timeout" }))
      }),
      Effect.retry({ schedule: retry, times: retries, while: (error) => error._tag === "Lost" }),
      Effect.catchTag("Lost", (lost) =>
        Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `http-sandbox: ${what} was lost ${retries + 1} times; last: ${lost.reason}`
          })
        ))
    )

  const bodyOf = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.mapError(response.text, (error) => new Lost({ reason: error.message }))

  const malformed = (what: string) => (error: { readonly message: string }) =>
    new ProviderError({ code: "unknown", message: `http-sandbox: ${what} answered malformed JSON: ${error.message}` })

  const sessionUrl = (remoteId: string) => `${base}/v1/sessions/${encodeURIComponent(remoteId)}`

  const destroy = (session: Pick<Session, "id" | "remoteId">) =>
    send(
      `destroying ${session.remoteId}`,
      HttpClientRequest.delete(sessionUrl(session.remoteId)).pipe(
        HttpClientRequest.setUrlParams({ ...limitsQuery, id: session.id })
      ),
      () => Effect.void
    )

  const open = (info: typeof SessionInfo.Type, token: string): Session => {
    const files = (path: string, offset?: number) =>
      HttpClientRequest.setUrlParams({
        ...limitsQuery,
        id: info.id,
        path,
        ...offset === undefined ? {} : { offset: String(offset) }
      })

    /** Runs `command` to its end in one request. */
    const exec = (command: string, extra: Omit<typeof Command.Type, "id" | "command" | "limits"> = {}) =>
      send(
        `a command in ${info.remoteId}`,
        HttpClientRequest.post(`${sessionUrl(info.remoteId)}/commands`).pipe(
          HttpClientRequest.bodyText(encodeCommand({ id: info.id, command, limits, ...extra }), "application/json")
        ),
        (response) =>
          Effect.flatMap(
            bodyOf(response),
            (text) => Effect.mapError(decodeResult(text), malformed(`a command in ${info.remoteId}`))
          )
      )

    const failed = (code: ProviderError["code"], message: string, result: typeof CommandResult.Type) =>
      new ProviderError({
        code,
        message: `http-sandbox: ${message} (exit ${result.exitCode}): ${decoder.decode(result.stderr).trim()}`
      })

    let next = 0
    const directories = new WeakMap<RemoteProcess, string>()

    const spawn = Effect.fnUntraced(function*(command: string, spawnOptions: RemoteOptions) {
      const d = `${root}/${token}-${next++}`
      // The runner leads a process group holding the command and everything
      // it started that did not leave it. Stopping that group first holds the
      // command still while the slower descendant walk (`killScript`) finds
      // and signals the rest; the group is then signalled and resumed.
      const end = `g=; read -r g 2>/dev/null <${q(`${d}/runner`)} && kill -STOP -"$g" 2>/dev/null; ` +
        `(${killScript(`${d}/pid`, "TERM")}); ` +
        `if [ -n "$g" ]; then kill -TERM -"$g" 2>/dev/null; kill -CONT -"$g" 2>/dev/null; fi`
      let state: "starting" | "running" | "ended" = "starting"
      let poller: Fiber.Fiber<unknown> | undefined = undefined
      // The scope is the process's lifetime, registered before the start so
      // an interrupted start is covered too. A command seen to end leaves
      // only its files to remove. A running one is ended first. A start whose
      // answer never came may still land, so its directory is claimed and
      // kept: the start then finds it and starts nothing, and a runner that
      // did start is ended. The poller stops after the command does, so a
      // poll in flight does not delay the signal.
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          finalizeWithin(
            Effect.ignore(
              exec(
                state === "ended"
                  ? `rm -rf ${q(d)}`
                  : state === "running"
                  ? `${end}; rm -rf ${q(d)}`
                  : `mkdir -p ${q(d)} && { ${end}; }`
              ),
              { log: "Warn" }
            ),
            `http sandbox ${info.remoteId} process ${d}`
          ),
          poller === undefined ? Effect.void : Fiber.interrupt(poller)
        )
      )
      const started = yield* exec(startScript(root, d, command, spawnOptions.stdin !== undefined), {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env === undefined
          ? undefined
          : Object.fromEntries(Object.entries(spawnOptions.env).map(([name, value]) => [name, value ?? null])),
        stdin: spawnOptions.stdin
      })
      if (started.exitCode !== 0) {
        return yield* Effect.fail(failed("spawn_error", `\`${command}\` could not start in ${info.remoteId}`, started))
      }
      state = "running"
      const stdout = yield* Queue.unbounded<Uint8Array, ProviderError | Cause.Done>()
      const stderr = yield* Queue.unbounded<Uint8Array, ProviderError | Cause.Done>()
      const exit = yield* Deferred.make<number, ProviderError>()
      const poll = (out: number, err: number): Effect.Effect<void, ProviderError> =>
        Effect.gen(function*() {
          const result = yield* exec(pollScript(d, out, err, pollBytes))
          if (result.exitCode !== 0) {
            return yield* Effect.fail(failed("unknown", `\`${command}\` could not be observed`, result))
          }
          const line = result.stdout.indexOf(10)
          const status = decoder.decode(result.stdout.subarray(0, line))
          const chunk = result.stdout.subarray(line + 1)
          if (chunk.length > 0) yield* Queue.offer(stdout, chunk)
          if (result.stderr.length > 0) yield* Queue.offer(stderr, result.stderr)
          if (status === "l") {
            return yield* Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `http-sandbox: \`${command}\` in ${info.remoteId} ended without recording its exit`
              })
            )
          }
          const drained = chunk.length < pollBytes && result.stderr.length < pollBytes
          if (drained && status.startsWith("x ")) {
            state = "ended"
            yield* Queue.end(stdout)
            yield* Queue.end(stderr)
            return yield* Deferred.succeed(exit, Number(status.slice(2)))
          }
          if (drained) yield* Effect.sleep(pollInterval)
          return yield* poll(out + chunk.length, err + result.stderr.length)
        })
      const observe = poll(0, 0).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            Effect.all([Queue.fail(stdout, error), Queue.fail(stderr, error)]),
            Deferred.fail(exit, error)
          )
        )
      )
      poller = yield* Effect.forkDetach(observe)
      const process: RemoteProcess = {
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        exitCode: Deferred.await(exit)
      }
      directories.set(process, d)
      return process
    })

    return {
      id: info.id,
      remoteId: info.remoteId,
      workdir: info.workdir,
      spawn,
      kill: (process, signal) =>
        Effect.suspend(() => {
          const d = directories.get(process)
          /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
          if (d === undefined) {
            return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
          }
          return Effect.flatMap(
            exec(killScript(`${d}/pid`, signal.replace(/^SIG/, ""))),
            (result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(failed("unknown", `the signal ${signal} could not be delivered`, result))
          )
        }),
      readFile: (path) =>
        send(
          `reading ${path}`,
          HttpClientRequest.get(`${sessionUrl(info.remoteId)}/files`).pipe(files(path)),
          (response) =>
            Effect.map(
              Effect.mapError(response.arrayBuffer, (error) => new Lost({ reason: error.message })),
              (buffer) => new Uint8Array(buffer)
            )
        ),
      writeFile: (path, content) =>
        Effect.gen(function*() {
          for (let offset = 0; offset === 0 || offset < content.length; offset += chunkBytes) {
            yield* send(
              `writing ${path} at byte ${offset}`,
              HttpClientRequest.put(`${sessionUrl(info.remoteId)}/files`).pipe(
                files(path, offset === 0 ? undefined : offset),
                HttpClientRequest.bodyUint8Array(
                  content.subarray(offset, offset + chunkBytes),
                  "application/octet-stream"
                )
              ),
              () => Effect.void
            )
          }
        }),
      ping: Effect.flatMap(exec("true"), (result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(failed("unavailable", `${info.remoteId} did not answer`, result)))
    }
  }

  return {
    acquire: (key) =>
      Effect.gen(function*() {
        const info = yield* Effect.acquireRelease(
          send(
            `acquiring ${key}`,
            HttpClientRequest.post(`${base}/v1/sessions`).pipe(
              HttpClientRequest.bodyText(encodeAcquire({ key, limits }), "application/json")
            ),
            (response) =>
              Effect.flatMap(
                bodyOf(response),
                (text) => Effect.mapError(decodeInfo(text), malformed(`acquiring ${key}`))
              )
          ),
          (held) => finalizeWithin(Effect.ignore(destroy(held), { log: "Warn" }), `http sandbox ${held.remoteId}`)
        )
        const token = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36) +
          (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36)
        return open(info, token)
      })
  }
}
