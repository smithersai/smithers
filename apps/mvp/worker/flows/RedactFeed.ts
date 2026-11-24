import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as FeedLocks from "../FeedLocks.ts"
import * as Flows from "../Flows.ts"

// `ops/RedactFeed` (docs/features/notifications.md#rows-written-before): one pass over the feed, after a barrier the
// deploy owner confirmed (`feed_barriers`, ops/feed-barrier/confirm.ts) once every Worker that wrote private text to
// people's feeds had drained, so no writer is left to put it back behind the cursor. Confirming a barrier starts its
// pass (`confirm`): the row, then the durable execution `redact-feed-<barrier id>`, whose host then owns its retries,
// deadlines and handoffs. A start is idempotent, so a confirmation interrupted between the row and the start is
// repeated safely, and the execution host's alarm (`dispatch`) starts any barrier whose start was never acknowledged
// (`launched_at`). No request starts a pass, and nothing here claims, fences or wakes one. The pass records
// `completed_at` at its end.
//
// A round is one batch, its own step and transaction: up to `BATCH` rows in the primary key's order from the last key,
// read without locks; then everyone those rows belong to locked as every writer of a feed locks them
// (worker/FeedLocks.ts); then, in statements of their own that see what committed before the locks, the rows rewritten
// or deleted. The round's payload is the cursor, so a pass the engine resumes goes on where it stopped. Phases:
// - `fleet`: a fleet alert says only its kind and its repository (worker/flows/FleetAlert.ts `bellTitleOf`).
// - `repo_events`: `main` and release rows name only the repository (worker/Notifications.ts `repoEventOf`).
// - `runs`: anyone's run row but the launcher's says `Agent run` and where (worker/Notifications.ts `foldRun`).
// - `denied`: a row of a repository a recorded read denies its recipient (no role, or less than a Member's) goes, as
//   `RepoRoles.remember` deletes it now; read after the lock, so a role restored meanwhile keeps it. A row a read
//   claimed before GitHub answered (`checked_at` -infinity) denies nothing.
// A row already in line is left alone, so a second pass changes nothing.

export const PHASES = ["fleet", "repo_events", "runs", "denied"] as const
export type Phase = (typeof PHASES)[number]

/** Where a pass stands: its barrier, its phase, the last key it looked at (`""`, none yet), and whether it ended. */
export const Round = Schema.Struct({
  barrier: Schema.String,
  phase: Schema.Literals(PHASES),
  recipient: Schema.String,
  subject: Schema.String,
  outcome: Schema.Literals(["going", "done", "no_barrier"]),
})
export type Round = typeof Round.Type

/** Postgres failed a batch. It retries, and never gives up. */
export class RedactUnavailable extends Schema.TaggedError<RedactUnavailable>()(
  "@smthrs/mvp/ops/RedactUnavailable",
  { reason: Schema.Literal("database") },
) {}

/** Rows a batch changed, by `phase`. */
export const redacted = Metric.counter("smithers_feed_redacted", {
  description: "Feed rows the redaction pass rewrote or deleted, by phase",
  incremental: true,
})

/** The rows one batch looks at. */
export const BATCH = 500

/** The most rounds one pass takes. */
export const MAX_ROUNDS = 100_000

/** A barrier's pass. */
export const executionIdOf = (barrier: string) => `redact-feed-${barrier}`

/** A barrier's first round. */
export const startOf = (barrier: string): Round => ({ barrier, phase: PHASES[0], recipient: "", subject: "", outcome: "going" })

const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

const capabilities = [
  "db:read:feed_barriers",
  "db:write:feed_barriers",
  "db:read:fleet_alerts",
  "db:read:runs",
  "db:read:github_repo_roles",
  "db:write:notifications",
]

/** One batch of a phase from the round's key. */
export const Batch = Action.make("ops/RedactFeedBatch", {
  payload: Round.fields,
  success: Round,
  error: RedactUnavailable,
  capabilities,
  retryPolicy,
})

/** `ops/RedactFeed`: one barrier's pass, a batch a round. */
export const RedactFeed: Flow.Flow<
  "ops/RedactFeed",
  typeof Round,
  typeof Round,
  typeof RedactUnavailable,
  Action.Requirement<"ops/RedactFeedBatch">
> = Flow.make("ops/RedactFeed", {
  description: "Bring feed rows written before into line, once the deploy owner confirmed the writers that wrote them " +
    "drained: no private text to people whose access the feed can't check, and nothing of a repository a recorded " +
    "read denies its recipient.",
  capabilities,
  modelInvocable: false,
  payload: Round.fields,
  success: Round,
  error: RedactUnavailable,
  maxRounds: MAX_ROUNDS,
  body: Node.capture({}, (round: Round) =>
    Batch.call(round).pipe(
      Node.branch({
        if: Node.capture({}, (next: Round) => next.outcome !== "going"),
        then: Node.capture({}, (next) => Flow.done(next)),
        else: Node.capture({}, (next) => RedactFeed.to(next)),
      }),
    )),
})

