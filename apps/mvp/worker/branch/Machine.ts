import { type Sandbox, SandboxTools } from "@smthrs/sandbox"
import { Cause, Clock, Duration, Effect, Metric } from "effect"
import { SANDBOX_USER } from "../../src/features/terminal/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import type { CommandOutcome, CommandRequest, SleepOutcome, ToolOutcome } from "./Machines.ts"
import { provisionArgv, userOf } from "./Users.ts"

// What a branch's machine does for its tools and its lifecycle, over any host (decision 0005 §2-§3,
// docs/features/sandbox-tools.md#the-machine). The branch's object (on Cloudflare, `SandboxObject` in
// worker/BranchSandboxes.ts) holds the container and its own storage, and hands them here as a `Box`; nothing here
// names a host, so a test runs it over a scratch directory.
//
// - A tool call runs as the person's own user, with `@smthrs/sandbox`'s `SandboxTools`, its command fenced in that
//   user's home so it runs at most once, and by generation in the object's storage, so a machine that restarted never
//   runs it again either.
// - The working copy outlives the machine: after a call that changes it, and before the machine sleeps, the object
//   saves a checkpoint (`SandboxTools.checkpoint`: the commit, a binary patch, and a bundle of the commits no remote
//   has) in its storage, and the first wake of the next generation puts it back. A machine whose checkpoint can't be
//   saved stays awake. A checkpoint that can't be put back is kept aside, never overwritten.
// - Idle means nothing happened for the idle time: no call, no terminal input, and no process of a person but their
//   shells and tmux.

/** The object's durable storage, as the machine uses it. */
export interface Store<R> {
  readonly get: <A>(key: string) => Effect.Effect<A | undefined, never, R>
  readonly put: (key: string, value: unknown) => Effect.Effect<void, never, R>
  readonly delete: (key: string) => Effect.Effect<unknown, never, R>
  /** Every entry whose key starts with `prefix`. */
  readonly list: <A>(prefix: string) => Effect.Effect<ReadonlyMap<string, A>, never, R>
}

/** One branch's machine as its object holds it. */
export interface Box<R> {
  /** A session on the running container as `user`, in /workspace. */
  readonly sessionAs: (user: string) => Effect.Effect<Sandbox.Session, never, R>
  /** Runs `argv` as `user`: its exit code. */
  readonly run: (argv: Array<string>, user: string) => Effect.Effect<number, unknown, R>
  readonly running: Effect.Effect<boolean, unknown, R>
  /** Stops the container; its disk goes with it. */
  readonly destroy: Effect.Effect<void, unknown, R>
  readonly storage: Store<R>
}

/**
 * How long the object remembers which generation started a command (`run:<call id>`): far past `sandbox/Call`'s
 * 2-minute retry and a command's 10-minute cap, so any attempt of a call still finds its record, and a record nothing
 * can ask for again is dropped.
 */
export const RUN_RECORD_MS = 24 * 60 * 60_000

/** Which generation started a command, and when. A record saved before `at` existed is a bare generation. */
interface RunStarted {
  readonly generation: number
  readonly at: number
}

const startedOf = (value: RunStarted | number | undefined): RunStarted | undefined =>
  typeof value === "number" ? { generation: value, at: 0 } : value

/** Drops every command record older than `RUN_RECORD_MS`, as a new command is recorded. */
const dropOldRuns = <R>(box: Box<R>, now: number) =>
  Effect.gen(function* () {
    for (const [key, value] of yield* box.storage.list<RunStarted | number>("run:")) {
      if (now - (typeof value === "number" ? 0 : value.at) > RUN_RECORD_MS) yield* box.storage.delete(key)
    }
  })

/** Where a person's commands keep their fences and results: in their own home, outside the checkout. */
export const callsDirectory = (user: string): string => `/home/${user}/.smithers/calls`

/** The largest piece of a checkpoint one storage value holds. */
export const CHUNK_BYTES = 120 * 1024

