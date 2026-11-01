/**
 * A browser terminal attached to a tmux session in a Durable Object's
 * container: one tmux session per terminal, and one tmux client per viewer's
 * WebSocket, speaking `@smthrs/sandbox`'s `TerminalProtocol`.
 *
 * - {@link ensureSession} creates the session, named by the terminal's id,
 *   unless it already runs. The shell in it outlives every socket: a reload
 *   attaches to the same shell, and tmux redraws its screen.
 * - {@link attach} bridges one accepted server WebSocket to a new tmux client
 *   on a pseudo-terminal, until the session ends or the viewer goes away. A
 *   `write` viewer types and resizes; every byte and resize from a `read`
 *   viewer is dropped, its terminal's automatic replies included, and its
 *   client neither types nor sizes the window.
 *
 * Both take the container as a structural slice of an Effect container
 * client, so an Alchemy Durable Object's container handle passes in as is
 * (`R` is its `RuntimeContext`), and a test passes an in-memory one.
 *
 * Both run as a user given as numeric `uid:gid`. A deployed container's
 * `exec` refuses a user name, and runs a bare `uid` as root; local Docker
 * accepts both, so a name would pass in development and fail in
 * production. A command started with `exec` inherits only `PATH` from the
 * image, so `env` carries what the shell needs, such as `HOME` and `LANG`.
 *
 * Bytes never reach telemetry. Spans, log lines and metrics carry the
 * terminal's id (never as a metric attribute), the viewer's access, the
 * outcome, close codes and byte counts.
 *
 * @since 1.0.0-rc.17
 */

import { TerminalProtocol } from "@smthrs/sandbox"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as Observed from "./internal/Observed.vibe"

