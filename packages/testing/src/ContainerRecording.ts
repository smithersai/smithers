/**
 * Record, replay or pass through every call a Durable Object makes on its
 * Cloudflare Container.
 *
 * A test of a container object (start, exec, checkpoint, destroy, a box that
 * stops) runs in one of three modes, chosen by the suite and never by this
 * module:
 *
 * - `passthrough`: the live container, unchanged. Nothing is recorded.
 * - `record`: the live container, and every call, its input and its answer
 *   is handed to `onCall` and kept in `calls()`. A command's output is read
 *   as it streams and recorded when the command's scope closes.
 * - `replay`: answers only from the recording, in recorded order. A call the
 *   recording does not hold next is a defect, never a call to a container.
 *
 * The container is structural: Alchemy's Durable Object container handle, a
 * Worker's raw `ctx.container` behind an Effect client, or a test's own. The
 * module needs no file system, so a deployed Worker can record, and a
 * workerd test host can replay, the same calls. {@link encode} scrubs a
 * recording before it is written, as `HttpRecording` does.
 *
 * Governing design: `packages/testing/docs/guides/record-a-container.md`.
 *
 * @since 1.0.0
 */

import { placeholder, redact } from "@smthrs/journal/Redaction"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { scan } from "./internal/credentials.ts"

/**
 * How a recorded container is reached.
 *
 * @category models
 * @since 1.0.0
 */
export const Mode = Schema.Literals(["passthrough", "record", "replay"])

/**
 * The decoded form of {@link Mode}.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = typeof Mode.Type

/**
 * The container operations a recording holds.
 *
 * @category models
 * @since 1.0.0
 */
export const Operation = Schema.Literals([
  "running",
  "start",
  "setInactivityTimeout",
  "interceptOutboundHttp",
  "interceptAllOutboundHttp",
  "interceptOutboundHttps",
  "snapshotContainer",
  "destroy",
  "exec"
])

/**
 * The decoded form of {@link Operation}.
 *
 * @category models
 * @since 1.0.0
 */
export type Operation = typeof Operation.Type

/**
 * What a command answered: its output as text and its exit code, or the tag
 * of the error its exit failed with.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecAnswer {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode?: number | undefined
  readonly exitFailure?: string | undefined
}

/**
 * One call and its answer. `input` is the call's arguments as recorded (an
 * intercept's fetcher binding is not data and is never recorded; an exec's
 * stdin bytes are not recorded). `failure` is the tag of the error the call
 * failed with; then there is no `output`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Call {
  readonly operation: Operation
  readonly input: unknown
  readonly output?: unknown
  readonly failure?: string | undefined
}

/**
 * A recording: every call of one run, in the order the calls began.
 *
 * @category models
 * @since 1.0.0
 */
export interface Recording {
  readonly label?: string | undefined
  readonly calls: ReadonlyArray<Call>
}

/**
 * The schema a recording file decodes with.
 *
 * @category models
 * @since 1.0.0
 */
export const RecordingSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  calls: Schema.Array(Schema.Struct({
    operation: Operation,
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    failure: Schema.optional(Schema.String)
  }))
})

/**
 * The options of one command, as a container's exec takes them.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecOptions {
  readonly user?: string
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: "pipe"
  readonly stdout?: "pipe" | "ignore"
  readonly stderr?: "pipe" | "ignore"
}

/**
 * A command running in the container.
 *
 * @category models
 * @since 1.0.0
 */
export interface Process<E = unknown, R = never> {
  readonly stdin: Sink.Sink<any, Uint8Array, any, E, R> | undefined
  readonly stdout: Stream.Stream<Uint8Array, E, R> | undefined
  readonly stderr: Stream.Stream<Uint8Array, E, R> | undefined
  readonly exitCode: Effect.Effect<number, E, R>
}

/**
 * The container surface this module records: the slice of Alchemy's
 * Durable Object container handle a container object uses.
 *
 * @category models
 * @since 1.0.0
 */