/**
 * A saved checkpoint's record in the object's storage. Its patch, then its bundle (`bundleBytes` of the `bytes`; none
 * in a record saved before bundles), are in `checkpoint:<seq>:<n>` pieces: each save writes a new sequence's pieces
 * before it switches the record to them, so a save that stops part way leaves the record on the previous checkpoint,
 * whole. `seq` in storage is the last sequence any save took, so a new one never reuses a kept-aside checkpoint's.
 */
interface Saved {
  readonly generation: number
  readonly head: string
  readonly seq: number
  readonly pieces: number
  readonly bytes: number
  readonly bundleBytes?: number
}

/** The key of piece `index` of checkpoint sequence `seq`. */
const pieceKey = (seq: number, index: number): string => `checkpoint:${seq}:${index}`

/** Checkpoints saved and restored, by `op` (`save`, `restore`) and `outcome`. */
export const checkpoints = Metric.counter("smithers_sandbox_checkpoints", {
  description: "Working-copy checkpoints a branch's machine saved and restored, by op and outcome",
  incremental: true,
})

const counted = (op: "save" | "restore", outcome: string, failure?: SandboxTools.ToolRefused | SandboxTools.ToolUnavailable) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(checkpoints, { op, outcome }), 1),
    Effect.logWithLevel(outcome === "saved" || outcome === "restored" || outcome === "none" ? "Info" : "Warn")(
      `sandbox.checkpoint.${op}`,
    ).pipe(Effect.annotateLogs({ outcome, ...failureOf(failure) })),
  )

/** What a log line says about a checkpoint's failure: the provider's code, and the script step's exit code. */
const failureOf = (failure: SandboxTools.ToolRefused | SandboxTools.ToolUnavailable | undefined) =>
  failure?._tag === "@smthrs/sandbox/SandboxTools/ToolUnavailable"
    ? { code: failure.code, ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }) }
    : {}

/**
 * Records that the machine was used and its working copy should be saved at the next ask (`sleepIfIdle`), as a
 * terminal comes or goes: the save runs in the ask's own request, never the closing socket's.
 */
export const saveLater = <R>(box: Box<R>) => Effect.andThen(touch(box), box.storage.put("saveDue", true))

/** Records that the machine was used now: a call, or a terminal coming or going. */
export const touch = <R>(box: Box<R>) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => box.storage.put("activeAt", now))

/**
 * Saves the working copy of generation `generation` in the object's storage, once that generation's restore has run,
 * so a fresh checkout never replaces the checkpoint it hasn't put back yet. Answers how it went: `saved`, `skipped`
 * (not restored yet, or no checkout), `too_large` or `failed`.
 */
export const save = <R>(box: Box<R>, generation: number) =>
  Effect.gen(function* () {
    if ((yield* box.storage.get<number>("restored")) !== generation) return "skipped" as const
    const session = yield* box.sessionAs(SANDBOX_USER)
    const captured = yield* Effect.result(SandboxTools.checkpoint(session))
    if (captured._tag === "Failure") {
      const error = captured.failure
      const outcome = error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
        ? error.reason === "too_large" ? "too_large" as const : "skipped" as const
        : "failed" as const
      yield* counted("save", outcome, error)
      return outcome
    }
    const { bundle, head, patch } = captured.success
    const blob = new Uint8Array(patch.byteLength + bundle.byteLength)
    blob.set(patch)
    blob.set(bundle, patch.byteLength)
    const before = yield* box.storage.get<Saved>("checkpoint")
    const seq = Math.max(before?.seq ?? 0, (yield* box.storage.get<number>("seq")) ?? 0) + 1
    yield* box.storage.put("seq", seq)
    const pieces = Math.ceil(blob.byteLength / CHUNK_BYTES)
    // The new pieces first, then the record: until it switches, the record names the previous checkpoint's pieces.
    for (let index = 0; index < pieces; index++) {
      yield* box.storage.put(pieceKey(seq, index), blob.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES))
    }
    yield* box.storage.put("checkpoint", {
      generation,
      head,
      seq,
      pieces,
      bytes: blob.byteLength,
      bundleBytes: bundle.byteLength,
    } satisfies Saved)
    // Keep the active checkpoint and quarantined checkpoints; reclaim pieces from interrupted saves too.
    // Repeating this after a crash is safe, including a crash during cleanup itself.
    const retained = new Set([seq])
    for (const record of (yield* box.storage.list<Saved>("stranded:")).values()) retained.add(record.seq)
    for (const key of (yield* box.storage.list<Uint8Array>("checkpoint:")).keys()) {
      const sequence = Number(key.split(":")[1])
      if (!retained.has(sequence)) yield* box.storage.delete(key)
    }
    yield* counted("save", "saved")
    return "saved" as const
  }).pipe(Effect.withSpan("sandbox.checkpoint.save", { attributes: { "smithers.sandbox.generation": generation } }))

