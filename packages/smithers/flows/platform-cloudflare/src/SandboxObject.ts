/**
 * The container Durable Object, as a function the object delegates to before
 * it uses its container.
 *
 * {@link wake} starts the container when it is not running, with internet
 * access off, on the instance type it names, re-arms its inactivity timeout,
 * and registers the outbound HTTP intercepts that are the box's only way
 * out. It is idempotent: an object calls it before each use of the
 * container, and a container already running costs a timeout and the
 * intercepts, re-registered.
 *
 * {@link rearm} re-arms the timeout of a container that runs, and starts
 * nothing. A Durable Object that restarts, after a deploy for one, starts
 * with no timeout, and Cloudflare then stops its container shortly after the
 * object goes idle; an object calls it once per incarnation and on each use
 * that doesn't wake the container.
 *
 * {@link run} runs a command in the container for its exit code alone, and
 * never pipes its output: workerd's exec pipes hold no bytes, so a command
 * whose output nobody reads blocks on its first write and its exit code
 * never comes.
 *
 * The function takes the container as a structural slice of an Effect
 * container client, so an Alchemy Durable Object's container handle passes in
 * as is (`R` is its `RuntimeContext`, `F` its `Fetcher`), and a test passes an
 * in-memory one. It keeps no state and runs no timer or retry of its own; the
 * container client's `start` coordinates concurrent starts.
 *
 * @since 1.0.0-rc.17
 */

import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as ContainerTerminal from "./ContainerTerminal.ts"
import * as Observed from "./internal/Observed.ts"