export interface Container<E = unknown, R = never> {
  readonly running: Effect.Effect<boolean, E, R>
  start(options?: object): Effect.Effect<void, E, R>
  setInactivityTimeout(durationMs: number): Effect.Effect<void, E, R>
  interceptOutboundHttp(addr: string, binding: never): Effect.Effect<void, E, R>
  interceptAllOutboundHttp(binding: never): Effect.Effect<void, E, R>
  interceptOutboundHttps(addr: string, binding: never): Effect.Effect<void, E, R>
  snapshotContainer(options?: object): Effect.Effect<unknown, E, R>
  destroy(error?: unknown): Effect.Effect<void, E, R>
  exec(argv: Array<string>, options: ExecOptions): Effect.Effect<Process<E, R>, E, R | Scope.Scope>
}

/**
 * Rewrites what changes from run to run out of a call's input (a timeout
 * computed from the clock, a generated name) before it is recorded and
 * before a replayed call is compared. The live container still receives the
 * original.
 *
 * @category models
 * @since 1.0.0
 */
export type Normalize = (operation: Operation, input: unknown) => unknown

/**
 * A replayed call that is not the recording's next call, or comes after the
 * last one. Names the call's index and operations, never an input.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnrecordedCallError extends Schema.TaggedError<UnrecordedCallError>()(
  "UnrecordedCallError",
  { index: Schema.Number, operation: Schema.String, recorded: Schema.String }
) {
  override get message(): string {
    return this.recorded === "none"
      ? `No recorded container call left for ${this.operation} (call ${this.index}). Record the test again.`
      : `Container call ${this.index} was ${this.operation} with other input than recorded (${this.recorded}). Record the test again.`
  }
}

/**
 * A recording that still holds a credential after scrubbing. Names the rule,
 * never the value.
 *
 * @category errors
 * @since 1.0.0
 */
export class CredentialInRecordingError extends Schema.TaggedError<CredentialInRecordingError>()(
  "CredentialInRecordingError",
  { rules: Schema.Array(Schema.String) }
) {
  override get message(): string {
    return `Refusing to encode a container recording: it holds a value shaped like a credential (${
      this.rules.join(", ")
    }).`
  }
}

/**
 * The error a replayed call fails with: its `_tag` is the tag the live call
 * failed with, so code that reads a failure's tag sees what it saw live.
 *
 * @category errors
 * @since 1.0.0
 */
export class ReplayedFailure extends Error {
  readonly _tag: string
  readonly operation: Operation
  constructor(tag: string, operation: Operation) {
    super(`replayed container ${operation} failure (${tag})`)
    this._tag = tag
    this.operation = operation
  }
}

/** The failure's tag, or its name; never its message. */
const tagOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const tagged = error as { readonly _tag?: unknown; readonly name?: unknown }
    if (typeof tagged._tag === "string") return tagged._tag
    if (typeof tagged.name === "string") return tagged.name
  }
  return "unknown"
}

/** JSON with sorted object keys: two equal inputs give equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item)

/** The input as data: the JSON round trip of what the call was given. */
const data = (value: unknown): unknown => value === undefined ? null : JSON.parse(canonical(value)) as unknown

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const text = (chunks: ReadonlyArray<Uint8Array>): string => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decoder.decode(bytes)
}

/** The exec input as recorded: the argument vector and the options, never stdin's bytes. */
const execInput = (argv: Array<string>, options: ExecOptions): unknown => ({ argv, options })

/** The destroy input as recorded: the tag of the error it was given, never the error itself. */
const destroyInput = (error: unknown): unknown => error === undefined ? null : { error: tagOf(error) }

/**
 * Options for {@link record}.
 *
 * @category models
 * @since 1.0.0
 */
export interface RecordOptions {
  readonly normalize?: Normalize | undefined
  /**
   * Each call as it completes, with its index in the order calls began. A
   * Durable Object stores them here, because an evicted object loses
   * `calls()`.
   */
  readonly onCall?: ((call: Call, index: number) => Effect.Effect<void>) | undefined
}

