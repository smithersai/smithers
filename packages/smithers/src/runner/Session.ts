/**
 * One job's work on the runner: its checkout, its agent's session over the
 * Agent Client Protocol, and the change it leaves.
 *
 * The session is the job's durable unit, resumed from the last checkpoint the
 * agent's own protocol records (Will, 2026-10-31, DUR-1's exception for
 * external agents). The runner keeps one checkpoint beside the checkout,
 * `<checkout>.acp.json` (mode `0600`): the generation it belongs to, the ACP
 * session id once the agent gave one, and the environment and account label
 * the profile's `prestart` chose. Work that runs again for the same
 * generation, because the runner restarted, reuses that environment, skips
 * `prestart`, and loads the session (`session/load`) so the agent carries on
 * from its own transcript under the same account. A new generation, which
 * follows a retryable end and may run under another account, runs `prestart`
 * again and starts a fresh session told that the checkout holds earlier work.
 * Nothing outside this module knows a session can resume.
 *
 * Every update the agent streams goes to the job's transcript spool
 * (Spool.ts), which the host shows as the run's transcript, except the
 * history an agent replays while it loads a session: the host has it already.
 * The runner adds `_smithers/turn` with each prompt turn's stop reason.
 *
 * Nothing here logs a prompt, the agent's text, a command line, an
 * environment or a path: ids, codes, the account label and durations only.
 *
 * @since 1.0.0
 */

import * as Acp from "@smthrs/agent/Acp"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect"
import { execFile } from "node:child_process"
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type * as Config from "./Config.ts"
import type * as Host from "./Host.ts"
import * as Spool from "./Spool.ts"
import * as Tree from "./Tree.ts"
import * as Workspace from "./Workspace.ts"

/**
 * The durable payload of one job: everything the claim said but whether it was
 * reclaimed, which differs between a job's first claim and its reclaim.
 *
 * @category schemas
 * @since 1.0.0
 */
export const JobPayload = Schema.Struct({
  key: AgentRunner.Job.fields.key,
  claim: AgentRunner.Job.fields.claim,
  generation: AgentRunner.Job.fields.generation,
  task: AgentRunner.Task,
  deadline: AgentRunner.Job.fields.deadline
})

/**
 * The durable payload of one job, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type JobPayload = typeof JobPayload.Type

/**
 * What the serve loop tells a job's work while it runs: whether the host asked
 * to stop it, whether the claim no longer holds it (the work stops its agent,
 * and its settlement is refused), and whether this claim was handed back after
 * a restart.
 *
 * @category models
 * @since 1.0.0
 */
export interface Control {
  readonly cancel: Deferred.Deferred<void>
  readonly dropped: Deferred.Deferred<void>
  readonly reclaimed: boolean
}

/**
 * The most characters of the agent's last message kept as the job's summary.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_SUMMARY = 4096

/**
 * How long the agent must be quiet after `end_turn` before its work is
 * collected, and the most the runner waits for that quiet. An agent may go on
 * sending updates, or start a turn of its own, after its turn ends.
 *
 * @category constants
 * @since 1.0.0
 */
export const QUIET = { afterMs: 5000, maxMs: 60_000 }

/**
 * The prompt that resumes a loaded session.
 *
 * @category constants
 * @since 1.0.0
 */
export const CONTINUE =
  "Continue\n\nYour earlier turn was interrupted. The checkout holds your work so far; carry on with " +
  "the task from where you stopped."

/**
 * The line a fresh session's prompt ends with when the checkout holds an
 * earlier session's work.
 *
 * @category constants
 * @since 1.0.0
 */
export const EARLIER_WORK = "An earlier attempt at this task left its work in the checkout. Continue from it."

const Checkpoint = Schema.Struct({
  generation: Schema.Int,
  sessionId: Schema.optional(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  account: Schema.optional(Schema.String)
})
type Checkpoint = typeof Checkpoint.Type
const decodeCheckpoint = Schema.decodeUnknownOption(Schema.fromJsonString(Checkpoint))

const readCheckpoint = (checkout: Workspace.Checkout): Checkpoint | undefined => {
  try {
    return Option.getOrUndefined(decodeCheckpoint(readFileSync(checkout.checkpoint, "utf8")))
  } catch {
    return undefined
  }
}

const writeCheckpoint = (checkout: Workspace.Checkout, checkpoint: Checkpoint) =>
  Effect.sync(() => {
    const temporary = `${checkout.checkpoint}.tmp`
    writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, checkout.checkpoint)
  })

