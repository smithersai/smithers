import { Action, Flow, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Config, Duration, Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ANSWER_SETTLE_WITHIN, ANSWER_TURN_WAIT } from "../../src/features/agent/contract.ts"
import { codeOf } from "../ErrorCode.vibe"
import { withAnswerConversation } from "../Messages.ts"
import * as Notifications from "../Notifications.ts"

// `chat/Expire { answerId }` (docs/features/remote-flows.md, docs/features/agent.md#settling): settles an answer whose
// run never did. A run belongs to the browser that asked (decision 0011), so an answer whose device never comes back,
// or whose run ended in a defect, would stream forever. ChatApi starts this flow when it takes a question, one
// execution per answer (`chat-expire-<answerId>`), and acknowledges the ask only once the start is recorded. Once the
// answer's queue (the answer itself, and every earlier answer in its conversation) hasn't moved for `ANSWER_EXPIRY`,
// it settles the answer `failed`, `abandoned`, only if it is still `streaming`; an answer that settled is left as it is.
// A device that comes back later finds its writes refused as settled (`AnswerSettled`).
//
// Answers come in turn, so the tail of a burst can wait longer than the expiry while every answer before it settles in
// time: its expiry counts from when the queue last moved, as its turn wait does (worker/Answers.ts), never from the
// ask. Each round sleeps on a durable timer until the expiry as things stand, then settles the answer, or, when the
// queue moved meanwhile, hands off to the next round, which waits again. No sweep: each answer's own lineage decides.
//
// It runs remotely because it must happen while every device is off (`devices-off`, `flows.local-first-placement` in
// docs/rules.md). It runs on any host; the host injects Postgres and the expiry through `registration`.

/**
 * How long an answer's queue may stay still before `chat/Expire` settles it, when `ANSWER_EXPIRY` is unset: 25
 * minutes.
 *
 * A live run must always settle first. Its turn starts when the answer before it settles, and it writes as it goes. It
 * waits at most its turn wait (`ANSWER_TURN_WAIT`, 10 minutes) while the queue before it doesn't move, then makes its
 * agent's few model calls (each at most 3 s in ChatApi's dev logs of 2026-10-20), then `chat/Settle`, which keeps
 * trying for `ANSWER_SETTLE_WITHIN` (10 minutes) while the routes are unreachable. That is about 20 minutes of
 * stillness at worst; the other 5 cover an agent ten times slower than any observed.
 */
export const DEFAULT_EXPIRY = Duration.sum(
  Duration.sum(Duration.fromInputUnsafe(ANSWER_TURN_WAIT), Duration.fromInputUnsafe(ANSWER_SETTLE_WITHIN)),
  Duration.minutes(5),
)

/** `ANSWER_EXPIRY`: a duration such as `25 minutes`, {@link DEFAULT_EXPIRY} when unset. */
export const expiry = Config.Duration("ANSWER_EXPIRY").pipe(Config.withDefault(DEFAULT_EXPIRY))

/** The execution id of `chat/Expire` for one answer: one execution per answer, so starting it again is a no-op. */
export const executionId = (answerId: string) => `chat-expire-${answerId}`

/**
 * What a round did: settled a streaming answer, found it settled already, found no such answer, or found its queue
 * moved since the round began, so it waits again in the next round.
 */
const Expired = Schema.Struct({ outcome: Schema.Literals(["abandoned", "settled", "missing", "waiting"]) })
type Expired = typeof Expired.Type

/** Postgres failed. The step retries it, and never gives up. */
export class ExpiryFailed extends Schema.TaggedError<ExpiryFailed>()("@smthrs/mvp/chat/ExpiryFailed", {
  reason: Schema.Literal("database"),
}) {}

/**
 * Expiries, by `outcome`: `abandoned`, `settled`, `missing`, `waiting` (a round that found the queue moved), `failed`
 * for one failed step, `not_started` (ChatApi).
 */
export const expiries = Metric.counter("smithers_answer_expiries", {
  description: "Answers chat/Expire settled, found settled or found still waiting their turn, by outcome",
  incremental: true,
})

const payload = { answerId: Schema.String.check(Schema.isUUID()) }