/**
 * The live container, with every call recorded. `calls()` answers the calls
 * so far in the order they began; a command's call is complete once its
 * scope closes. Every member it does not record (`monitor`, `signal`, a
 * method Alchemy's handle sends to the container's own server) is the live
 * handle's, unchanged.
 *
 * @throws {never}
 * @category constructors
 * @since 1.0.0
 */
export const record = <C extends Container<any, any>>(
  live: C,
  options: RecordOptions = {}
): { readonly container: C; readonly calls: () => ReadonlyArray<Call> } => {
  const slots: Array<Call | undefined> = []
  const normalize = options.normalize ?? ((_operation: Operation, input: unknown) => input)
  const settle = (index: number, call: Call): Effect.Effect<void> =>
    Effect.suspend(() => {
      slots[index] = call
      return options.onCall === undefined ? Effect.void : options.onCall(call, index)
    })
  const recorded = <A, E, R>(
    operation: Operation,
    input: unknown,
    effect: Effect.Effect<A, E, R>,
    output: (value: A) => unknown = data
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const index = slots.push(undefined) - 1
      const keyed = data(normalize(operation, data(input)))
      return effect.pipe(
        Effect.tap((value) => settle(index, { operation, input: keyed, output: output(value) })),
        Effect.tapError((error) => settle(index, { operation, input: keyed, failure: tagOf(error) }))
      )
    })
  const exec = (argv: Array<string>, execOptions: ExecOptions) =>
    Effect.suspend(() => {
      const index = slots.push(undefined) - 1
      const input = data(normalize("exec", execInput(argv, execOptions)))
      const stdout: Array<Uint8Array> = []
      const stderr: Array<Uint8Array> = []
      const answer: { exitCode?: number; exitFailure?: string } = {}
      return Effect.flatMap(
        Effect.tapError(
          live.exec(argv, execOptions),
          (error) => settle(index, { operation: "exec", input, failure: tagOf(error) })
        ),
        (process: Process<unknown, unknown>) =>
          Effect.as(
            Effect.addFinalizer(() =>
              settle(index, {
                operation: "exec",
                input,
                output: { stdout: text(stdout), stderr: text(stderr), ...answer } satisfies ExecAnswer
              })
            ),
            {
              // The live process's other members (kill, resize, pid) pass through unchanged.
              ...process,
              stdout: process.stdout === undefined
                ? undefined
                : Stream.tap(process.stdout, (chunk) => Effect.sync(() => stdout.push(chunk.slice()))),
              stderr: process.stderr === undefined
                ? undefined
                : Stream.tap(process.stderr, (chunk) => Effect.sync(() => stderr.push(chunk.slice()))),
              exitCode: process.exitCode.pipe(
                Effect.tap((code) => Effect.sync(() => (answer.exitCode = code))),
                Effect.tapError((error) => Effect.sync(() => (answer.exitFailure = tagOf(error))))
              )
            }
          )
      )
    })
  const own: Record<PropertyKey, unknown> = {
    running: recorded("running", null, live.running),
    start: (startOptions?: object) => recorded("start", startOptions ?? null, live.start(startOptions)),
    setInactivityTimeout: (durationMs: number) =>
      recorded("setInactivityTimeout", durationMs, live.setInactivityTimeout(durationMs)),
    interceptOutboundHttp: (addr: string, binding: never) =>
      recorded("interceptOutboundHttp", { addr }, live.interceptOutboundHttp(addr, binding)),
    interceptAllOutboundHttp: (binding: never) =>
      recorded("interceptAllOutboundHttp", null, live.interceptAllOutboundHttp(binding)),
    interceptOutboundHttps: (addr: string, binding: never) =>
      recorded("interceptOutboundHttps", { addr }, live.interceptOutboundHttps(addr, binding)),
    snapshotContainer: (snapshotOptions?: object) =>
      recorded("snapshotContainer", snapshotOptions ?? null, live.snapshotContainer(snapshotOptions)),
    destroy: (error?: unknown) => recorded("destroy", destroyInput(error), live.destroy(error)),
    exec
  }
  // A Proxy, not a spread: a spread drops what the live handle answers by dispatch rather than as an own member. A
  // spread of this Proxy (`{ ...box, start }`) reads each member through `get`, so it still records.
  const container = new Proxy(live, {
    get: (target, prop) => Object.hasOwn(own, prop) ? own[prop] : Reflect.get(target, prop)
  })
  return { container, calls: () => slots.filter((call): call is Call => call !== undefined) }
}