/** `text` cut to `max` characters with an ellipsis in the last place, as titles are cut. */
const cut = (sql: SqlClient.SqlClient, text: ReturnType<SqlClient.SqlClient["literal"]>, max: number) =>
  sql`(CASE WHEN char_length(${text}) > ${max} THEN left(${text}, ${max - 1}) || '…' ELSE ${text} END)`

const FILTER: Readonly<Record<Phase, string>> = {
  fleet: `n.kind = 'fleet'`,
  repo_events: `n.kind IN ('main', 'release') AND n.repo_id IS NOT NULL`,
  runs: `n.kind = 'run' AND NOT n.mine`,
  denied: `n.repo_id IS NOT NULL`,
}

interface Key {
  readonly recipient: string
  readonly subject: string
  readonly repoId: string | null
}

/** The batch's rows, by their keys, as a table `k (recipient, subject)`. */
const keyed = (sql: SqlClient.SqlClient, keys: ReadonlyArray<Key>) =>
  sql`SELECT * FROM jsonb_to_recordset(${JSON.stringify(keys.map(({ recipient, subject }) => ({ recipient, subject })))}::jsonb)
    AS k(recipient text, subject text)`

/** The phase's change to the rows `keys` names, after their locks: how many rows it changed. */
const change = (sql: SqlClient.SqlClient, phase: Phase, keys: ReadonlyArray<Key>) => {
  const repo = sql.literal(`regexp_replace(n.repo_id, '^github/', '')`)
  switch (phase) {
    case "fleet":
      return sql`
        WITH k AS (${keyed(sql, keys)}), target AS (
          SELECT n.recipient, n.subject, n.title AS old, ${cut(sql, sql.literal(`concat_ws(' · ', COALESCE(CASE a.kind
              WHEN 'failed' THEN 'Agent run failed'
              WHEN 'stalled' THEN 'Agent run stalled'
              WHEN 'waiting' THEN 'Agent run waiting for a runner'
              WHEN 'cost' THEN 'Agent run cost'
              WHEN 'offline' THEN 'Runner offline'
            END, 'Fleet alert'), regexp_replace(n.repo_id, '^github/', ''))`), 200)} AS title
          FROM k JOIN notifications n USING (recipient, subject) LEFT JOIN fleet_alerts a ON a.id = substr(n.subject, 7)
          WHERE n.kind = 'fleet'
        )
        UPDATE notifications n SET title = target.title, updated_at = now() FROM target
        WHERE n.recipient = target.recipient AND n.subject = target.subject AND target.old IS DISTINCT FROM target.title
        RETURNING 1`
    case "repo_events":
      return sql`
        WITH k AS (${keyed(sql, keys)}), target AS (
          SELECT n.recipient, n.subject, n.title AS old, n.actor, ${cut(sql, repo, 80)} AS title
          FROM k JOIN notifications n USING (recipient, subject)
          WHERE n.kind IN ('main', 'release') AND n.repo_id IS NOT NULL
        )
        UPDATE notifications n SET title = target.title, actor = NULL, updated_at = now() FROM target
        WHERE n.recipient = target.recipient AND n.subject = target.subject
          AND (target.old IS DISTINCT FROM target.title OR target.actor IS NOT NULL)
        RETURNING 1`
    case "runs":
      return sql`
        WITH k AS (${keyed(sql, keys)}), target AS (
          SELECT n.recipient, n.subject, n.title AS old, n.actor, ${cut(sql, sql.literal(`COALESCE((
            SELECT 'Agent run · ' || regexp_replace(b.repo_id, '^github/', '') || '/' || b.name
            FROM runs r JOIN branches b ON b.id = r.branch_id WHERE r.id = n.run_id
          ), 'Agent run')`), 80)} AS title
          FROM k JOIN notifications n USING (recipient, subject)
          WHERE n.kind = 'run' AND NOT n.mine
        )
        UPDATE notifications n SET title = target.title, actor = NULL, updated_at = now() FROM target
        WHERE n.recipient = target.recipient AND n.subject = target.subject
          AND (target.old IS DISTINCT FROM target.title OR target.actor IS NOT NULL)
        RETURNING 1`
    case "denied":
      return sql`
        WITH k AS (${keyed(sql, keys)})
        DELETE FROM notifications n USING k
        WHERE n.recipient = k.recipient AND n.subject = k.subject AND EXISTS (
          SELECT 1 FROM github_repo_roles g
          WHERE g.repo_id = n.repo_id AND g.person_id = n.recipient AND g.checked_at <> '-infinity'
            AND (g.role IS NULL OR g.role NOT IN ('member', 'maintainer', 'admin')))
        RETURNING 1`
  }
}