/**
 * Whether a restore's failure is the machine not answering, which a later wake retries, rather than a checkpoint that
 * can't go on this checkout: a refusal (its commit is gone, say), or its script failing (a patch that won't apply).
 */
const isTransient = (failure: SandboxTools.ToolRefused | SandboxTools.ToolUnavailable): boolean =>
  failure._tag === "@smthrs/sandbox/SandboxTools/ToolUnavailable" && failure.code !== "unknown"

/**
 * Puts the last checkpoint back on generation `generation`'s fresh checkout, once: a checkpoint of an earlier
 * generation is applied (`restored`); there may be none (`none`).
 *
 * - The machine not answering fails it with `ToolUnavailable`, and nothing is recorded: the wake fails, and the next
 *   one tries again before any save can replace the checkpoint.
 * - A checkpoint that can't go on this checkout (its refusal's reason, or `failed`) is kept aside as
 *   `stranded:<seq>`, pieces and all, so no later save overwrites it, and the machine stays usable.
 */
export const restore = <R>(box: Box<R>, generation: number) =>
  Effect.gen(function* () {
    if ((yield* box.storage.get<number>("restored")) === generation) return "done" as const
    const saved = yield* box.storage.get<Saved>("checkpoint")
    let outcome: string = "none"
    let failure: SandboxTools.ToolRefused | SandboxTools.ToolUnavailable | undefined
    if (saved !== undefined && saved.generation < generation) {
      const blob = new Uint8Array(saved.bytes)
      for (let index = 0; index < saved.pieces; index++) {
        blob.set((yield* box.storage.get<Uint8Array>(pieceKey(saved.seq, index))) ?? new Uint8Array(), index * CHUNK_BYTES)
      }
      const patchBytes = saved.bytes - (saved.bundleBytes ?? 0)
      const session = yield* box.sessionAs(SANDBOX_USER)
      const restored = yield* Effect.result(
        SandboxTools.restore(session, { head: saved.head, patch: blob.subarray(0, patchBytes), bundle: blob.subarray(patchBytes) }),
      )
      if (restored._tag === "Failure" && isTransient(restored.failure)) {
        yield* counted("restore", "unavailable", restored.failure)
        return yield* Effect.fail(restored.failure)
      }
      outcome = restored._tag === "Success"
        ? "restored"
        : restored.failure._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
        ? restored.failure.reason
        : "failed"
      if (restored._tag === "Failure") {
        failure = restored.failure
        yield* box.storage.put(`stranded:${saved.seq}`, saved)
        yield* box.storage.put("seq", Math.max((yield* box.storage.get<number>("seq")) ?? 0, saved.seq))
        yield* box.storage.delete("checkpoint")
      }
    }
    yield* box.storage.put("restored", generation)
    yield* counted("restore", outcome, failure)
    return outcome
  }).pipe(Effect.withSpan("sandbox.checkpoint.restore", { attributes: { "smithers.sandbox.generation": generation } }))

/**
 * Runs `call` on generation `generation` as person `ownerId`'s own user, made on first use, then saves the working
 * copy when the call changed it. The machine is awake and checked out already.
 */