/**
 * Options for {@link replay}.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReplayOptions {
  readonly normalize?: Normalize | undefined
  /**
   * Operations a timer may call more or fewer times than the recorded run
   * did, such as a Durable Object alarm that polls `running` and re-arms
   * `setInactivityTimeout` while a slow live call is in flight. A polled
   * call claims the next recorded call of its operation and input when only
   * polled calls come before it, and those skipped calls are passed. When
   * the recording holds no such call before its next unpolled call, it is
   * answered by a recorded one with the same operation and input since the
   * last unpolled call claimed, so no answer crosses a start, a command or a
   * destroy. Unpolled calls still claim every recorded unpolled call in
   * order.
   */
  readonly polled?: ReadonlyArray<Operation> | undefined
}

/**
 * A container that answers from `recording` and reaches none. Each call
 * claims the recording's next call, which must have the same operation and
 * the same normalized input; anything else dies with
 * {@link UnrecordedCallError}. `remaining` counts the calls nothing claimed,
 * apart from `polled` calls (see {@link ReplayOptions}).
 *
 * @throws {never}
 * @category constructors
 * @since 1.0.0
 */
export const replay = <C extends Container<any, any>>(
  recording: Recording,
  options: ReplayOptions = {}
): { readonly container: C; readonly remaining: () => number } => {
  let next = 0
  // The index after the last unpolled call claimed: a polled call the recording lacks is answered from here on.
  let since = 0
  const normalize = options.normalize ?? ((_operation: Operation, input: unknown) => input)
  const polled = new Set<Operation>(options.polled ?? [])
  const matches = (call: Call, operation: Operation, key: string) =>
    call.operation === operation && canonical(call.input) === key
  const claim = (operation: Operation, input: unknown): Effect.Effect<Call> =>
    Effect.suspend(() => {
      const key = canonical(normalize(operation, data(input)))
      // Recorded polled calls before the next unpolled one may be passed over.
      let stop = next
      while (stop < recording.calls.length) {
        const call = recording.calls[stop]!
        if (matches(call, operation, key)) {
          next = stop + 1
          if (!polled.has(operation)) since = next
          return Effect.succeed(call)
        }
        if (!polled.has(call.operation)) break
        stop += 1
      }
      if (polled.has(operation)) {
        for (let at = Math.min(stop, recording.calls.length) - 1; at >= since; at -= 1) {
          if (matches(recording.calls[at]!, operation, key)) return Effect.succeed(recording.calls[at]!)
        }
      }
      const index = polled.size === 0 ? next : polled.has(operation) ? next : stop
      const call = recording.calls[index]
      return Effect.die(new UnrecordedCallError({ index, operation, recorded: call?.operation ?? "none" }))
    })
  const answered = <A>(operation: Operation, input: unknown, read: (output: unknown) => A) =>
    Effect.flatMap(
      claim(operation, input),
      (call) =>
        call.failure === undefined
          ? Effect.succeed(read(call.output))
          : Effect.fail(new ReplayedFailure(call.failure, operation))
    )
  const none = () => undefined
  const exec = (argv: Array<string>, execOptions: ExecOptions) =>
    Effect.flatMap(
      answered("exec", execInput(argv, execOptions), (output) => output as ExecAnswer),
      (answer) =>
        Effect.succeed({
          stdin: execOptions.stdin === "pipe" ? Sink.drain : undefined,
          stdout: execOptions.stdout === "pipe" ? Stream.make(encoder.encode(answer.stdout)) : undefined,
          stderr: execOptions.stderr === "pipe" ? Stream.make(encoder.encode(answer.stderr)) : undefined,
          // A recorded command whose exit nobody read has no exit code to give.
          exitCode: answer.exitFailure !== undefined
            ? Effect.fail(new ReplayedFailure(answer.exitFailure, "exec"))
            : answer.exitCode === undefined
            ? Effect.die(new UnrecordedCallError({ index: next - 1, operation: "exit", recorded: "none" }))
            : Effect.succeed(answer.exitCode)
        })
    )
  const container = {
    running: Effect.suspend(() => answered("running", null, (output) => output === true)),
    start: (startOptions?: object) => answered("start", startOptions ?? null, none),
    setInactivityTimeout: (durationMs: number) => answered("setInactivityTimeout", durationMs, none),
    interceptOutboundHttp: (addr: string) => answered("interceptOutboundHttp", { addr }, none),
    interceptAllOutboundHttp: () => answered("interceptAllOutboundHttp", null, none),
    interceptOutboundHttps: (addr: string) => answered("interceptOutboundHttps", { addr }, none),
    snapshotContainer: (snapshotOptions?: object) =>
      answered("snapshotContainer", snapshotOptions ?? null, (output) => output),
    destroy: (error?: unknown) => answered("destroy", destroyInput(error), none),
    exec
  } as unknown as C
  return {
    container,
    remaining: () => recording.calls.slice(next).filter((call) => !polled.has(call.operation)).length
  }
}

