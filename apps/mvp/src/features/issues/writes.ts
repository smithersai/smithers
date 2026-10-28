import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { Clock, Context, Effect, Layer, Metric, Option, Schema } from "effect"
import { codeOf } from "../../errorCode"
import { renewalOf } from "../../flows/bearer"
import { OutboxWrites } from "../../outbox"
import { IssuesClient, WriteNotTaken, type WriteRequest } from "./api"
import { type NotSentReason, refusalOf, type WriteOp } from "./contract"
import { sends } from "./metrics"
import { Requested, Sending } from "./schema"

// Issue writes in the device's one outbox (decision 0012 §4, decision 0002 §3). A write step's tab puts the write in
// the outbox (store.ts `queue`); the outbox stores it, then sends it through the `issue-write` mutation here, to
// ChatApi's writes route, with the library's backoff, across reloads, from whichever tab leads. Once the route takes
// it, the write is Requested on this device (`issue-requested`) until GitHub's row arrives; nothing waits for that, so
// the outbox never holds chat's questions behind a write. A refusal keeps it Not sent, with why.

/** The outbox's names for issue writes: the collection of their optimistic rows, and the mutation that sends them. */
export const SENDING = "issue-sending"
export const ISSUE_WRITE = "issue-write"

/**
 * Issue writes on this device:
 * - `sending`: writes the outbox holds, as the optimistic rows of their outbox writes; in memory, restored by the outbox;
 * - `requested`: writes the route took (`requested`) or refused (`not_sent`), kept on the device.
 */
export class IssueWrites extends Context.Service<
  IssueWrites,
  {
    readonly sending: Collection.Collection<Sending, string>
    readonly requested: Collection.Collection<Requested, string>
  }
>()("@smthrs/mvp/issues/IssueWrites") {
  /**
   * The collections, and the outbox's `issue-write` mutation, sending through `IssuesClient` with the services this
   * layer was built with (`OutboxWrites`). Built below chat's store, which builds the outbox.
   */
  static readonly layer = Layer.effectContext(
    Effect.gen(function* () {
      const sending = yield* Collection.local<Sending, string>({ id: SENDING, schema: Sending, getKey: (row) => row.id })
      const requested = yield* Collection.persisted<Requested, string>({
        id: "issue-requested",
        schema: Requested,
        getKey: (row) => row.id,
        // Version 3 adds when the route answered (decision 0124).
        schemaVersion: 3,
      })
      const context = yield* Effect.context<IssuesClient>()
      const mutation: Outbox.Mutation<never> = (params) => send(requested, params).pipe(Effect.provideContext(context))
      // Added to the writes a layer below handed over (co-editing's), never in their place.
      const writes = yield* OutboxWrites.adding({
        collections: { [SENDING]: sending },
        mutations: { [ISSUE_WRITE]: mutation },
        parked: { [ISSUE_WRITE]: (write) => keepParked(requested, write) },
      })
      return Context.make(IssueWrites, IssueWrites.of({ sending, requested })).pipe(Context.add(OutboxWrites, writes))
    }),
  )
}

/**
 * Keeps `row` on the device as `status`, with `reason` when Not sent: inserted, or, when a send replayed after a crash
 * finds it there, its status replaced. Waits until the device stored it; a failed store keeps the outbox retryable.
 */
export const keep = (
  requested: Collection.Collection<Requested, string>,
  row: Sending,
  status: Requested["status"],
  reason: NotSentReason | null,
) =>
  Effect.gen(function* () {
    // The route's answer, taken or refused, keeps when it came; the pre-admission receipt has none (decision 0124).
    const answeredAt = status === "requested" || reason !== null ? yield* Clock.currentTimeMillis : undefined
    return yield* storeRow(requested, row, status, reason, answeredAt)
  }).pipe(Effect.mapError(() => new Outbox.Retry({})))

/** `keep`, failing with what the device's store failed with. */
const storeRow = (
  requested: Collection.Collection<Requested, string>,
  row: Sending,
  status: Requested["status"],
  reason: NotSentReason | null,
  answeredAt?: number,
) =>
  Effect.gen(function* () {
    const kept = Option.isNone(yield* requested.get(row.id))
      ? yield* requested.insert({
        id: row.id,
        repo: row.repo,
        repoId: row.repoId,
        op: row.op,
        title: row.title,
        number: row.number,
        body: row.body,
        ...(row.decision === undefined ? {} : { decision: row.decision }),
        ...(row.commitment === undefined ? {} : { commitment: row.commitment }),
        ...(row.dailyTokens === undefined ? {} : { dailyTokens: row.dailyTokens }),
        queuedAt: row.queuedAt,
        status,
        reason,
        ...(answeredAt === undefined ? {} : { answeredAt }),
      })
      : yield* requested.update(row.id, (draft) => {
        draft.status = status
        draft.reason = reason
        if (answeredAt === undefined) delete draft.answeredAt
        else draft.answeredAt = answeredAt
      })
    yield* kept.persisted
  })

/** What a parked write's row must still say to show as Not sent: its id, repository, operation and text. */
const ParkedWrite = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  repoId: Schema.String,
  op: Sending.fields.op,
  title: Schema.String,
  number: Schema.Number,
  body: Schema.String,
  queuedAt: Schema.Number,
})

/**
 * Shows a write the outbox parked (decision 0021 §4), one an older build stored that this build can't send as it
 * meant, as Not sent (`not_allowed`), which Edit and Discard act on: true once it is kept, false when its row doesn't
 * say enough to show, so it stays parked.
 */