/** The runner's own environment, as an agent or a hook inherits it. */
const inherited = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith("SMITHERS_RUNNER_")
    )
  )

/**
 * Runs the profile's `prestart` in the checkout for at most 60 s: the
 * environment its `NAME=VALUE` lines set and the account its `account=` line
 * names, or `undefined` when it exits non-zero.
 */
const prestart = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string>) =>
  Effect.callback<{ readonly env: Record<string, string>; readonly account: string | undefined } | undefined>(
    (resume, signal) => {
      execFile(
        argv[0]!,
        argv.slice(1),
        { cwd, env, signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) return resume(Effect.succeed(undefined))
          const set: Record<string, string> = {}
          let account: string | undefined
          for (const line of String(stdout).split("\n")) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
            if (match === null) continue
            if (match[1] === "account") account = match[2]
            else set[match[1]!] = match[2]!
          }
          resume(Effect.succeed({ env: set, account }))
        }
      )
    }
  )

/** The first prompt of a fresh session: the instructions, the task, and whether earlier work is in the checkout. */
const promptOf = (task: AgentRunner.Task, earlier: boolean): string =>
  [...task.system, task.prompt, ...(earlier ? [EARLIER_WORK] : [])].filter((part) => part.length > 0).join("\n\n")

const failed = (reason: (typeof AgentRunner.FAILURES)[number]): AgentRunner.Outcome => ({ _tag: "Failed", reason })