/**
 * The options of one command run in the container: the slice of a
 * container's exec options these functions set.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ExecOptions {
  readonly user?: string
  readonly env?: Record<string, string>
  readonly pty?: { readonly cols: number; readonly rows: number }
  readonly stdin?: "pipe"
  readonly stdout?: "pipe" | "ignore"
  readonly stderr?: "pipe" | "ignore" | "combined"
}

/**
 * A process running in the container: the slice of an Effect container
 * client's process these functions use.
 *
 * - `stdin`: piped standard input, present when the exec asked for it;
 *   completing the sink closes it.
 * - `stdout`: standard output; on a pseudo-terminal, everything the process
 *   writes to it. It ends when the process exits.
 * - `exitCode`: waits for the process to exit.
 * - `kill`: signals the process.
 * - `resize`: resizes its pseudo-terminal.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Process<E = never, R = never> {
  readonly stdin: Sink.Sink<unknown, Uint8Array, unknown, E, R> | undefined
  readonly stdout: Stream.Stream<Uint8Array, E, R> | undefined
  readonly exitCode: Effect.Effect<number, E, R>
  kill(signal?: number): Effect.Effect<void, E, R>
  resize(cols: number, rows: number): Effect.Effect<void, E, R>
}

/**
 * The slice of an Effect container client these functions use: `exec`, which
 * runs an argument vector without a shell in the running container. The
 * process belongs to the scope that ran `exec`.
 *
 * An Alchemy Durable Object's container handle satisfies it with `E =
 * ContainerError` and `R = RuntimeContext`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Container<E = never, R = never> {
  exec(cmd: Array<string>, options?: ExecOptions): Effect.Effect<Process<E, R>, E, R | Scope.Scope>
}

/**
 * What a socket event carries: its `type` and, for a message, its `data`: a
 * string for a text frame, and an `ArrayBuffer`, a typed array or a `Blob`
 * for a binary one.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface SocketEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * The slice of a server WebSocket {@link attach} uses. The caller has
 * already accepted it with `accept()`, never `acceptWebSocket()`: a
 * hibernated object would drop the tmux client's process. A Worker's
 * `new WebSocketPair()` server side satisfies it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Socket {
  send(message: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message" | "close" | "error", listener: (event: SocketEvent) => void): void
  removeEventListener(type: "message" | "close" | "error", listener: (event: SocketEvent) => void): void
}

/**
 * {@link ensureSession} or {@link attach} was given a value it refuses: a
 * session name that is not a lowercase UUID, a user that is not a numeric
 * `uid:gid` or whose uid is 0 (root), a working directory that is not an
 * absolute path of letters, digits, `.`, `_`, `-` and `/`, or a terminal
 * size outside `TerminalProtocol`'s bounds. Nothing ran.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class InvalidSession extends Schema.TaggedError<InvalidSession>()(
  "@smthrs/platform-cloudflare/InvalidSession",
  {
    field: Schema.Literals(["name", "user", "cwd", "size"]),
    message: Schema.String
  }
) {}

/**
 * `tmux new-session` failed and no session by that name runs afterwards.
 * `exitCode` is `new-session`'s.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class SessionFailed extends Schema.TaggedError<SessionFailed>()(
  "@smthrs/platform-cloudflare/SessionFailed",
  {
    name: Schema.String,
    exitCode: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * What {@link ensureSession} found: it `created` the session, or the session
 * was `existing` already.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type SessionOutcome = "created" | "existing"

/**
 * How one {@link attach} ended.
 *
 * - `ended`: the tmux client exited, because its session ended (killed, or
 *   its shell exited) or it detached. The viewer got `ended {reason:
 *   "closed"}` and close code 1000.
 * - `closed`: the viewer closed the socket, it failed, or a send to it
 *   failed.
 * - `unsupported`: a malformed control frame, a frame that is neither text
 *   nor binary, or invalid attach options; close code 1003.
 * - `too_big`: a frame over `TerminalProtocol.maxFrameBytes`; close code
 *   1009.
 * - `failed`: the container failed: `exec`, stdin, a resize or the output
 *   stream; close code 1011, after which the viewer reconnects.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Outcome = "ended" | "closed" | "unsupported" | "too_big" | "failed"

/**
 * What one {@link attach} did: its {@link Outcome}, the close code it sent
 * (`null` when the viewer closed first), and how many bytes went to the
 * shell (`in`), to the viewer (`out`) and were dropped from a reader
 * (`dropped`).
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Report {
  readonly outcome: Outcome
  readonly closeCode: number | null
  readonly bytes: { readonly in: number; readonly out: number; readonly dropped: number }
}

/**
 * Options for {@link ensureSession}.
 *
 * - `name`: the session's name, the terminal's id, as a lowercase UUID.
 * - `user`: the non-root user the session's shell runs as, as `uid:gid`,
 *   such as `1000:2000`.
 * - `cwd`: the directory the shell starts in.
 * - `env`: variables tmux runs under, such as `HOME`, `USER` and `LANG`. The
 *   user's tmux server, started by its first session, hands them to every
 *   shell it starts. `TERM` is always {@link clientTerm}.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface SessionOptions {
  readonly name: string
  readonly user: string
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>> | undefined
}

/**
 * Options for {@link attach}.
 *
 * - `name` and `user`: the session, and the `uid:gid` {@link ensureSession}
 *   ran it as; tmux keeps one server per user.
 * - `access`: `write` for the terminal's owner, `read` for everyone else.
 * - `cols` and `rows`: the viewer's terminal size when it attached.
 * - `env`: variables the tmux client runs under, such as `LANG`, which tells
 *   it the terminal speaks UTF-8. `TERM` is always {@link clientTerm}.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface AttachOptions {
  readonly name: string
  readonly user: string
  readonly access: TerminalProtocol.Access
  readonly cols: number
  readonly rows: number
  readonly env?: Readonly<Record<string, string>> | undefined
}

/**
 * The `TERM` a tmux client runs under: what the browser terminal, xterm.js,
 * emulates.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const clientTerm = "xterm-256color"

/**
 * {@link ensureSession} calls, by `outcome`: `created`, `existing` or
 * `failed`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const sessions = Metric.counter("smithers_cloudflare_terminal_sessions", {
  description: "Terminal sessions ensured in a container, by outcome",
  incremental: true
})

/**
 * {@link attach} calls, by `access` and `outcome` ({@link Outcome}).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const connects = Metric.counter("smithers_cloudflare_terminal_connects", {
  description: "Terminal sockets attached to a container's tmux session, by access and outcome",
  incremental: true
})

/**
 * Sockets attached right now, by `access`: up when `ready` is sent, down
 * when the attach ends.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const sessionsOpen = Metric.counter("smithers_cloudflare_terminal_sessions_open", {
  description: "Terminal sockets attached right now, by access"
})

/**
 * Terminal bytes, by `direction`: `in` (from a writer to the shell), `out`
 * (from the shell to a viewer) or `dropped` (from a reader). A count, never
 * content.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const bytes = Metric.counter("smithers_cloudflare_terminal_bytes", {
  description: "Terminal bytes by direction; counts only",
  incremental: true
})

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uidGid = /^(\d{1,10}):\d{1,10}$/
// tmux expands formats in `-c`, and `#(...)` there runs a shell command, so
// the directory admits no `#`, `$`, quote or space.
const directory = /^\/[A-Za-z0-9._/-]*$/

/**
 * Whether `value` is a session name {@link ensureSession} and {@link attach}
 * accept: a lowercase UUID, such as a terminal's id. A Worker can check a
 * terminal id from a URL with it before upgrading the request.
 *
 * @category validation
 * @since 1.0.0-rc.17
 */