export const tool = <R>(
  box: Box<R>,
  options: {
    readonly ownerId: string
    readonly callId: string
    readonly call: SandboxTools.Call
    readonly generation: number
  },
): Effect.Effect<ToolOutcome, never, R> =>
  Effect.gen(function* () {
    const user = userOf(options.ownerId)
    if ((yield* box.run(provisionArgv(user), "root")) !== 0) return { _tag: "Unavailable" } as const
    const session = yield* box.sessionAs(user)
    // A command's fence lives on the machine's own disk, which a restart loses. The object remembers the generation it
    // started each command on, for RUN_RECORD_MS, so a command an earlier generation started settles lost and never
    // runs again (0005's MachineLost): its effects went with that machine, and its result may have too.
    if (options.call.tool === "run") {
      const started = startedOf(yield* box.storage.get<RunStarted | number>(`run:${options.callId}`))
      if (started !== undefined && started.generation !== options.generation) return { _tag: "Lost" } as const
      if (started === undefined) {
        const now = yield* Clock.currentTimeMillis
        yield* dropOldRuns(box, now)
        yield* box.storage.put(`run:${options.callId}`, { generation: options.generation, at: now } satisfies RunStarted)
      }
    }
    yield* touch(box)
    const ran = yield* Effect.result(
      SandboxTools.execute(session, options.call, { callId: options.callId, callsDirectory: callsDirectory(user) }),
    )
    yield* touch(box)
    if (ran._tag === "Failure") {
      const error = ran.failure
      return error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
        ? { _tag: "Refused", reason: error.reason } as const
        : error._tag === "@smthrs/sandbox/SandboxTools/ToolLost"
        ? { _tag: "Lost" } as const
        : { _tag: "Unavailable" } as const
    }
    if (SandboxTools.mutates(options.call.tool)) yield* save(box, options.generation)
    return { _tag: "Done", result: ran.success, generation: options.generation } as const
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("sandbox.object.tool").pipe(Effect.annotateLogs({ errorCode: codeOf(Cause.squash(cause)) })),
        { _tag: "Unavailable" } as const,
      )
    ),
    Effect.withSpan("sandbox.object.tool", { attributes: { "smithers.sandbox.tool": options.call.tool } }),
  )

/** A tool's failure as the plain data a command operation answers. */
const failedCommand = (error: SandboxTools.ToolFailure): CommandOutcome =>
  error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
    ? { _tag: "Refused", reason: error.reason }
    : error._tag === "@smthrs/sandbox/SandboxTools/ToolLost"
    ? { _tag: "Lost" }
    : { _tag: "ToolUnavailable", code: error.code, ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }) }

/**
 * Runs one operation on a command person `ownerId` starts detached in the machine (`SandboxTools.start`, `observe`,
 * `collect`, `cancel`), as their own user, with the command's pid, exit and output kept in their home
 * (`callsDirectory`) under its key.
 *
 * `generation` is the machine's running generation: the one the wake answered for a `start`, which the object
 * remembers for the key as it remembers a tool's command (`run:<key>`, for RUN_RECORD_MS); for the rest, the one
 * running now, or `undefined` when the machine isn't. A key started on another generation is gone with that machine:
 * its `start` answers `Lost` and never starts it again, it observes `lost`, it collects `Lost`, and cancelling it has
 * nothing to stop. A key cancelled before any start reached the object is remembered as gone, so a start still on its
 * way never starts it. A start that names the tool call it is for (`callId`) finds that call's own command record too:
 * a command an earlier attempt ran as a tool call (`tool`) is `Lost`, never started again as a job. Every operation is
 * use of the machine (`touch`), so one whose command still runs isn't put to sleep, and a collected command's working
 * copy is saved, as a tool call's is.
 */