/**
 * Does one job's work and answers how it ended. Never fails: every way it can
 * end is an outcome. Interrupted (the claim was lost), it stops the agent's
 * whole tree and answers nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const work = (
  config: Config.Checked,
  job: JobPayload,
  control: Control
): Effect.Effect<AgentRunner.Outcome, never, Host.Host> =>
  Effect.gen(function*() {
    const startedAt = Date.now()
    const { origin } = AgentRunner.parseKey(job.key)
    const checkout = Workspace.of(config.stateDir, origin)
    const report = (outcome: AgentRunner.Outcome, fields: Record<string, string | number | boolean> = {}) =>
      Effect.logInfo("runner.session").pipe(
        Effect.annotateLogs({
          job: job.key,
          generation: job.generation,
          outcome: outcome._tag === "Failed" ? `failed:${outcome.reason}` : outcome._tag.toLowerCase(),
          durationMs: Date.now() - startedAt,
          ...fields
        }),
        Effect.as(outcome)
      )
    const repository = config.repositories[job.task.repository]
    if (repository === undefined) return yield* report(failed("workspace"))
    const profile = config.profiles[job.task.agent.profile]
    if (profile === undefined) return yield* report(failed("refused"))
    if (!Workspace.exists(checkout)) {
      if (job.generation > 1 || control.reclaimed) return yield* report(failed("machine_lost"))
      const made = yield* Effect.exit(Workspace.create(repository.mirror, job.task.base, checkout))
      if (Exit.isFailure(made)) return yield* report(failed("workspace"))
    }
    if (Date.now() >= job.deadline) return yield* report(failed("timeout"))
    const saved = readCheckpoint(checkout)
    const same = saved !== undefined && saved.generation === job.generation
    const base = { ...inherited(), ...profile.env }
    let chosen: { readonly env: Record<string, string>; readonly account: string | undefined }
    if (same) {
      chosen = { env: saved.env, account: saved.account }
    } else {
      const hook = profile.prestart === undefined
        ? { env: {}, account: undefined }
        : yield* prestart(profile.prestart, checkout.dir, base)
      if (hook === undefined) return yield* report(failed("refused"))
      chosen = hook
      yield* writeCheckpoint(checkout, {
        generation: job.generation,
        env: hook.env,
        ...(hook.account === undefined ? {} : { account: hook.account })
      })
    }
    const account: { account?: string } = chosen.account === undefined ? {} : { account: chosen.account }
    const scrub = Transcript.scrubber([
      ...(profile.secretEnv ?? []).flatMap((name) => base[name] === undefined ? [] : [base[name]]),
      ...Object.values(chosen.env)
    ])
    const outcome = yield* Effect.scoped(Effect.gen(function*() {
      const spool = yield* Spool.open({ stateDir: config.stateDir, key: job.key, claim: job.claim, scrub })
      yield* Effect.forkScoped(spool.upload)
      return yield* session({
        profile,
        job,
        checkout,
        control,
        env: { ...base, ...chosen.env },
        resume: same ? saved.sessionId : undefined,
        checkpoint: { generation: job.generation, env: chosen.env, ...account },
        scrub,
        spool
      })
    }))
    const fields: Record<string, string> = { stop: outcome.stop }
    if (chosen.account !== undefined) fields.account = chosen.account
    return yield* report(outcome.outcome, fields)
  })

/** One agent process and its session, in the caller's scope: how it ended, and the stop reason or end code. */
const session = (options: {
  readonly profile: Config.Profile
  readonly job: JobPayload
  readonly checkout: Workspace.Checkout
  readonly control: Control
  readonly env: Record<string, string>
  readonly resume: string | undefined
  readonly checkpoint: Checkpoint
  readonly scrub: (text: string) => string
  readonly spool: Spool.Spool
}) =>
  Effect.gen(function*() {
    const { checkout, control, job, profile } = options
    const retry = (kind: "refusal" | "exit" | "error"): AgentRunner.Outcome | undefined =>
      profile.retryOn?.includes(kind) === true ? { _tag: "Retryable" } : undefined
    const ended = (outcome: AgentRunner.Outcome, stop: string) => ({ outcome, stop })
    const spawned = yield* Effect.exit(ScopedProcess.spawn({
      command: profile.argv[0]!,
      args: profile.argv.slice(1),
      cwd: checkout.dir,
      env: options.env,
      stdin: "pipe",
      killSignal: "SIGINT",
      forceKillAfter: 15_000
    }))
    if (Exit.isFailure(spawned)) return ended(failed("refused"), "spawn")
    const handle = spawned.value
    const tree = Tree.watch(handle.targetPid)
    yield* tree.observe.pipe(Effect.andThen(Effect.sleep(1000)), Effect.forever, Effect.forkScoped)
    // Every way out stops the whole tree, the agent's detached tools included.
    yield* Effect.addFinalizer(() => Tree.stop(tree, { graceMs: 2000, settleMs: 5000 }).pipe(Effect.ignore))
    const lines = yield* Queue.unbounded<string>()
    const encoder = new TextEncoder()
    yield* Stream.fromQueue(lines).pipe(
      Stream.map((line) => encoder.encode(`${line}\n`)),
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped
    )
    yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped)
    let lastUpdate = Date.now()
    let current = ""
    let previous = ""
    let usage: AgentRunner.Usage = {}
    // While the agent loads a session it replays that session's history, which the transcript holds already.
    let loading = false
    const client = yield* Acp.make({
      incoming: Stream.splitLines(Stream.decodeText(handle.stdout)),
      send: (line) => Queue.offer(lines, line)
    }, {
      permission: profile.permission,
      onUpdate: (update) =>
        Effect.andThen(
          loading ? Effect.void : options.spool.append(update.kind, update.update),
          Effect.sync(() => {
            lastUpdate = Date.now()
            const text = Acp.messageText(update)
            if (Option.isSome(text)) {
              current = (current + text.value).slice(-MAX_SUMMARY)
              return
            }
            const reported = Acp.usage(update)
            if (Option.isSome(reported)) {
              usage = {
                contextTokens: reported.value.contextTokens,
                ...(reported.value.costUsd === undefined ? {} : { costUsd: reported.value.costUsd })
              }
              return
            }
            if (current !== "") {
              previous = current
              current = ""
            }
          })
        )
    })
    const failure = (error: Acp.AcpError) =>
      error.code === "closed"
        ? ended(retry("exit") ?? failed("agent"), "exit")
        : error.code === "remote"
        ? ended(retry("error") ?? failed("refused"), "error")
        : ended(failed("agent"), "protocol")
    // A cancel from the host, a claim the host no longer holds, or the step's deadline.
    const signal = Effect.raceAll([
      Deferred.await(control.cancel).pipe(Effect.as("cancel" as const)),
      Deferred.await(control.dropped).pipe(Effect.as("dropped" as const)),
      Effect.suspend(() => Effect.sleep(Math.max(0, job.deadline - Date.now()))).pipe(Effect.as("deadline" as const))
    ])
    type Signal = "cancel" | "dropped" | "deadline"
    const isSignal = (value: unknown): value is Signal =>
      value === "cancel" || value === "dropped" || value === "deadline"
    const stopped = (cause: Signal, sessionId: string | undefined, turn: Fiber.Fiber<unknown, unknown> | undefined) =>
      Effect.gen(function*() {
        if (sessionId !== undefined) yield* client.cancel(sessionId).pipe(Effect.ignore)
        if (turn !== undefined) yield* Fiber.await(turn).pipe(Effect.timeout("30 seconds"), Effect.ignore)
        const gone = yield* Tree.stop(tree, { graceMs: 15_000, settleMs: 5000 })
        // A dropped claim settles nothing the host keeps: its settlement is fenced off.
        return cause === "deadline"
          ? ended(failed("timeout"), "deadline")
          : ended({ _tag: "Cancelled", processTreeGone: gone }, cause === "cancel" ? "cancelled" : "dropped")
      })
    const opened = yield* Effect.raceFirst(
      Effect.gen(function*() {
        const initialized = yield* client.initialize
        if (options.resume !== undefined && initialized.loadSession) {
          loading = true
          const loaded = yield* Effect.exit(client.loadSession(options.resume, checkout.dir))
          loading = false
          if (Exit.isSuccess(loaded)) return { sessionId: options.resume, text: CONTINUE }
        }
        const sessionId = yield* client.newSession(checkout.dir)
        yield* writeCheckpoint(checkout, { ...options.checkpoint, sessionId })
        return { sessionId, text: promptOf(job.task, job.generation > 1 || options.resume !== undefined) }
      }).pipe(Effect.result),
      signal
    )
    if (isSignal(opened)) return yield* stopped(opened, undefined, undefined)
    if (opened._tag === "Failure") return failure(opened.failure)
    const { sessionId, text } = opened.success
    const turn = yield* Effect.forkScoped(client.prompt(sessionId, text))
    const first = yield* Effect.raceFirst(Fiber.await(turn), signal)
    if (isSignal(first)) return yield* stopped(first, sessionId, turn)
    if (Exit.isFailure(first)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(first.cause))
      return error === undefined ? ended(failed("agent"), "exit") : failure(error)
    }
    const stop = first.value
    yield* options.spool.append(Transcript.KINDS.turn, { stopReason: stop })
    if (stop === "refusal") return ended(retry("refusal") ?? failed("agent"), stop)
    if (stop !== "end_turn") return ended(failed("agent"), stop)
    // The turn ended; the agent may still be talking. Collect once it has been quiet a while.
    const endedAt = Date.now()
    const quiet = Effect.gen(function*() {
      while (Date.now() - lastUpdate < QUIET.afterMs && Date.now() - endedAt < QUIET.maxMs) {
        yield* Effect.sleep(Math.max(10, Math.min(QUIET.afterMs - (Date.now() - lastUpdate), 1000)))
      }
    })
    const settled = yield* Effect.raceFirst(quiet.pipe(Effect.as("quiet" as const)), signal)
    if (settled !== "quiet") return yield* stopped(settled, sessionId, undefined)
    yield* Tree.stop(tree, { graceMs: 2000, settleMs: 5000 }).pipe(Effect.ignore)
    const changes = yield* Effect.exit(Workspace.changes(checkout, job.task.base, job.task.limits))
    if (Exit.isFailure(changes)) return ended(failed("workspace"), stop)
    if (changes.value === undefined) return ended(failed("too_large"), stop)
    const summary = options.scrub(current !== "" ? current : previous)
    return ended({ _tag: "Done", changes: changes.value, summary, usage }, stop)
  })