/**
 * One round from `round`, against the `SqlClient` in context, `size` rows at most: the phase's next key; or the next
 * phase from its start once this one has nothing left; or, after the last, the barrier's pass recorded completed and
 * `done`. Without its barrier, `no_barrier`, and nothing touched.
 */
export const batch = (round: Round, size: number = BATCH) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [barrier] = yield* sql`SELECT 1 FROM feed_barriers WHERE id = ${round.barrier}`
    if (barrier === undefined) return { ...round, outcome: "no_barrier" } satisfies Round
    const keys = yield* sql<Key>`
      SELECT n.recipient, n.subject, n.repo_id AS "repoId" FROM notifications n
      WHERE ${sql.literal(FILTER[round.phase])} AND (n.recipient, n.subject) > (${round.recipient}, ${round.subject})
      ORDER BY n.recipient, n.subject LIMIT ${size}`
    if (keys.length === 0) {
      const next = PHASES[PHASES.indexOf(round.phase) + 1]
      if (next !== undefined) return { ...round, phase: next, recipient: "", subject: "" } satisfies Round
      yield* sql`UPDATE feed_barriers SET completed_at = now() WHERE id = ${round.barrier} AND completed_at IS NULL`
      return { ...round, outcome: "done" } satisfies Round
    }
    const changed = yield* sql.withTransaction(Effect.gen(function* () {
      yield* FeedLocks.lock(sql, keys.map((key) => ({ repoId: key.repoId, personId: key.recipient })))
      return (yield* change(sql, round.phase, keys)).length
    }))
    if (changed > 0) yield* Metric.update(Metric.withAttributes(redacted, { phase: round.phase }), changed)
    // When the pass last moved, for whoever watches it.
    yield* sql`UPDATE feed_barriers SET progressed_at = now() WHERE id = ${round.barrier}`
    const last = keys[keys.length - 1]!
    return { ...round, recipient: last.recipient, subject: last.subject } satisfies Round
  })

/** The batch step over `database`, `size` rows a batch, with its `feed.redact` line and span: never who. */
export const observedBatch = <E, R>(round: Round, database: Layer.Layer<SqlClient.SqlClient, E, R>, size: number = BATCH) =>
  batch(round, size).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.logWarning("feed.redact").pipe(
        Effect.annotateLogs({ barrier: round.barrier, phase: round.phase, errorCode: codeOf(error) }),
      )
    ),
    Effect.mapError(() => new RedactUnavailable({ reason: "database" })),
    Effect.tap((next) =>
      Effect.logInfo("feed.redact").pipe(
        Effect.annotateLogs({ barrier: round.barrier, phase: next.phase, outcome: next.outcome }),
      )
    ),
    Effect.withSpan("feed.redact", { attributes: { "smithers.feed_redact.barrier": round.barrier } }),
  )

/** Registers `ops/RedactFeed` over `database`, `size` rows a batch. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, size: number = BATCH) =>
  Interpreter.layerWithImplementations(RedactFeed, Batch.toLayer((round) => observedBatch(round, database, size)))
    .pipe(Layer.provideMerge(Action.layerImplementations))

const decodeRound = (value: unknown): Round | undefined => {
  const decoded = Schema.decodeUnknownOption(Round)(value)
  return decoded._tag === "Some" ? decoded.value : undefined
}

/**
 * Records, on its barrier, the round a pass handed off to and the execution it runs as, when `intent` is a round of
 * `ops/RedactFeed`: where the pass stands. Anything else changes nothing.
 */