export const command = <R>(
  box: Box<R>,
  options: { readonly ownerId: string; readonly request: CommandRequest; readonly generation: number | undefined },
): Effect.Effect<CommandOutcome, never, R> =>
  Effect.suspend(() => {
    // Where the operation is, so the line of one that failed or hung says where.
    let stage: CommandStage = "provision"
    return Effect.gen(function* () {
      const { generation, request } = options
      const user = userOf(options.ownerId)
      const starting = request.op === "start" && generation !== undefined
      if (starting && (yield* bounded(box.run(provisionArgv(user), "root"))) !== 0) return { _tag: "Unavailable" } as const
      stage = "record"
      // Read after the provisioning's exec, during which the object takes other requests: a cancel that came then is
      // seen.
      let started = startedOf(yield* box.storage.get<RunStarted | number>(`run:${request.key}`))
      if (starting) {
        if (
          started === undefined && request.callId !== undefined &&
          (yield* box.storage.get<RunStarted | number>(`run:${request.callId}`)) !== undefined
        ) {
          return { _tag: "Lost" } as const
        }
        if (started === undefined) {
          started = { generation, at: yield* Clock.currentTimeMillis }
          yield* dropOldRuns(box, started.at)
          yield* box.storage.put(`run:${request.key}`, started)
        }
      }
      if (generation === undefined || started?.generation !== generation) {
        // Generation 0 is none: a key cancelled before it started stays gone.
        if (request.op === "cancel" && started === undefined) {
          yield* box.storage.put(`run:${request.key}`, { generation: 0, at: yield* Clock.currentTimeMillis } satisfies RunStarted)
        }
        return request.op === "observe"
          ? { _tag: "Observed", observed: { state: "lost" } } as const
          : request.op === "cancel"
          ? { _tag: "Cancelled" } as const
          : { _tag: "Lost" } as const
      }
      stage = "session"
      const session = yield* bounded(box.sessionAs(user))
      const at = { key: request.key, callsDirectory: callsDirectory(user) }
      yield* touch(box)
      stage = "script"
      const ran = yield* bounded(Effect.result(
        request.op === "start"
          ? Effect.map(SandboxTools.start(session, request.call, at), (value): CommandOutcome => ({
            _tag: "Started",
            started: value,
            generation,
          }))
          : request.op === "observe"
          ? Effect.map(
            SandboxTools.observe(session, { ...at, waitMs: request.waitMs }),
            (observed): CommandOutcome => ({ _tag: "Observed", observed }),
          )
          : request.op === "collect"
          ? Effect.map(SandboxTools.collect(session, at), (result): CommandOutcome => ({ _tag: "Collected", result }))
          : Effect.as(SandboxTools.cancel(session, at), { _tag: "Cancelled" } as const),
      ))
      if (ran._tag === "Failure") return failedCommand(ran.failure)
      if (request.op === "collect") {
        stage = "save"
        yield* save(box, generation)
      }
      return ran.success
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("sandbox.object.command").pipe(Effect.annotateLogs({
            op: options.request.op,
            stage,
            errorCode: Cause.isTimeoutError(Cause.squash(cause)) ? "timeout" : codeOf(Cause.squash(cause)),
          })),
          { _tag: "Unavailable" } as const,
        )
      ),
      // Each operation's line says what it answered and how long the box took, so a slow start or probe shows which.
      Effect.timed,
      Effect.flatMap(([took, outcome]) =>
        Effect.as(
          Effect.logInfo("sandbox.object.command").pipe(Effect.annotateLogs({
            op: options.request.op,
            outcome: outcome._tag === "Observed" ? outcome.observed.state : outcome._tag,
            durationMs: Duration.toMillis(took),
          })),
          outcome,
        )
      ),
      Effect.withSpan("sandbox.object.command", { attributes: { "smithers.sandbox.command.op": options.request.op } }),
    )
  })

/** Where a command operation is: provisioning the person's user, reading its record, opening a session, its script. */
type CommandStage = "provision" | "record" | "session" | "script" | "save"

/**
 * The longest one exec of a command operation takes: provisioning a user, opening a session or one of the command
 * scripts, each of which answers in seconds, or, for an observe that waits for the command to end, within its wait
 * (at most `SandboxTools.limits.maxObserveWaitSeconds`). One that takes longer answers `Unavailable`, which its job asks again;
 * the start's fence starts the command once however many times it is asked.
 */
export const COMMAND_EXEC_MS = 2 * 60_000

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.timeout(effect, COMMAND_EXEC_MS)

/**
 * What a person's processes are doing: exit 3 when a terminal had input within `$1` seconds, exit 4 when a non-root process
 * other than PID 1, a shell or tmux runs; exit 0 when nothing does. Run as root, which may read every tmux server.
 *
 * A zombie (state `Z`) doesn't count: it has exited. With `sleep infinity` as the box's PID 1, nothing reaped the orphans
 * reparented to it, so a `git` a person left in the background stayed a zombie and kept a box awake for hours in
 * production; the image now runs tini as PID 1, which reaps them. The box's own idle process, `smithers-idle` under
 * tini (infra/sandbox/Dockerfile), doesn't count either.
 */