/**
 * What {@link make} is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options<C> extends RecordOptions {
  readonly mode: Mode
  /** The real container. Required for `passthrough` and `record`; `replay` never touches it. */
  readonly live?: C | undefined
  /** The recording `replay` answers from. */
  readonly recording?: Recording | undefined
}

/**
 * The container for `mode`: `live` itself, `live` recorded, or a replay of
 * `recording`. A mode without what it needs is a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = <C extends Container<any, any>>(options: Options<C>): C => {
  if (options.mode === "replay") {
    if (options.recording === undefined) throw new Error("ContainerRecording replay needs a recording")
    return replay<C>(options.recording, options).container
  }
  if (options.live === undefined) throw new Error(`ContainerRecording ${options.mode} needs the live container`)
  return options.mode === "record" ? record(options.live, options).container : options.live
}

const replaceSecrets = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (secrets.length === 0) return value
  if (typeof value === "string") return secrets.reduce((item, secret) => item.split(secret).join(placeholder), value)
  if (Array.isArray(value)) return value.map((item) => replaceSecrets(item, secrets))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceSecrets(item, secrets)]))
  }
  return value
}

/**
 * The recording as the text of its file, one call per line, scrubbed: each
 * named secret is replaced wherever it appears, and every input and output
 * goes through `@smthrs/journal/Redaction`'s `redact`. A text that still
 * matches a credential shape, or still holds a named secret, fails
 * {@link CredentialInRecordingError} and nothing is encoded.
 *
 * @throws {never}
 * @category scrubbing
 * @since 1.0.0
 */
export const encode = (
  recording: Recording,
  secrets: ReadonlyArray<string | Redacted.Redacted<string>> = []
): Effect.Effect<string, CredentialInRecordingError> => {
  const values = secrets.map((secret) => typeof secret === "string" ? secret : Redacted.value(secret))
    .filter((secret) => secret.length >= 8)
  const calls = recording.calls.map((call) => redact(replaceSecrets(call, values)))
  const head = recording.label === undefined ? "" : `"label":${JSON.stringify(recording.label)},`
  const body = `{${head}"calls":[\n${calls.map((call) => JSON.stringify(call)).join(",\n")}\n]}\n`
  const rules = [...scan(body), ...(values.some((secret) => body.includes(secret)) ? ["live-secret"] : [])]
  return rules.length === 0 ? Effect.succeed(body) : Effect.fail(new CredentialInRecordingError({ rules }))
}

/**
 * Decodes a recording's text. Malformed text is a defect: a replayed test
 * without its recording is a broken setup.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = (text: string): Recording =>
  Schema.decodeUnknownSync(RecordingSchema)(JSON.parse(text) as unknown)