export const keepParked = (requested: Collection.Collection<Requested, string>, write: Outbox.Parked) =>
  Effect.gen(function* () {
    const row = Schema.decodeUnknownOption(ParkedWrite)(write.rows[0])
    if (Option.isNone(row)) return false
    const kept = yield* Effect.result(storeRow(requested, { ...row.value, v: 3 }, "not_sent", "not_allowed"))
    if (kept._tag === "Failure") {
      // The device couldn't store it, so it stays parked and doesn't show; the outbox offers it again next load.
      yield* Effect.logWarning("issues.write.parked.keep").pipe(Effect.annotateLogs({
        feature: "issues",
        outcome: "not_kept",
        errorCode: codeOf(kept.failure),
        writeId: row.value.id,
        op: row.value.op,
      }))
      return false
    }
    yield* Effect.logWarning("issue write parked").pipe(
      Effect.annotateLogs({ feature: "issues", reason: write.reason, writeId: row.value.id, op: row.value.op }),
    )
    return true
  })

/**
 * A write the outbox holds: any operation but a merge, which a person's press sends at once in their own session and
 * the device never queues (docs/features/pulls.md#merge).
 */
type Queued = Sending & { readonly op: Exclude<WriteOp, "pr/merge"> }

/** The route's body for `row`. It names nobody: who acts is the session's or the run credential's to say. */
export const requestOf = (row: Queued): WriteRequest => {
  const { id: writeId } = row
  switch (row.op) {
    case "issue/commitment":
      return { writeId, op: row.op, number: row.number, commitment: row.commitment! }
    case "issue/create":
      return { writeId, op: row.op, title: row.title, body: row.body }
    case "issue/comment":
      return { writeId, op: row.op, number: row.number, body: row.body }
    case "issue/triage":
      return {
        writeId,
        op: row.op,
        number: row.number,
        // The step sets a decision on every `issue/triage` write (steps.ts).
        decision: row.decision!,
        ...(row.body === "" ? {} : { reason: row.body }),
      }
    case "triage/run":
      return { writeId, op: row.op, number: row.number }
    case "triage/enable":
      return { writeId, op: row.op, ...(row.dailyTokens === undefined ? {} : { dailyTokens: row.dailyTokens }) }
    case "triage/pause":
      return { writeId, op: row.op }
  }
}

/**
 * Sends one queued write, as the run that wrote it when it carries that run's credential, else in the person's
 * session. ChatApi took it (202, or 200 for one it had): Requested, and done. A refusal (400, 401, 403,
 * 404, 409, 413): Not sent with why, and never sent again. Anything else (no answer, a deadline, 429, 5xx) is sent
 * again. Records the send as a span `issues.write.send`, a log line and a count of `sends` by operation and outcome,
 * never the text.
 */
const send = (requested: Collection.Collection<Requested, string>, { rows }: { readonly rows: ReadonlyArray<unknown> }) => {
  const decoded = Schema.decodeUnknownOption(Sending)(rows[0])
  if (Option.isNone(decoded) || decoded.value.op === "pr/merge" ||
    !/^[^/]+\/[^/]+$/.test(decoded.value.repo) ||
    (decoded.value.op === "issue/triage" && decoded.value.decision === undefined) ||
    (decoded.value.op === "issue/commitment" && decoded.value.commitment === undefined)) {
    return Effect.gen(function* () {
      yield* Metric.update(Metric.withAttributes(sends, { op: "invalid", outcome: "refused" }), 1)
      yield* Effect.logWarning("issues.write.invalid").pipe(Effect.annotateLogs({ feature: "issues", outcome: "refused" }))
      return yield* new Outbox.Refused({ status: 400 })
    }).pipe(Effect.withSpan("issues.write.send", { attributes: { outcome: "refused" } }))
  }
  const row = decoded.value as Queued
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const [owner, name] = row.repo.split("/") as [string, string]
    // Restored opaque credentials cannot recover their authority: retain the shared forbidden refusal.
    const answer = yield* Effect.result(row.credential !== undefined && Option.isNone(renewalOf(row.credential))
      ? Effect.fail(new WriteNotTaken({ status: 403 }))
      : (yield* IssuesClient).write(owner, name, requestOf(row), row.credential))
    const status = answer._tag === "Success" ? undefined : answer.failure.status
    const reason = answer._tag === "Success" ? undefined : refusalOf(status, answer.failure.code)
    const outcome = answer._tag === "Success"
      ? answer.success.txid === null ? "existing" : "started"
      : reason === undefined
      ? "retry"
      : "refused"
    yield* Metric.update(Metric.withAttributes(sends, { op: row.op, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ outcome })
    yield* Effect.logWithLevel(answer._tag === "Success" ? "Info" : "Warn")("issues.write.send").pipe(
      Effect.annotateLogs({
        outcome,
        ...(status === undefined ? {} : { status }),
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      }),
    )
    if (answer._tag === "Success") return yield* keep(requested, row, "requested", null)
    if (reason === undefined) return yield* new Outbox.Retry(status === undefined ? {} : { status })
    yield* keep(requested, row, "not_sent", reason)
    return yield* new Outbox.Refused({ status: status! })
  }).pipe(
    Effect.annotateLogs({ feature: "issues", writeId: row.id, op: row.op }),
    Effect.withSpan("issues.write.send", { attributes: { writeId: row.id, op: row.op } }),
  )
}