export const isSessionName = (value: string): boolean => uuid.test(value)

const checkName = (name: string) =>
  isSessionName(name)
    ? Effect.void
    : Effect.fail(new InvalidSession({ field: "name", message: "A session name is a lowercase UUID" }))

/**
 * Whether `value` is a user {@link ensureSession} and {@link attach} accept:
 * a numeric `uid:gid` whose uid is not 0, such as `1000:2000`.
 *
 * @category validation
 * @since 1.0.0-rc.17
 */
export const isSessionUser = (value: string): boolean => {
  const match = uidGid.exec(value)
  return match !== null && Number(match[1]) !== 0
}

const checkUser = (user: string) =>
  isSessionUser(user)
    ? Effect.void
    : Effect.fail(new InvalidSession({ field: "user", message: "A session runs as a non-root uid:gid" }))

const checkCwd = (cwd: string) =>
  directory.test(cwd)
    ? Effect.void
    : Effect.fail(
      new InvalidSession({ field: "cwd", message: "A session starts in an absolute path of plain characters" })
    )

const isDimension = (value: number, max: number) => Number.isInteger(value) && value >= 1 && value <= max

const checkSize = (cols: number, rows: number) =>
  isDimension(cols, TerminalProtocol.maxCols) && isDimension(rows, TerminalProtocol.maxRows)
    ? Effect.void
    : Effect.fail(new InvalidSession({ field: "size", message: "The terminal size is outside the protocol's bounds" }))

/** The exact-match target for a session: `=` stops tmux matching a prefix or a pattern. */
const target = (name: string) => `=${name}`

/** The variables a tmux command runs under: `env`, with `TERM` always {@link clientTerm}. */
const envOf = (env: Readonly<Record<string, string>> | undefined): Record<string, string> => ({
  ...env,
  TERM: clientTerm
})

/** Runs a command to completion in its own scope and answers its exit code. */
const run = <E, R>(container: Container<E, R>, cmd: Array<string>, options: SessionOptions) =>
  Effect.scoped(
    Effect.flatMap(
      container.exec(cmd, { user: options.user, stdout: "ignore", stderr: "ignore", env: envOf(options.env) }),
      (process) => process.exitCode
    )
  )