export const PROBE = `idle=$1; now=$(date +%s)
for s in /tmp/tmux-*/default; do
  [ -S "$s" ] || continue
  for a in $(tmux -S "$s" list-sessions -F '#{session_activity}' 2>/dev/null); do
    [ $((now - a)) -lt "$idle" ] && exit 3
  done
done
for p in /proc/[0-9]*; do
  [ "\${p#/proc/}" = 1 ] && continue
  u=$(stat -c %u "$p" 2>/dev/null) || continue
  [ "$u" = 0 ] && continue
  [ "$(sed -n 's/^State:[[:space:]]*\\([A-Z]\\).*/\\1/p' "$p/status" 2>/dev/null)" = Z ] && continue
  case "$(cat "$p/comm" 2>/dev/null)" in sh|bash|dash|tmux*|smithers-idle|"") ;; *) exit 4 ;; esac
done
exit 0`

/** Sleep decisions, by outcome and a bounded, content-free reason. */
export const sleepDecisions = Metric.counter("smithers_sandbox_sleep_decisions", {
  description: "Branch machine sleep decisions by outcome and reason",
  incremental: true,
})

/**
 * Puts generation `generation` to sleep when nothing happened in it for `idleMs`: it saves the working copy, then
 * stops the container. `gone` when that generation isn't running any more; `busy` when something happened, or the
 * checkpoint couldn't be saved. A call, a terminal or terminal input that came while it probed and saved makes it
 * `busy` too, so the machine never stops under new work: after saving it reads `activeAt` and probes again.
 */
export const sleepIfIdle = <R>(box: Box<R>, generation: number, idleMs: number): Effect.Effect<SleepOutcome, unknown, R> =>
  Effect.gen(function* () {
    const decision = (outcome: SleepOutcome, reason: string, fields: Record<string, number | string> = {}) =>
      Effect.as(Effect.andThen(
        Metric.update(Metric.withAttributes(sleepDecisions, { outcome, reason }), 1),
        Effect.logInfo("sandbox.object.sleep").pipe(Effect.annotateLogs({ generation, idleMs, outcome, reason, ...fields })),
      ), outcome)
    if ((yield* box.storage.get<number>("generation")) !== generation || !(yield* box.running)) {
      return yield* decision("gone", "generation_gone")
    }
    // A save a closed terminal left due runs now, whether or not the machine then sleeps.
    if ((yield* box.storage.get<boolean>("saveDue")) === true) {
      yield* box.storage.delete("saveDue")
      yield* save(box, generation)
    }
    const now = yield* Clock.currentTimeMillis
    const activeAt = yield* box.storage.get<number>("activeAt")
    const inactiveMs = now - (activeAt ?? 0)
    if (inactiveMs < idleMs) return yield* decision("busy", "recent_use", { inactiveMs })
    const probe = ["sh", "-c", PROBE, "probe", String(Math.ceil(idleMs / 1000))]
    const probed = (exitCode: number, phase: string) => decision("busy",
      exitCode === 3 ? "terminal_input" : exitCode === 4 ? "process" : "probe_failed", { exitCode, phase })
    const before = yield* box.run(probe, "root")
    if (before !== 0) return yield* probed(before, "before_save")
    const saved = yield* save(box, generation)
    if (saved !== "saved" && saved !== "skipped") return yield* decision("busy", "checkpoint", { checkpoint: saved })
    if ((yield* box.storage.get<number>("activeAt")) !== activeAt) return yield* decision("busy", "use_during_save")
    const after = yield* box.run(probe, "root")
    if (after !== 0) return yield* probed(after, "after_save")
    yield* box.destroy
    return yield* decision("slept", "idle", { inactiveMs })
  }).pipe(Effect.withSpan("sandbox.object.sleep", { attributes: { "smithers.sandbox.generation": generation } }))
