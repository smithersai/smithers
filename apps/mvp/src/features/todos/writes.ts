import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { Clock, Context, Effect, Layer, Metric, Option } from "effect"
import { OutboxWrites } from "../../outbox"
import { type ChangeRequest, StackClient } from "./api"
import { type NotSentReason, notSentOf } from "./contract"
import { sends } from "./metrics"
import { type Requested, Requested as RequestedRow, type Sending, Sending as SendingRow } from "./schema"

// Changes to a stack in the device's one outbox (decision 0016 §1, decision 0002 §3). A TODO step's tab puts the change
// in the outbox (store.ts `queue`); the outbox stores it, then sends it through the `todo-op` mutation here, to ChatApi's
// stack route, with the library's backoff, across reloads, from whichever tab leads. Once the route takes it, the change
// is Requested on this device (`todo-requested`) until Electric shows what it did; nothing waits for that, so the
// outbox never holds chat's questions behind it. A refusal keeps it Not sent, with why.

/** The outbox's names for stack changes: the collection of their optimistic rows, and the mutation that sends them. */
export const SENDING = "todo-sending"
export const TODO_OP = "todo-op"

/**
 * Stack changes on this device:
 * - `sending`: changes the outbox holds, as the optimistic rows of their outbox writes; in memory, restored by the
 *   outbox;
 * - `requested`: changes the route took (`requested`) or refused (`not_sent`), kept on the device.
 */
export class StackWrites extends Context.Service<
  StackWrites,
  {
    readonly sending: Collection.Collection<Sending, string>
    readonly requested: Collection.Collection<Requested, string>
  }
>()("@smthrs/mvp/todos/StackWrites") {
  /**
   * The collections, and the outbox's `todo-op` mutation, sending through `StackClient` with the services this layer
   * was built with, added to the writes below it (`OutboxWrites.adding`). Built below chat's store, which builds the
   * outbox.
   */
  static readonly layer = Layer.effectContext(
    Effect.gen(function* () {
      const sending = yield* Collection.local<Sending, string>({ id: SENDING, schema: SendingRow, getKey: (row) => row.id })
      const requested = yield* Collection.persisted<Requested, string>({
        id: "todo-requested",
        schema: RequestedRow,
        getKey: (row) => row.id,
        // Version 3 adds repository installation refusals after retry (version 2); version 4 when the route answered
        // (decision 0124).
        schemaVersion: 4,
      })
      const context = yield* Effect.context<StackClient>()
      const mutation: Outbox.Mutation<never> = (params) => send(requested, params).pipe(Effect.provideContext(context))
      const writes = yield* OutboxWrites.adding({ collections: { [SENDING]: sending }, mutations: { [TODO_OP]: mutation } })
      return Context.make(StackWrites, StackWrites.of({ sending, requested })).pipe(Context.add(OutboxWrites, writes))
    }),
  )
}

/**
 * Keeps `row` on the device as `status`, with `reason` when Not sent and the stack's number when taken: inserted, or,
 * when a send replayed after a crash finds it there, its status replaced. The send settles only once the device stored
 * it: a store that fails sends it again (`Outbox.Retry`).
 */
export const keep = (
  requested: Collection.Collection<Requested, string>,
  row: Sending,
  status: Requested["status"],
  reason: NotSentReason | null,
  taken: number | null,
) =>
  Effect.gen(function* () {
    const { v: _, ...fields } = row
    // The route's answer, taken or refused, keeps when it came; the pre-admission receipt has none (decision 0124).
    const answeredAt = status === "requested" || reason !== null ? yield* Clock.currentTimeMillis : undefined
    const kept = yield* (Option.isNone(yield* requested.get(row.id))
      ? requested.insert({ ...fields, status, reason, taken, ...(answeredAt === undefined ? {} : { answeredAt }) })
      : requested.update(row.id, (draft) => {
        draft.status = status
        draft.reason = reason
        draft.taken = taken
        if (answeredAt === undefined) delete draft.answeredAt
        else draft.answeredAt = answeredAt
      })).pipe(Effect.orDie)
    // A record the device couldn't store would be gone at the next reload while the outbox let its write go: the send
    // is settled only once it is stored, and sent again otherwise (the route answers a repeated op as it did).
    yield* kept.persisted.pipe(Effect.mapError(() => new Outbox.Retry({})))
  })

/** The route's body for `row`. */
export const requestOf = (row: Sending): ChangeRequest =>
  row.op === "commit"
    ? {
      opId: row.id,
      op: "commit",
      title: row.title,
      prompt: row.prompt,
      acceptance: row.acceptance,
      ...(row.issue === undefined ? {} : { issue: row.issue }),
    }
    : { opId: row.id, op: row.op, number: row.number }

/**
 * Why the route refused a change for good: the code its body names, else its status. Anything else (no answer, a
 * deadline, 429, 5xx) is sent again.
 */
export const reasonOf = (status: number | undefined, code: string | undefined): NotSentReason | undefined =>
  notSentOf(code) ??
    (status === 400
      ? "invalid"
      : status === 401
      ? "authentication"
      : status === 403
      ? "forbidden"
      : status === 404
      ? "not_found"
      : status === 409
      ? "conflict"
      : status === 413
      ? "too_large"
      : undefined)

/**
 * Sends one queued change. ChatApi took it (202, or 200 for one it had): Requested, with its number, and done. A
 * refusal: Not sent with why, and never sent again. Anything else is sent again. Records the send as a span
 * `todos.send`, a log line and a count of `sends` by operation and outcome, never the text.
 */
const send = (requested: Collection.Collection<Requested, string>, { rows }: { readonly rows: ReadonlyArray<unknown> }) => {
  const row = rows[0] as Sending
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const [owner, name] = row.repo.split("/") as [string, string]
    const answer = yield* Effect.result((yield* StackClient).change(owner, name, requestOf(row)))
    const status = answer._tag === "Success" ? undefined : answer.failure.status
    const code = answer._tag === "Success" ? undefined : answer.failure.code
    const reason = answer._tag === "Success" ? undefined : reasonOf(status, code)
    const outcome = answer._tag === "Success"
      ? answer.success.txid === null ? "existing" : "taken"
      : reason === undefined
      ? "retry"
      : "refused"
    yield* Metric.update(Metric.withAttributes(sends, { op: row.op, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ outcome })
    yield* Effect.logWithLevel(answer._tag === "Success" ? "Info" : "Warn")("todos.send").pipe(
      Effect.annotateLogs({
        outcome,
        ...(status === undefined ? {} : { status }),
        ...(reason === undefined ? {} : { code: reason }),
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      }),
    )
    if (answer._tag === "Success") return yield* keep(requested, row, "requested", null, answer.success.number)
    if (reason === undefined) return yield* new Outbox.Retry(status === undefined ? {} : { status })
    yield* keep(requested, row, "not_sent", reason, null)
    return yield* new Outbox.Refused({ status: status! })
  }).pipe(
    Effect.annotateLogs({ feature: "todos", opId: row.id, op: row.op }),
    Effect.withSpan("todos.send", { attributes: { opId: row.id, op: row.op } }),
  )
}