/**
 * Creates the tmux session `name` unless it already runs: as `user`,
 * `tmux has-session -t =<name>`, and when that fails, `tmux new-session -d
 * -s <name> -c <cwd>`, each an argument vector with no shell. A session
 * created meanwhile by another caller counts as `existing`.
 *
 * The session's shell keeps running with the container: until the session
 * is killed, its shell exits, or the container stops. It answers `created`
 * or `existing`, fails with {@link InvalidSession} before running anything
 * for a value it refuses, with {@link SessionFailed} when no session runs
 * afterwards, and with the container's own error when `exec` fails.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const ensureSession = <E, R>(
  container: Container<E, R>,
  options: SessionOptions
): Effect.Effect<SessionOutcome, E | InvalidSession | SessionFailed, R> => {
  const exists = Effect.map(
    run(container, ["tmux", "has-session", "-t", target(options.name)], options),
    (code) => code === 0
  )
  return Effect.gen(function*() {
    yield* checkName(options.name)
    yield* checkUser(options.user)
    yield* checkCwd(options.cwd)
    if (yield* exists) return "existing" as const
    const exitCode = yield* run(
      container,
      ["tmux", "new-session", "-d", "-s", options.name, "-c", options.cwd],
      options
    )
    if (exitCode === 0) return "created" as const
    if (yield* exists) return "existing" as const
    return yield* new SessionFailed({ name: options.name, exitCode, message: "tmux could not create the session" })
  }).pipe((effect) =>
    Observed.observed(effect, {
      span: "terminal.session",
      attributes: { "smithers.terminal.id": options.name },
      attribute: "smithers.terminal.session",
      counter: sessions,
      log: "cloudflare.terminal.session"
    })
  )
}

/** What ended one direction of the bridge. */
type Verdict =
  | { readonly _tag: "Ended" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Refused"; readonly outcome: "unsupported" | "too_big"; readonly code: number }
  | { readonly _tag: "Failed" }

const ended: Verdict = { _tag: "Ended" }
const closed: Verdict = { _tag: "Closed" }
const failed: Verdict = { _tag: "Failed" }
const unsupported: Verdict = {
  _tag: "Refused",
  outcome: "unsupported",
  code: TerminalProtocol.CloseCode.unsupported
}
const tooBig: Verdict = { _tag: "Refused", outcome: "too_big", code: TerminalProtocol.CloseCode.tooBig }

/** A frame's data as bytes, when it is binary: an `ArrayBuffer`, a typed array or a `Blob`. */
type Binary =
  | { readonly _tag: "Buffer"; readonly bytes: Uint8Array }
  | { readonly _tag: "Blob"; readonly size: number; readonly read: () => Promise<ArrayBuffer> }

const binary = (data: unknown): Binary | undefined => {
  if (data instanceof ArrayBuffer) return { _tag: "Buffer", bytes: new Uint8Array(data) }
  if (ArrayBuffer.isView(data)) {
    return { _tag: "Buffer", bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
  }
  // A Blob, as workerd delivers a binary frame some clients send.
  const blob = data as { readonly size?: unknown; readonly arrayBuffer?: unknown } | null
  if (typeof blob !== "object" || blob === null || typeof blob.size !== "number") return undefined
  if (typeof blob.arrayBuffer !== "function") return undefined
  const read = blob.arrayBuffer as () => Promise<ArrayBuffer>
  return { _tag: "Blob", size: blob.size, read: () => read.call(blob) }
}

const encoder = new TextEncoder()

/** A text frame's size in bytes; a string longer than the cap in UTF-16 units is over it in UTF-8 too. */
const textBytes = (text: string): number =>
  text.length > TerminalProtocol.maxFrameBytes ? text.length : encoder.encode(text).byteLength

/** A validated frame or a content-free refusal, in arrival order. */
type Inbound = Binary | { readonly _tag: "Resize"; readonly control: TerminalProtocol.Resize } | {
  readonly _tag: "Verdict"
  readonly verdict: Verdict
}

/** At most 1 MiB of retained frames across ingress, stdin and the pending write. */
const inputByteBudget = 16 * TerminalProtocol.maxFrameBytes
const frameOverhead = 64
const frameCost = (size: number): number => frameOverhead + size

/** Validate before retaining any socket payload, including while exec or stdin is stalled. */
const decode = (data: unknown): Inbound => {
  if (typeof data === "string") {
    if (textBytes(data) > TerminalProtocol.maxFrameBytes) return { _tag: "Verdict", verdict: tooBig }
    const control = TerminalProtocol.decodeClientControl(data)
    return control === undefined ? { _tag: "Verdict", verdict: unsupported } : { _tag: "Resize", control }
  }
  const frame = binary(data)
  if (frame === undefined) return { _tag: "Verdict", verdict: unsupported }
  return (frame._tag === "Buffer" ? frame.bytes.byteLength : frame.size) > TerminalProtocol.maxFrameBytes
    ? { _tag: "Verdict", verdict: tooBig }
    : frame
}

/**
 * Bridges an accepted server WebSocket to a new tmux client attached to the
 * session `name`, until one side ends, and answers what happened. It never
 * fails: every outcome closes the socket with its code, or finds it closed.
 *
 * 1. Listens to the socket first, so a close during the attach is not lost.
 * 2. As `user`, runs `tmux attach-session -t =<name>` on a pseudo-terminal
 *    of `cols` × `rows`, under `env` and `TERM` {@link clientTerm}. A writer's client
 *    has piped stdin; a reader's is `-f read-only,ignore-size` with no stdin,
 *    so it can neither type nor size the window.
 * 3. Sends `ready {access}`.
 * 4. Sends the shell's output as binary frames of at most
 *    `TerminalProtocol.maxFrameBytes` each, in order.
 * 5. Reads the viewer's frames in order. A writer's binary frame goes to
 *    stdin, and its `resize` resizes the pseudo-terminal. A reader's binary
 *    frame and `resize` are dropped. A frame over the cap closes the socket
 *    with `CloseCode.tooBig`; a text frame that is not a valid control frame,
 *    or a frame that is neither text nor binary, with
 *    `CloseCode.unsupported`.
 * 6. When the tmux client exits, sends `ended {reason: "closed"}` and closes
 *    with `CloseCode.ended`. Otherwise it closes the socket with the
 *    outcome's code (unless the viewer closed it), SIGKILLs its own tmux
 *    client and waits for it to exit. The session and its shell keep
 *    running.
 *
 * Invalid options close the socket with `CloseCode.unsupported` before
 * anything runs; a failed `exec`, stdin, resize or output stream with
 * `CloseCode.failed`. Retained frames share a 1 MiB budget across both queues and the pending write,
 * charged at 64 bytes per frame plus its binary byte length (zero for resize);
 * overflow closes with `CloseCode.failed` and reason `Terminal input buffer full`.
 * Interruption closes the socket and removes all listeners. Run it in the background of the Durable Object for
 * the socket's lifetime, started right after `accept()`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const attach = <E, R>(
  container: Container<E, R>,
  socket: Socket,
  options: AttachOptions
): Effect.Effect<Report, never, R> =>
  Effect.gen(function*() {
    const access = options.access
    const counted = { in: 0, out: 0, dropped: 0 }
    const count = (direction: "in" | "out" | "dropped", size: number) =>
      Effect.andThen(
        Effect.sync(() => {
          counted[direction] += size
        }),
        Metric.update(Metric.withAttributes(bytes, { direction }), size)
      )
    const send = (message: string | Uint8Array) =>
      Effect.try({
        try: () => socket.send(message),
        catch: () => closed
      })
    let finished = false
    let overflow = false
    const close = (code: number, reason?: string) =>
      Effect.ignore(Effect.try(() => {
        finished = true
        socket.close(code, reason)
      }))

    let retainedBytes = 0
    const events = yield* Queue.unbounded<Inbound>()
    const stop = yield* Deferred.make<Verdict>()
    let stopped = false
    const message = (event: SocketEvent) => {
      if (stopped) return
      const inbound = decode(event.data)
      // Retain only the fixed verdict for rejected frames, preserving earlier input's order.
      if (inbound._tag === "Verdict") stopped = true
      const cost = frameCost(
        inbound._tag === "Buffer" ? inbound.bytes.byteLength : inbound._tag === "Blob" ? inbound.size : 0
      )
      if (retainedBytes + cost > inputByteBudget) {
        overflow = true
        Deferred.doneUnsafe(stop, Effect.succeed(failed))
        stopped = true
        return
      }
      retainedBytes += cost
      Queue.offerUnsafe(events, inbound)
    }
    const disconnected = () => {
      finished = true
      stopped = true
      Deferred.doneUnsafe(stop, Effect.succeed(closed))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        socket.addEventListener("message", message)
        socket.addEventListener("close", disconnected)
        socket.addEventListener("error", disconnected)
      }),
      () =>
        Effect.gen(function*() {
          socket.removeEventListener("message", message)
          socket.removeEventListener("close", disconnected)
          socket.removeEventListener("error", disconnected)
          yield* Queue.shutdown(events)
          if (!finished) yield* close(TerminalProtocol.CloseCode.failed, "Terminal interrupted")
        })
    )

    const valid = yield* Effect.exit(
      Effect.all([checkName(options.name), checkUser(options.user), checkSize(options.cols, options.rows)])
    )
    if (Exit.isFailure(valid)) {
      yield* close(TerminalProtocol.CloseCode.unsupported)
      return { outcome: "unsupported", closeCode: TerminalProtocol.CloseCode.unsupported, bytes: counted } as const
    }

    const argv = access === "write"
      ? ["tmux", "attach-session", "-t", target(options.name)]
      : ["tmux", "attach-session", "-f", "read-only,ignore-size", "-t", target(options.name)]
    const spawned = yield* Effect.exit(container.exec(argv, {
      user: options.user,
      env: envOf(options.env),
      pty: { cols: options.cols, rows: options.rows },
      ...(access === "write" ? { stdin: "pipe" as const } : {})
    }))
    if (Exit.isFailure(spawned)) {
      yield* Effect.annotateCurrentSpan({ "error.type": Observed.failureType(spawned.cause) })
      yield* close(TerminalProtocol.CloseCode.failed)
      return { outcome: "failed", closeCode: TerminalProtocol.CloseCode.failed, bytes: counted } as const
    }
    const process = spawned.value
    const input = yield* Effect.acquireRelease(
      Queue.unbounded<Uint8Array>(),
      Queue.shutdown
    )

    /** The shell's output, in frames under the cap, until the tmux client exits. */
    const outbound = (stdout: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Verdict, never, R> =>
      stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function*() {
            for (let offset = 0; offset < chunk.byteLength; offset += TerminalProtocol.maxFrameBytes) {
              const frame = chunk.subarray(offset, offset + TerminalProtocol.maxFrameBytes)
              yield* send(frame)
              yield* count("out", frame.byteLength)
            }
          })
        ),
        Effect.as(ended),
        Effect.catch((error) => Effect.succeed(error === closed ? closed : failed))
      )

    /** What one frame from the viewer does, or the verdict it ends the bridge with. */
    const handle = (
      frame: Exclude<Inbound, { readonly _tag: "Verdict" }>
    ): Effect.Effect<Verdict | undefined, never, R> =>
      Effect.gen(function*() {
        if (frame._tag === "Resize") {
          const resized = yield* Effect.exit(
            access === "read" ? Effect.void : process.resize(frame.control.cols, frame.control.rows)
          )
          retainedBytes -= frameCost(0)
          return Exit.isSuccess(resized) ? undefined : failed
        }
        const size = frame._tag === "Buffer" ? frame.bytes.byteLength : frame.size
        if (access === "read") {
          retainedBytes -= frameCost(size)
          yield* count("dropped", size)
          return undefined
        }
        const read = frame._tag === "Buffer"
          ? Effect.succeed(frame.bytes)
          : Effect.map(Effect.tryPromise(frame.read), (buffer) => new Uint8Array(buffer))
        const bytes = yield* Effect.exit(read)
        if (Exit.isFailure(bytes)) return failed
        yield* Queue.offer(input, bytes.value)
        yield* count("in", bytes.value.byteLength)
        return undefined
      })

    /** The viewer's frames, in order, until it closes or breaks the protocol. */
    const inbound = Effect.gen(function*() {
      for (;;) {
        const event = yield* Queue.take(events)
        if (event._tag === "Verdict") {
          retainedBytes -= frameCost(0)
          return event.verdict
        }
        const verdict = yield* handle(event)
        if (verdict !== undefined) return verdict
      }
    })

    // The next pull follows the sink's completed write. Keep the current
    // chunk charged while stdin is blocked, then release it before taking another.
    let writingBytes = 0
    const takeInput = Effect.suspend(() => {
      retainedBytes -= writingBytes
      writingBytes = 0
      return Effect.map(Queue.take(input), (chunk) => {
        writingBytes = frameCost(chunk.byteLength)
        return chunk
      })
    })

    /** A writer's keystrokes into stdin, which only a failure ends; a reader has none. */
    const typing = (stdin: Process<E, R>["stdin"]): Effect.Effect<Verdict, never, R> =>
      stdin === undefined
        ? Effect.never
        : Stream.fromEffectRepeat(takeInput).pipe(
          Stream.run(stdin),
          Effect.as(failed),
          Effect.catch(() => Effect.succeed(failed))
        )

    /** Sends `ready`, then bridges both directions until the first of them ends. */
    const bridge = (stdout: Stream.Stream<Uint8Array, E, R>, stdin: Process<E, R>["stdin"]) =>
      Effect.gen(function*() {
        const sent = yield* Effect.exit(send(TerminalProtocol.encodeServerControl({ type: "ready", access })))
        if (Exit.isFailure(sent)) return closed
        return yield* Effect.acquireUseRelease(
          Metric.update(Metric.withAttributes(sessionsOpen, { access }), 1),
          () => Effect.raceAll([Deferred.await(stop), outbound(stdout), inbound, typing(stdin)]),
          () => Metric.update(Metric.withAttributes(sessionsOpen, { access }), -1)
        )
      })

    // A writer without piped stdin, or a client without output, cannot be
    // bridged: the container did not honour the exec options.
    const verdict: Verdict = process.stdout === undefined || (access === "write" && process.stdin === undefined)
      ? failed
      : yield* bridge(process.stdout, access === "write" ? process.stdin : undefined)

    let closeCode: number | null
    switch (verdict._tag) {
      case "Ended":
        yield* Effect.ignore(send(TerminalProtocol.encodeServerControl({ type: "ended", reason: "closed" })))
        closeCode = TerminalProtocol.CloseCode.ended
        break
      case "Closed":
        closeCode = null
        break
      case "Refused":
        closeCode = verdict.code
        break
      case "Failed":
        closeCode = TerminalProtocol.CloseCode.failed
        break
    }
    if (closeCode !== null) yield* close(closeCode, overflow ? "Terminal input buffer full" : undefined)
    else finished = true
    // A client still attached is this socket's alone: kill it, never the
    // session. Waiting for its exit lets the scope's own cleanup know the
    // process is gone, so nothing signals a reused pid later.
    if (verdict._tag !== "Ended") yield* Effect.ignore(process.kill(9))
    yield* Effect.ignore(process.exitCode)
    const outcome: Outcome = verdict._tag === "Ended"
      ? "ended"
      : verdict._tag === "Closed"
      ? "closed"
      : verdict._tag === "Refused"
      ? verdict.outcome
      : "failed"
    return { outcome, closeCode, bytes: counted }
  }).pipe(
    Effect.scoped,
    Effect.tap((report) =>
      Effect.gen(function*() {
        const attributes = {
          "smithers.terminal.outcome": report.outcome,
          ...(report.closeCode === null ? {} : { "smithers.terminal.close_code": report.closeCode }),
          "smithers.terminal.bytes_in": report.bytes.in,
          "smithers.terminal.bytes_out": report.bytes.out,
          "smithers.terminal.bytes_dropped": report.bytes.dropped
        }
        yield* Effect.annotateCurrentSpan(attributes)
        yield* Metric.update(
          Metric.withAttributes(connects, { access: options.access, outcome: report.outcome }),
          1
        )
        yield* (report.outcome === "failed" ? Effect.logWarning : Effect.logInfo)("cloudflare.terminal.connect").pipe(
          Effect.annotateLogs({ access: options.access, ...attributes })
        )
      })
    ),
    Effect.withSpan("terminal.connect", {
      attributes: { "smithers.terminal.id": options.name, "smithers.terminal.access": options.access }
    })
  )