/** Only Postgres can fail a step, and an answer must not stream forever, so its retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/**
 * How long until the answer expires as things stand, in milliseconds: the expiry after its queue last moved, less the
 * time since, on Postgres' clock; 0, at once, for an answer Postgres doesn't hold. A wait, not a time, so the host's
 * clock never has to agree with Postgres'. Sealed, so a resumed round keeps it.
 */
export const ExpiresIn = Action.make("chat/ExpiresIn", {
  payload,
  success: Schema.Number,
  error: ExpiryFailed,
  capabilities: ["db:read:messages"],
  tier: "sealed",
  retryPolicy,
})

/** Settles the answer `failed`, `abandoned` if it still streams and its queue stayed still; otherwise changes nothing. */
export const Abandon = Action.make("chat/Abandon", {
  payload,
  success: Expired,
  error: ExpiryFailed,
  capabilities: ["db:write:messages"],
  retryPolicy,
})

/**
 * The most rounds one answer's expiry takes: a round ends only when the queue moved during its wait, so each one
 * spans about an expiry of a queue that keeps moving, 1,000 of them about 17 days at the default.
 */
export const MAX_ROUNDS = 1_000

type ExpireFlow = Flow.Flow<
  "chat/Expire",
  Schema.Struct<typeof payload>,
  typeof Expired,
  Schema.Union<readonly [typeof ExpiryFailed, typeof Sleep.SleepRequestInvalid]>,
  Action.Requirement<"chat/ExpiresIn"> | Action.Requirement<"chat/Abandon">
>

/** `chat/Expire`: settles an answer still streaming once its queue has been still for the expiry. */
export const Expire: ExpireFlow = Flow.make("chat/Expire", {
  description: "Settle an answer as failed, abandoned, if it is still streaming once its queue has been still long enough.",
  capabilities: ["db:read:messages", "db:write:messages"],
  modelInvocable: false,
  payload,
  success: Expired,
  error: Schema.Union([ExpiryFailed, Sleep.SleepRequestInvalid]),
  maxRounds: MAX_ROUNDS,
  body: Node.capture({}, ({ answerId }: { readonly answerId: string }) =>
    ExpiresIn.call({ answerId }).pipe(
      Node.bindPlanned(Node.capture({}, (millis) => Sleep.action.call({ millis }))),
      Node.andThen(Abandon.call({ answerId })),
      Node.branch({
        if: Node.capture({ waiting: "waiting" }, (expired: Expired) => expired.outcome === "waiting"),
        then: Node.capture({}, () => Expire.to({ answerId })),
        else: Node.capture({}, (expired) => Flow.done(expired)),
      }),
    )),
})

/** What the flow needs: Postgres, where the answers are, and how old an answer gets before it expires. */
export interface Services<E = never, R = never> {
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly expiry: Duration.Duration
}

/**
 * When an answer's queue last moved, as a SQL expression over the answer `a`: its own last write (or its ask), the
 * settle of the latest earlier answer in its conversation, or the last write of an earlier answer still streaming,
 * whichever is latest. The turn wait reads the queue the same way (worker/Answers.ts).
 */
const lastMoved = (sql: SqlClient.SqlClient) =>
  sql`GREATEST(a.updated_at,
    (SELECT e.updated_at FROM messages e
      WHERE e.conversation_id = a.conversation_id AND e.role = 'assistant' AND e.status <> 'streaming'
        AND e.position < a.position
      ORDER BY e.position DESC LIMIT 1),
    (SELECT max(e.updated_at) FROM messages e
      WHERE e.conversation_id = a.conversation_id AND e.role = 'assistant' AND e.status = 'streaming'
        AND e.position < a.position))`

/** How long until `answerId` expires as things stand, in milliseconds, against the `SqlClient` in context. */
export const expiresIn = (answerId: string, after: Duration.Duration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly ms: number }>`
      SELECT GREATEST(0, ceil(extract(epoch FROM
        ${lastMoved(sql)} + make_interval(secs => ${Duration.toSeconds(after)}) - now()) * 1000))::float8 AS ms
      FROM messages a WHERE a.id = ${answerId} AND a.role = 'assistant'`
    return row === undefined ? 0 : row.ms
  })