/**
 * The slice of an Effect container client {@link wake} uses.
 *
 * `F` is the container client's fetcher type: Alchemy's `Fetcher`, or a
 * Worker's own `Fetcher` for a raw `ctx.container`. An Alchemy Durable
 * Object's container handle satisfies it with `E` its start and container
 * errors and `R = RuntimeContext`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Machine<F, E = never, R = never> {
  readonly running: Effect.Effect<boolean, E, R>
  start(options: { readonly enableInternet: false; readonly instance?: Instance }): Effect.Effect<void, E, R>
  setInactivityTimeout(durationMs: number): Effect.Effect<void, E, R>
  interceptOutboundHttp(addr: string, binding: F): Effect.Effect<void, E, R>
  interceptAllOutboundHttp(binding: F): Effect.Effect<void, E, R>
  interceptOutboundHttps(addr: string, binding: F): Effect.Effect<void, E, R>
}

/**
 * One outbound HTTP intercept: requests from the box to `host` (a host name,
 * or `host:port`) go to `fetcher`, outside the box, which can add a
 * credential the box never holds.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Intercept<F> {
  readonly host: string
  readonly fetcher: F
}

/**
 * A container's instance type, as `start` takes it: a named type, or custom
 * resources (`memoryMib` in mebibytes, `diskMb` in megabytes). Cloudflare
 * starts a container with none on `lite`: 1/16 vCPU, 256 MiB of memory and
 * 2 GB of disk.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Instance =
  | "lite"
  | "basic"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { readonly vcpu: number; readonly memoryMib: number; readonly diskMb: number }

/**
 * Options for {@link wake}.
 *
 * - `intercepts`: every outbound HTTP intercept the box gets, registered on
 *   every wake.
 * - `instance`: the instance type a stopped container starts on; Cloudflare's
 *   default, `lite`, when absent.
 * - `startTimeoutMs`: the longest a stopped container's start may take before
 *   {@link wake} fails {@link StartTimedOut}; unbounded when absent.
 * - `inactivityTimeoutMs`: how long the container runs with no activity on
 *   its Durable Object before Cloudflare stops it. Defaults to
 *   {@link defaultInactivityTimeoutMs}.
 * - `egress`: where every other outbound request goes, HTTP and HTTPS
 *   alike: an egress that decides each one outside the box, such as
 *   `@smthrs/secrets`' `Egress.forward`. Without it, the box reaches only
 *   its intercepted hosts. HTTPS reaches it decrypted through the
 *   container's per-instance CA, which the box must trust.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface WakeOptions<F> {
  readonly intercepts: ReadonlyArray<Intercept<F>>
  readonly instance?: Instance | undefined
  readonly startTimeoutMs?: number | undefined
  readonly inactivityTimeoutMs?: number | undefined
  readonly egress?: F | undefined
}

/**
 * What {@link wake} found: it `started` the container, or the container was
 * `running` already.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type WakeOutcome = "started" | "running"

/**
 * The inactivity timeout {@link wake} arms unless told another: 30 minutes.
 * It is the backstop that stops an idle container whose sleep never ran.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const defaultInactivityTimeoutMs = 30 * 60 * 1000

/**
 * {@link wake} calls, by `outcome`: `started`, `running` or `failed`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const wakes = Metric.counter("smithers_cloudflare_sandbox_wakes", {
  description: "Container Durable Object wakes, by outcome",
  incremental: true
})

/**
 * A stopped container didn't finish starting within {@link WakeOptions}'
 * `startTimeoutMs`. The start was abandoned; a later wake starts it again.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class StartTimedOut extends Schema.TaggedError<StartTimedOut>()(
  "@smthrs/platform-cloudflare/StartTimedOut",
  { timeoutMs: Schema.Number }
) {}

/**
 * Container starts that ran past their `startTimeoutMs` ({@link StartTimedOut}).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const startTimeouts = Metric.counter("smithers_cloudflare_sandbox_start_timeouts", {
  description: "Container Durable Object starts that ran past their start timeout",
  incremental: true
})

/**
 * {@link rearm} calls, by `outcome`: `rearmed`, `stopped` or `failed`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const rearms = Metric.counter("smithers_cloudflare_sandbox_rearms", {
  description: "Container Durable Object inactivity timeouts re-armed, by outcome",
  incremental: true
})

/**
 * Makes the container ready to use.
 *
 * 1. Starts it when it is not running, with `enableInternet: false` and
 *    `instance` when given: the box reaches nothing but the intercepted
 *    hosts. A start that runs past `startTimeoutMs` fails
 *    {@link StartTimedOut} and counts in {@link startTimeouts}.
 * 2. Arms its inactivity timeout, `inactivityTimeoutMs`. A restarted Durable
 *    Object loses the timeout, so every wake sets it again.
 * 3. Registers each intercept, in order, then, with `egress`, every other
 *    HTTP request (`interceptAllOutboundHttp`) and every HTTPS request
 *    (`interceptOutboundHttps("*")`). Intercepts must be registered again
 *    after each start; registering them on every wake also repairs an object
 *    that died between its start and its registration, which would otherwise
 *    leave a running box with no way out.
 *
 * It answers `started` or `running`. A failed start, timeout or
 * registration fails with the container client's own error, unchanged; the
 * span and the log line carry only its tag.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const wake = <F, E, R>(
  machine: Machine<F, E, R>,
  options: WakeOptions<F>
): Effect.Effect<WakeOutcome, E | StartTimedOut, R> =>
  Effect.gen(function*() {
    const running = yield* machine.running
    if (!running) {
      const start = machine.start(
        options.instance === undefined
          ? { enableInternet: false }
          : { enableInternet: false, instance: options.instance }
      )
      const timeoutMs = options.startTimeoutMs
      yield* timeoutMs === undefined ? start : start.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.andThen(Metric.update(startTimeouts, 1), Effect.fail(new StartTimedOut({ timeoutMs })))
        })
      )
    }
    yield* machine.setInactivityTimeout(options.inactivityTimeoutMs ?? defaultInactivityTimeoutMs)
    for (const intercept of options.intercepts) {
      yield* machine.interceptOutboundHttp(intercept.host, intercept.fetcher)
    }
    if (options.egress !== undefined) {
      yield* machine.interceptAllOutboundHttp(options.egress)
      yield* machine.interceptOutboundHttps("*", options.egress)
    }
    return running ? "running" as const : "started" as const
  }).pipe((effect) =>
    Observed.observed(effect, {
      span: "sandbox.wake",
      attributes: {
        "smithers.sandbox.intercepts": options.intercepts.length,
        "smithers.sandbox.egress": options.egress !== undefined
      },
      attribute: "smithers.sandbox.wake",
      counter: wakes,
      log: "cloudflare.sandbox.wake"
    })
  )

/**
 * Re-arms the inactivity timeout of a container that runs, to
 * `inactivityTimeoutMs` ({@link defaultInactivityTimeoutMs} unless given),
 * and starts nothing. It answers `rearmed`, or `stopped` when the container
 * isn't running. A failed read or timeout fails with the container client's
 * own error, unchanged; the span and the log line carry only its tag.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const rearm = <F, E, R>(
  machine: Pick<Machine<F, E, R>, "running" | "setInactivityTimeout">,
  inactivityTimeoutMs: number = defaultInactivityTimeoutMs
): Effect.Effect<"rearmed" | "stopped", E, R> =>
  Effect.gen(function*() {
    if (!(yield* machine.running)) return "stopped" as const
    yield* machine.setInactivityTimeout(inactivityTimeoutMs)
    return "rearmed" as const
  }).pipe((effect) =>
    Observed.observed(effect, {
      span: "sandbox.rearm",
      attributes: { "smithers.sandbox.inactivity_timeout_ms": inactivityTimeoutMs },
      attribute: "smithers.sandbox.rearm",
      counter: rearms,
      log: "cloudflare.sandbox.rearm"
    })
  )

/**
 * Options for {@link run}: the `uid:gid` the command runs as (the image's
 * user when absent) and the variables it gets beyond the image's `PATH`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RunOptions {
  readonly user?: string | undefined
  readonly env?: Record<string, string> | undefined
}

/**
 * Runs `argv` in the running container to completion and answers its exit
 * code; a nonzero one is an answer, not a failure. Its standard output and
 * error are `ignore`d, never piped: workerd's exec pipes hold no bytes, so a
 * pipe nobody reads blocks the command on its first write, and its exit code
 * never comes. A command whose output matters runs through
 * `ContainerSession` instead. The process belongs to this call: it is killed
 * if the call is interrupted. A failed `exec` or wait fails with the
 * container client's own error.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const run = <E, R>(
  container: ContainerTerminal.Container<E, R>,
  argv: Array<string>,
  options: RunOptions = {}
): Effect.Effect<number, E, R> =>
  Effect.scoped(
    Effect.flatMap(
      container.exec(argv, {
        ...(options.user === undefined ? {} : { user: options.user }),
        ...(options.env === undefined ? {} : { env: options.env }),
        stdout: "ignore",
        stderr: "ignore"
      }),
      (process) => process.exitCode
    )
  )

/**
 * The default maximum stderr bytes {@link runWithStderr} retains in memory
 * while draining a process's stderr stream to completion (8 KiB).
 *
 * @category constants
 * @since 1.0.0-rc.23
 */