export const recordHandoff = (intent: { readonly flow: string; readonly executionId: string; readonly payload: unknown }) =>
  Effect.gen(function* () {
    if (intent.flow !== RedactFeed._tag) return
    const round = decodeRound(intent.payload)
    if (round === undefined) return
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE feed_barriers SET current_execution = ${intent.executionId}, current_round = ${JSON.stringify(round)}::jsonb
      WHERE id = ${round.barrier} AND completed_at IS NULL`
  })

/**
 * A host's router `start` that, once a round's own execution has its intent, records the handoff on the barrier
 * (`recordHandoff`) over `database`: what the remote host's router runs (worker/Executions.ts). A failed record is
 * logged and propagated: durable routing repeats the idempotent start and receipt before the predecessor settles.
 */
export const recordingHandoffs = <
  I extends { readonly flow: string; readonly executionId: string; readonly payload: unknown },
  E,
  R,
  DE,
  DR,
>(
  start: (intent: I) => Effect.Effect<void, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
) =>
(intent: I) =>
  start(intent).pipe(
    Effect.tap(() =>
      recordHandoff(intent).pipe(
        Effect.provide(database),
        Effect.tapCause((cause) =>
          Effect.logWarning("feed.redact").pipe(
            Effect.annotateLogs({ outcome: "handoff_unrecorded", errorCode: codeOf(Cause.squash(cause)) }),
          )
        ),
      )
    ),
  )

/** Starts of a barrier's pass, by `outcome`: `launched` (its host holds it) or `not_started`. */
export const launches = Metric.counter("smithers_feed_redact_launches", {
  description: "Feed redaction pass starts, by outcome: launched or not_started",
  incremental: true,
})

/** The most unacknowledged barriers one `dispatch` starts. */
export const DISPATCH_LIMIT = 10

/**
 * Starts barrier `barrier`'s pass as its one execution, `redact-feed-<barrier>`, through `FlowStarter`, then records
 * on the row that its host holds it (`launched_at`, kept as first written). The host owns the pass from the start on:
 * its retries, its deadlines and each round's handoff. A start the host already holds is the same pass, so repeating
 * this, from anywhere and however often, runs the pass once. The acknowledgement follows the start, never precedes it:
 * an interruption between the two leaves a barrier that reads as not started, and the repeat is harmless. Fails as the
 * start or the acknowledgement failed, counted and logged `not_started`.
 */
export const start = (barrier: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const starter = yield* Flows.FlowStarter
    yield* starter.start(RedactFeed, { executionId: executionIdOf(barrier), payload: startOf(barrier) }).pipe(
      Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
    )
    yield* sql`UPDATE feed_barriers SET launched_at = now() WHERE id = ${barrier} AND launched_at IS NULL`
    yield* Metric.update(Metric.withAttributes(launches, { outcome: "launched" }), 1)
    yield* Effect.logInfo("feed.redact").pipe(Effect.annotateLogs({ barrier, outcome: "launched" }))
  }).pipe(
    Effect.tapCause((cause) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(launches, { outcome: "not_started" }), 1),
        Effect.logWarning("feed.redact").pipe(
          Effect.annotateLogs({ barrier, outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) }),
        ),
      )
    ),
    Effect.withSpan("feed.redact.start", { attributes: { "smithers.feed_redact.barrier": barrier } }),
  )

/**
 * Confirms a feed barrier and starts its pass: the durable launch trigger. Writes the row unless it is there
 * (`written` or `existing`), then starts the pass unless its host already acknowledged it. Idempotent throughout: a
 * confirmation that failed after its row is repeated, and the repeat starts the pass the first one could not.
 */
export const confirm = (barrier: { readonly id: string; readonly release: string; readonly by: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const written = yield* sql`
      INSERT INTO feed_barriers (id, release, confirmed_by) VALUES (${barrier.id}, ${barrier.release}, ${barrier.by})
      ON CONFLICT (id) DO NOTHING RETURNING 1`
    const [open] = yield* sql`
      SELECT 1 FROM feed_barriers WHERE id = ${barrier.id} AND completed_at IS NULL AND launched_at IS NULL`
    if (open !== undefined) yield* start(barrier.id)
    return { outcome: written.length > 0 ? "written" : "existing" } as const
  })

/**
 * Starts each confirmed barrier whose start no host acknowledged (`launched_at` null, oldest first, `DISPATCH_LIMIT`
 * at most, by the partial index `feed_barriers_open`): one written straight to Postgres
 * (ops/feed-barrier/confirm.ts), or one whose confirmation was cut off before its start. What the execution host runs
 * after each of its alarms (worker/Executions.ts). It takes no claim and keeps nothing between runs: two hosts that
 * start the same barrier start the same execution. A barrier that fails to start stays unacknowledged for the next
 * alarm; nothing here fails. Answers how many it started.
 */
export const dispatch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const open = yield* sql<{ readonly id: string }>`
    SELECT id FROM feed_barriers WHERE completed_at IS NULL AND launched_at IS NULL
    ORDER BY confirmed_at, id LIMIT ${DISPATCH_LIMIT}`
  let started = 0
  for (const { id } of open) {
    if (yield* start(id).pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))) started += 1
  }
  return started
}).pipe(
  Effect.catchCause((cause) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(launches, { outcome: "not_started" }), 1),
      Effect.logError("feed.redact").pipe(
        Effect.annotateLogs({ outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) }),
        Effect.as(0),
      ),
    )
  ),
)

/** `dispatch`, under the name the execution host composes its alarm from (worker/Executions.ts). It holds no state. */
export const launcher = Effect.succeed(Effect.asVoid(dispatch))