/**
 * Settles `answerId` as `abandoned` if it still streams and its queue has been still for `after`, against the
 * `SqlClient` in context. One statement: the check and the update read the same snapshot. In the same transaction, an
 * abandoned answer's run fails, and the feed folds it.
 */
export const abandon = (answerId: string, after: Duration.Duration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly abandoned: number; readonly found: number; readonly streaming: number }>`
      WITH target AS (
        SELECT a.id, a.status, ${lastMoved(sql)} AS moved
        FROM messages a WHERE a.id = ${answerId} AND a.role = 'assistant'
      ), settled AS (
        UPDATE messages m SET status = 'failed', failure = 'abandoned', updated_at = now()
        FROM target t
        WHERE m.id = t.id AND m.status = 'streaming'
          AND t.moved + make_interval(secs => ${Duration.toSeconds(after)}) <= now()
        RETURNING m.id
      )
      SELECT (SELECT count(*) FROM settled)::int AS abandoned, (SELECT count(*) FROM target)::int AS found,
        (SELECT count(*) FROM target WHERE status = 'streaming')::int AS streaming`
    // The run index agrees, and the people who hear of the run see it fail (worker/Notifications.ts), in this
    // transaction.
    if (row!.abandoned > 0 || row!.found === 0) {
      yield* sql`
        UPDATE runs SET status = 'failed', waiting = NULL, updated_at = now()
        WHERE id = ${answerId} AND status NOT IN ('done', 'failed')`
    }
    if (row!.abandoned > 0 || row!.found === 0 || row!.streaming === 0) {
      yield* Notifications.foldRun(answerId, undefined)
    }
    const outcome: Expired["outcome"] = row!.abandoned > 0
      ? "abandoned"
      : row!.found === 0
      ? "missing"
      : row!.streaming > 0
      ? "waiting"
      : "settled"
    return { outcome } satisfies Expired
  }).pipe((effect) => withAnswerConversation(answerId, effect))

/**
 * One step over `database`, with its records: a `chat.answer.expire` log line and span when it fails, and when it
 * decides an `outcome`, and `smithers_answer_expiries`. None carries the answer's text.
 */
const recorded = <A, E, R>(
  answerId: string,
  step: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  outcome: (value: A) => string | undefined,
) =>
  step.pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(expiries, { outcome: "failed" }), 1),
        Effect.logWarning("chat.answer.expire").pipe(
          Effect.annotateLogs({ answerId, outcome: "failed", errorCode: codeOf(error) }),
        ),
      )
    ),
    Effect.mapError(() => new ExpiryFailed({ reason: "database" })),
    Effect.tap((value) => {
      const decided = outcome(value)
      return decided === undefined ? Effect.void : Effect.andThen(
        Metric.update(Metric.withAttributes(expiries, { outcome: decided }), 1),
        Effect.logInfo("chat.answer.expire").pipe(Effect.annotateLogs({ answerId, outcome: decided })),
      )
    }),
    Effect.withSpan("chat.answer.expire", { attributes: { "smithers.chat.answer_id": answerId } }),
  )

/** How long until `answerId` expires, over `database`, with its records. */
export const observedExpiresIn = <E, R>(answerId: string, services: Services<E, R>) =>
  recorded(answerId, expiresIn(answerId, services.expiry), services.database, () => undefined)

/** Settles `answerId` if it still streams and its queue stayed still, over `database`, with its records. */
export const observedAbandon = <E, R>(answerId: string, services: Services<E, R>) =>
  recorded(answerId, abandon(answerId, services.expiry), services.database, (expired) => expired.outcome)

/** Registers `chat/Expire` with its steps, reaching Postgres through `services.database`. */
export const registration = <E, R>(services: Services<E, R>) =>
  Interpreter.layerWithImplementations(
    Expire,
    Layer.merge(
      ExpiresIn.toLayer(({ answerId }) => observedExpiresIn(answerId, services)),
      Abandon.toLayer(({ answerId }) => observedAbandon(answerId, services)),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