export const defaultMaxStderrBytes = 8192

/**
 * A running process whose exit code and optional stderr stream
 * {@link runWithStderr} consumes concurrently.
 *
 * @category models
 * @since 1.0.0-rc.23
 */
export interface StderrProcess<E = never, R = never> {
  readonly stderr: Stream.Stream<Uint8Array, E, R> | undefined
  readonly exitCode: Effect.Effect<number, E, R>
}

/**
 * The slice of an Effect container client {@link runWithStderr} uses.
 *
 * @category models
 * @since 1.0.0-rc.23
 */
export interface StderrContainer<E = never, R = never> {
  exec(
    cmd: Array<string>,
    options: {
      readonly user?: string
      readonly env?: Record<string, string>
      readonly stdout: "ignore"
      readonly stderr: "pipe"
    }
  ): Effect.Effect<StderrProcess<E, R>, E, R | Scope.Scope>
}

/**
 * Options for {@link runWithStderr}: {@link RunOptions} plus `maxStderrBytes`,
 * the maximum stderr bytes kept in memory while draining the stream.
 *
 * @category models
 * @since 1.0.0-rc.23
 */
export interface RunWithStderrOptions extends RunOptions {
  readonly maxStderrBytes?: number | undefined
}

/**
 * What {@link runWithStderr} returns: the command's exit code, a bounded UTF-8
 * slice of its stderr (head and tail when truncated), and whether stderr
 * exceeded `maxStderrBytes` or ended early on a stream error.
 *
 * @category models
 * @since 1.0.0-rc.23
 */
export interface RunWithStderrResult {
  readonly exitCode: number
  readonly stderr: string
  readonly truncated: boolean
}

