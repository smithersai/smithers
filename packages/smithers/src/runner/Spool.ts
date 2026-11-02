/**
 * One job's transcript spool on the runner: every event the agent sent, kept
 * on the runner's disk until the host has it.
 *
 * {@link open} reads the job's spool file, `<stateDir>/spool/<key hash>.jsonl`
 * (mode `0600`), so a runner that restarted sends again what the host never
 * acknowledged and numbers new events after the last one it wrote. `append`
 * makes an update safe and small (`Transcript.prepare`), numbers it, writes it
 * to the file and wakes the uploader. `upload` sends the unacknowledged events
 * while the agent works: a batch of at most `Transcript.MAX_BATCH_BYTES`, at
 * most once a second unless a full batch is still waiting, so a backlog after
 * an outage catches up at once. The host answers the next `seq` it lacks; the
 * spool drops everything below it and sends again from there. `drain` sends
 * whatever is left once the agent is done; `runner/Transcript` journals it and
 * the engine retries it while the host can't be reached.
 *
 * The spool holds at most `Transcript.MAX_RUN_BYTES` of a job's events; past
 * that it writes one `_smithers/truncated` event and keeps nothing more.
 * Nothing here logs an event: keys, counts, sequence numbers and codes only.
 *
 * @since 1.0.0
 */

import * as Transcript from "@smthrs/agent/Transcript"
import { Clock, Effect, Option, Queue, Schema, type Scope } from "effect"
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import * as Host from "./Host.ts"

/**
 * The host couldn't be reached to take the job's events; the engine retries.
 *
 * @category errors
 * @since 1.0.0
 */
export class TranscriptUnavailable extends Schema.TaggedError<TranscriptUnavailable>()(
  "@smthrs/cli/Runner/TranscriptUnavailable",
  {}
) {}

/**
 * How a drain ended: every event `sent`, or `refused` by the host (it no
 * longer knows the job, or this runner), which no retry changes.
 *
 * @category models
 * @since 1.0.0
 */
export type Drained = "sent" | "refused"

/**
 * One job's spool.
 *
 * @category models
 * @since 1.0.0
 */
export interface Spool {
  /** Adds one update of `kind`, scrubbed and bounded, as one or more numbered events. */
  readonly append: (kind: string, update: Readonly<Record<string, unknown>>) => Effect.Effect<void>
  /** Sends events as they come, until interrupted. A host that refuses the job ends it. */
  readonly upload: Effect.Effect<void, never, Host.Host>
  /** Sends every event left; fails {@link TranscriptUnavailable} while the host can't be reached. */
  readonly drain: Effect.Effect<Drained, TranscriptUnavailable, Host.Host>
  /** The last event's kind, if any: whether the session's end is already written. */
  readonly lastKind: Option.Option<string>
  /** Deletes the spool file. */
  readonly remove: Effect.Effect<void>
}

/**
 * The spool file of job `key` under `stateDir`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fileOf = (stateDir: string, key: string): string =>
  join(stateDir, "spool", `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.jsonl`)

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Transcript.Event))
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** Room in a batch for the request's own fields. */
const ENVELOPE_BYTES = 1024

