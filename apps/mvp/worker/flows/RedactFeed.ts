import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Effect, Layer, Metric, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as FeedLocks from "../FeedLocks.ts"
import * as Flows from "#vibelang/emitted/worker/Flows"

// `ops/RedactFeed` (docs/features/notifications.md#rows-written-before): one pass over the feed, after a barrier the
// deploy owner confirmed (`feed_barriers`, ops/feed-barrier/confirm.ts) once every Worker that wrote private text to
// people's feeds had drained, so no writer is left to put it back behind the cursor. The barrier row is the durable
// request to run it: ChatApi's requests and each `FlowExecution` alarm claim it (`launch`) and start
// `redact-feed-<barrier id>` once, and again only if it stalls; the pass records `completed_at` at its end.
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
    // The pass is moving: no claim wakes it again while it does.
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
 * `ops/RedactFeed`: where a claim wakes a stalled pass. Anything else changes nothing.
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

/** Launches the claims made, by `outcome`: `launched` (a first start), `woken` (a stalled pass), `not_started`. */
export const launches = Metric.counter("smithers_feed_redact_launches", {
  description: "Feed redaction pass starts, by outcome: launched, woken or not_started",
  incremental: true,
})

/** How long a launched pass may go without a batch before a claim wakes it again. */
export const STALL_SECONDS = 15 * 60

/** How often one isolate claims: ChatApi's requests and the alarms each look at most this often. */
export const LOOK_EVERY_MS = 60_000

/**
 * Claims, in one statement, the barriers whose pass was never launched, or whose last claim and last batch are both
 * older than `STALL_SECONDS`
 * (`feed_barriers_open`), skipping any another isolate is claiming, and marks them launched; then starts each one's
 * pass. A host accepts a start of an execution it already has and wakes it, so a start is made only under a claim:
 * once for a new barrier (`launched`), and again only for a stalled one (`woken`). A start that fails gives its claim
 * back, fenced by the claim's token, so it never undoes a newer claimant's. Any failure is counted and logged, never the request's.
 */
export const launch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // The newer of the last claim and the last batch: a claim renews it as a batch does (greatest() skips a null).
  const claimed = yield* sql<{
    readonly id: string
    readonly before: string | null
    readonly token: string
    readonly currentExecution: string | null
    readonly currentRound: unknown
  }>`
    UPDATE feed_barriers b SET launched_at = now(), launch_token = gen_random_uuid()
    FROM (
      SELECT id, launched_at FROM feed_barriers
      WHERE completed_at IS NULL
        AND (launched_at IS NULL OR greatest(launched_at, progressed_at) < now() - make_interval(secs => ${STALL_SECONDS}))
      ORDER BY confirmed_at, id LIMIT 10 FOR UPDATE SKIP LOCKED
    ) AS open
    WHERE b.id = open.id
    RETURNING b.id, open.launched_at::text AS before, b.launch_token::text AS token,
      b.current_execution AS "currentExecution", b.current_round AS "currentRound"`
  const starter = yield* Flows.FlowStarter
  for (const { id, before, token, currentExecution, currentRound } of claimed) {
    const outcome = before === null ? "launched" : "woken"
    // The round the pass is on: each round hands off to its own execution (`.to()`), so a stalled pass is woken at the
    // last one its handoffs recorded (`recordingHandoffs`), with that round's own intent; before any, the first.
    const round = currentExecution === null ? undefined : decodeRound(currentRound)
    const target = round === undefined
      ? { executionId: executionIdOf(id), payload: startOf(id) }
      : { executionId: currentExecution!, payload: round }
    const started = yield* starter.start(RedactFeed, target).pipe(
      // A start the host already holds is the same pass: it is running, or now woken.
      Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.andThen(
          // Only this claim's own: a newer claimant's stands.
          sql`UPDATE feed_barriers SET launched_at = ${before}::timestamptz, launch_token = NULL
            WHERE id = ${id} AND launch_token = ${token}::uuid`.pipe(Effect.ignore),
          Effect.logWarning("feed.redact").pipe(
            Effect.annotateLogs({ barrier: id, outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) }),
            Effect.as(false),
          ),
        )
      ),
    )
    yield* Metric.update(Metric.withAttributes(launches, { outcome: started ? outcome : "not_started" }), 1)
    if (started) yield* Effect.logInfo("feed.redact").pipe(Effect.annotateLogs({ barrier: id, outcome }))
  }
  return claimed.length
})

/**
 * `launch`, at most once every `LOOK_EVERY_MS` in this isolate, and never failing: what ChatApi runs on its requests
 * and each `FlowExecution` alarm runs once it is done, so a barrier confirmed while nothing else runs starts with the
 * next request.
 */
export const launcher = Effect.map(Ref.make<number | undefined>(undefined), (looked) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const last = yield* Ref.get(looked)
    if (last !== undefined && now - last < LOOK_EVERY_MS) return
    yield* Ref.set(looked, now)
    yield* launch
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(launches, { outcome: "not_started" }), 1),
        Effect.logError("feed.redact").pipe(Effect.annotateLogs({ outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) })),
      )
    ),
  ))