const makeStderrCollector = (maxBytes: number) => {
  const headCap = Math.floor(maxBytes / 2)
  const tailCap = maxBytes - headCap
  let buf = new Uint8Array(0)
  let used = 0
  let truncated = false
  let head = new Uint8Array(0)
  let tail = new Uint8Array(0)
  let tailPos = 0
  let tailLen = 0

  const pushTail = (bytes: Uint8Array) => {
    if (tailCap === 0 || bytes.length === 0) return
    if (bytes.length >= tailCap) {
      tail.set(bytes.subarray(bytes.length - tailCap), 0)
      tailPos = 0
      tailLen = tailCap
      return
    }
    const first = Math.min(bytes.length, tailCap - tailPos)
    tail.set(bytes.subarray(0, first), tailPos)
    if (first < bytes.length) tail.set(bytes.subarray(first), 0)
    tailPos = (tailPos + bytes.length) % tailCap
    tailLen = Math.min(tailCap, tailLen + bytes.length)
  }

  const push = (chunk: Uint8Array) => {
    if (chunk.length === 0) return
    if (maxBytes === 0) {
      truncated = true
      return
    }
    if (!truncated) {
      if (used + chunk.length <= maxBytes) {
        const end = used + chunk.length
        if (end > buf.length) {
          const grown = new Uint8Array(Math.min(maxBytes, Math.max(end, buf.length * 2, 256)))
          grown.set(buf.subarray(0, used))
          buf = grown
        }
        buf.set(chunk, used)
        used = end
        return
      }
      truncated = true
      head = new Uint8Array(headCap)
      const fromBuf = Math.min(used, headCap)
      if (fromBuf > 0) head.set(buf.subarray(0, fromBuf), 0)
      const fromChunk = Math.min(chunk.length, headCap - fromBuf)
      if (fromChunk > 0) head.set(chunk.subarray(0, fromChunk), fromBuf)
      tail = new Uint8Array(tailCap)
      if (used > headCap) pushTail(buf.subarray(headCap, used))
      pushTail(chunk.subarray(fromChunk))
      buf = new Uint8Array(0)
      used = 0
      return
    }
    pushTail(chunk)
  }

  const read = (streamFailed = false): { readonly stderr: string; readonly truncated: boolean } => {
    const decoder = new TextDecoder()
    if (!truncated) {
      return {
        stderr: used === 0 ? "" : decoder.decode(buf.subarray(0, used)),
        truncated: streamFailed
      }
    }
    const headText = headCap > 0 ? decoder.decode(head) : ""
    let tailText = ""
    if (tailLen > 0) {
      if (tailLen < tailCap) {
        tailText = decoder.decode(tail.subarray(0, tailLen))
      } else {
        const ordered = new Uint8Array(tailCap)
        ordered.set(tail.subarray(tailPos), 0)
        ordered.set(tail.subarray(0, tailPos), tailCap - tailPos)
        tailText = decoder.decode(ordered)
      }
    }
    return {
      stderr: headText === "" ? tailText : tailText === "" ? headText : `${headText}\n${tailText}`,
      truncated: true
    }
  }

  return { push, read }
}

/**
 * Runs `argv` in the running container, ignoring stdout and draining stderr
 * concurrently with `exitCode` so workerd's unbuffered exec pipes never block.
 * Retains at most `maxStderrBytes` (head and tail when truncated) in memory
 * and never logs or records stderr. Callers must classify or discard it before
 * logging or persisting diagnostics.
 *
 * @category operations
 * @since 1.0.0-rc.23
 */
export const runWithStderr = <E, R>(
  container: StderrContainer<E, R>,
  argv: Array<string>,
  options: RunWithStderrOptions = {}
): Effect.Effect<RunWithStderrResult, E, R> =>
  Effect.suspend(() => {
    const maxBytes = options.maxStderrBytes ?? defaultMaxStderrBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
      return Effect.die(new TypeError("sandbox object: invalid maxStderrBytes"))
    }
    return Effect.scoped(
      Effect.flatMap(
        container.exec(argv, {
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.env === undefined ? {} : { env: options.env }),
          stdout: "ignore",
          stderr: "pipe"
        }),
        (process) => {
          const collector = makeStderrCollector(maxBytes)
          const drained = process.stderr === undefined
            ? Effect.succeed({ stderr: "", truncated: false })
            : Stream.runForEach(process.stderr, (chunk) => Effect.sync(() => collector.push(chunk))).pipe(
              Effect.map(() => collector.read(false)),
              Effect.catch(() => Effect.succeed(collector.read(true)))
            )
          return Effect.all([drained, process.exitCode], { concurrency: "unbounded" }).pipe(
            Effect.map(([captured, exitCode]): RunWithStderrResult => ({
              exitCode,
              stderr: captured.stderr,
              truncated: captured.truncated
            }))
          )
        }
      )
    )
  })