/**
 * Opens job `key`'s spool under `stateDir`, uploading under `claim` and
 * scrubbing every string with `scrub`. Lines a crash left torn are skipped.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = (options: {
  readonly stateDir: string
  readonly key: string
  readonly claim: string
  readonly scrub: (text: string) => string
  /**
   * Until when (epoch ms) events the host refuses for want of authorization
   * are kept to send again (decision 0148); past it they are refused, as the
   * host has ended the job itself. Always, unless set.
   */
  readonly keepUnauthorizedUntil?: number
}): Effect.Effect<Spool, never, Scope.Scope> =>
  Effect.gen(function*() {
    const file = fileOf(options.stateDir, options.key)
    mkdirSync(join(options.stateDir, "spool"), { recursive: true, mode: 0o700 })
    const kept: Array<Transcript.Event> = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").flatMap((line) => Option.toArray(decodeLine(line)))
      : []
    const pending: Array<{ readonly event: Transcript.Event; readonly bytes: number }> = kept.map((event) => ({
      event,
      bytes: bytesOf(event)
    }))
    let next = kept.length === 0 ? 0 : kept[kept.length - 1]!.seq + 1
    let lastKind = Option.fromNullishOr(kept[kept.length - 1]?.kind)
    let spooled = pending.reduce((sum, item) => sum + item.bytes, 0)
    let truncated = Option.getOrUndefined(lastKind) === Transcript.KINDS.truncated
    const wake = yield* Queue.sliding<void>(1)
    // One descriptor for the spool's life, opened `0600`; the scope that opened the spool closes it.
    const fd = yield* Effect.acquireRelease(
      Effect.sync(() => openSync(file, "a", 0o600)),
      (descriptor) => Effect.sync(() => closeSync(descriptor))
    )

    const write = (kind: string, update: Record<string, unknown>, at: number) => {
      const event: Transcript.Event = { seq: next, at, kind, update }
      const line = JSON.stringify(event)
      const size = Buffer.byteLength(line)
      writeSync(fd, `${line}\n`)
      next++
      spooled += size
      lastKind = Option.some(kind)
      pending.push({ event, bytes: size })
    }

    const append = (kind: string, update: Readonly<Record<string, unknown>>) =>
      Effect.gen(function*() {
        if (truncated) return
        const at = yield* Clock.currentTimeMillis
        for (const piece of Transcript.prepare(kind, update, options.scrub)) {
          if (spooled + bytesOf(piece) > Transcript.MAX_RUN_BYTES) {
            write(Transcript.KINDS.truncated, {}, at)
            truncated = true
            break
          }
          write(piece.kind, piece.update, at)
        }
        yield* Queue.offer(wake, undefined)
      })

    /** The oldest unacknowledged events that fit one request, and whether more wait behind them. */
    const batch = () => {
      const events: Array<Transcript.Event> = []
      let size = ENVELOPE_BYTES
      for (const item of pending) {
        if (events.length > 0 && size + item.bytes + 1 > Transcript.MAX_BATCH_BYTES) break
        events.push(item.event)
        size += item.bytes + 1
      }
      return { events, more: events.length < pending.length }
    }

    /** Sends one batch: whether the host took it, couldn't be reached, or refused the job. */
    const send = Effect.gen(function*() {
      const host = yield* Host.Host
      const { events, more } = batch()
      if (events.length === 0) return "sent" as const
      const answer = yield* Effect.result(host.events({ key: options.key, claim: options.claim, events }))
      if (answer._tag === "Failure") {
        yield* Effect.logWarning("runner.events").pipe(
          Effect.annotateLogs({ job: options.key, outcome: answer.failure.code, pending: pending.length })
        )
        // A host that refuses this runner for want of authorization or authentication (decision 0148) may take the
        // events once it is registered again: kept, as for a host that can't be reached.
        return answer.failure.code === "unavailable" ||
            (Host.authorizationLost(answer.failure) &&
              Date.now() < (options.keepUnauthorizedUntil ?? Number.POSITIVE_INFINITY))
          ? "unavailable" as const
          : "refused" as const
      }
      const acked = answer.success.next
      while (pending.length > 0 && pending[0]!.event.seq < acked) pending.shift()
      yield* Effect.logDebug("runner.events").pipe(
        Effect.annotateLogs({ job: options.key, outcome: "sent", sent: events.length, next: acked, more })
      )
      return more ? "more" as const : "sent" as const
    })

    const upload = Effect.gen(function*() {
      let lastPost = 0
      let backoff = 1000
      while (true) {
        if (pending.length === 0) yield* Queue.take(wake)
        const now = yield* Clock.currentTimeMillis
        const full = pending.reduce((sum, item) => sum + item.bytes, 0) >= Transcript.MAX_BATCH_BYTES
        if (!full && now - lastPost < 1000) yield* Effect.sleep(1000 - (now - lastPost))
        lastPost = yield* Clock.currentTimeMillis
        const sent = yield* send
        if (sent === "refused") return
        if (sent === "unavailable") {
          yield* Effect.sleep(backoff)
          backoff = Math.min(8000, backoff * 2)
          continue
        }
        backoff = 1000
      }
    })

    const drain = Effect.gen(function*() {
      while (pending.length > 0) {
        const sent = yield* send
        if (sent === "refused") return "refused" as const
        if (sent === "unavailable") return yield* new TranscriptUnavailable()
      }
      return "sent" as const
    })

    return {
      append,
      upload,
      drain,
      get lastKind() {
        return lastKind
      },
      remove: Effect.sync(() => rmSync(file, { force: true }))
    }
  })
