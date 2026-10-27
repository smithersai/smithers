import { Data, Effect, type Layer, Option } from "effect"
import { SqlClient } from "effect/sql"

// Where what GitHub says of a repository is kept for every data center (docs/features/repo.md#about): Postgres'
// `repo_about`, one row per repository (migration 0060). The row holds the last good answer and when it stops being
// fresh, and `next_read_at`, before which nobody asks GitHub: a fresh answer's end, a read in flight's claim, or the
// wait after GitHub refused. `claim` takes the next read only when it is due, in one statement, so of all the
// requests for a repository in every data center one reads GitHub and the rest answer from the row. `refusal` is
// GitHub's last refusal, kept so a burst of visitors during an outage is answered without asking again; `not_found`
// also drops the answer. `app_absent_until` remembers that the Smithers App isn't installed on the repository.
//
// The about read never fails for the store: a store that can't answer is `StoreUnavailable`, and the read goes to
// GitHub as if nothing were kept.

/** Which token a kept answer was read with. */
export type Via = "app" | "deployment" | "anonymous"

/** A refusal the row keeps. */
export type KeptRefusal = "not_found" | "rate_limited" | "github_unavailable"

/** The last good answer: `About` as JSON text, which token read it, when, and until when it is fresh. */
export interface KeptAnswer {
  readonly text: string
  readonly via: Via
  readonly readAtMs: number
  readonly freshUntilMs: number
}

/** A repository's row. Times are epoch milliseconds; `null` is none. */
export interface Kept {
  readonly answer: Option.Option<KeptAnswer>
  /** Nobody asks GitHub before this instant; `null`, a read is due now. */
  readonly nextReadAtMs: number | null
  readonly refusal: KeptRefusal | null
  readonly refusalVia?: Via
  /** The Smithers App wasn't installed on the repository when last asked; nobody asks again before this instant. */
  readonly appAbsentUntilMs: number | null
}

/** The store couldn't answer `op`: Postgres was unreachable or refused. */
export class StoreUnavailable extends Data.TaggedError("AboutStoreUnavailable")<{
  readonly op: "get" | "claim" | "keep" | "refuse" | "app_absent"
}> {}

/** The about read's store; `R` is what its effects need. */
export interface AboutStore<R = never> {
  /** `repoId`'s row; none before anyone read it. */
  readonly get: (repoId: string) => Effect.Effect<Option.Option<Kept>, StoreUnavailable, R>
  /**
   * Takes `repoId`'s next read until `untilMs`, only when it is due at `nowMs` (no row, or `next_read_at` passed):
   * `true` when this caller holds it.
   */
  readonly claim: (repoId: string, nowMs: number, untilMs: number, recoverAnonymous?: boolean) => Effect.Effect<boolean, StoreUnavailable, R>
  /** Keeps a fresh answer, due again at its `freshUntilMs`, and forgets any refusal; an older read never overwrites a newer. */
  readonly keep: (repoId: string, answer: KeptAnswer) => Effect.Effect<void, StoreUnavailable, R>
  /** Keeps GitHub's refusal with no read before `nextReadAtMs`; `not_found` also drops the answer. */
  readonly refuse: (repoId: string, refusal: KeptRefusal, nextReadAtMs: number, via?: Via) => Effect.Effect<void, StoreUnavailable, R>
  /** Remembers that the Smithers App isn't installed on `repoId`, until `untilMs`. */
  readonly appAbsent: (repoId: string, untilMs: number) => Effect.Effect<void, StoreUnavailable, R>
}

const iso = (ms: number) => new Date(ms).toISOString()

interface Row {
  readonly about: string | null
  readonly via: Via | null
  readonly readAtMs: number | null
  readonly freshUntilMs: number | null
  readonly nextReadAtMs: number | null
  readonly refusal: KeptRefusal | null
  readonly refusalVia: Via | null
  readonly appAbsentUntilMs: number | null
}

/**
 * A row as the read takes it. The table's checks keep `via` and `refusal` to their values and an answer's four columns
 * set together.
 */
const keptOf = (row: Row): Kept => ({
  answer: row.about === null
    ? Option.none()
    : Option.some({ text: row.about, via: row.via!, readAtMs: row.readAtMs!, freshUntilMs: row.freshUntilMs! }),
  nextReadAtMs: row.nextReadAtMs,
  refusal: row.refusal,
  ...(row.refusalVia === null ? {} : { refusalVia: row.refusalVia }),
  appAbsentUntilMs: row.appAbsentUntilMs,
})

/** The store over `database`: each operation opens its own Postgres client, so none is held while GitHub answers. */
export const postgres = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>): AboutStore<R> => {
  const run = <A>(op: StoreUnavailable["op"], query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    Effect.flatMap(SqlClient.SqlClient, query).pipe(
      Effect.provide(database),
      Effect.mapError(() => new StoreUnavailable({ op })),
      Effect.withSpan(`repo.about.store.${op}`),
    )
  return {
    get: (repoId) =>
      run("get", (sql) =>
        Effect.map(
          sql<Row>`
            SELECT about, via,
              (extract(epoch FROM read_at) * 1000)::float8 AS "readAtMs",
              (extract(epoch FROM fresh_until) * 1000)::float8 AS "freshUntilMs",
              (extract(epoch FROM next_read_at) * 1000)::float8 AS "nextReadAtMs",
              refusal, refusal_via AS "refusalVia",
              (extract(epoch FROM app_absent_until) * 1000)::float8 AS "appAbsentUntilMs"
            FROM repo_about WHERE repo_id = ${repoId}`,
          ([row]) => Option.map(Option.fromNullishOr(row), keptOf),
        )),
    claim: (repoId, nowMs, untilMs, recoverAnonymous = false) =>
      run("claim", (sql) =>
        Effect.map(
          sql<{ readonly repoId: string }>`
            INSERT INTO repo_about (repo_id, next_read_at) VALUES (${repoId}, ${iso(untilMs)}::timestamptz)
            ON CONFLICT (repo_id) DO UPDATE SET next_read_at = EXCLUDED.next_read_at, refusal = NULL, refusal_via = NULL
            WHERE repo_about.next_read_at IS NULL OR repo_about.next_read_at <= ${iso(nowMs)}::timestamptz
              OR (${recoverAnonymous} AND repo_about.refusal = 'rate_limited' AND
                (repo_about.refusal_via IS NULL OR repo_about.refusal_via = 'anonymous'))
            RETURNING repo_id AS "repoId"`,
          (rows) => rows.length === 1,
        )),
    keep: (repoId, answer) =>
      run("keep", (sql) =>
        sql`
          INSERT INTO repo_about (repo_id, about, via, read_at, fresh_until, next_read_at, refusal)
          VALUES (${repoId}, ${answer.text}, ${answer.via}, ${iso(answer.readAtMs)}::timestamptz,
            ${iso(answer.freshUntilMs)}::timestamptz, ${iso(answer.freshUntilMs)}::timestamptz, NULL)
          ON CONFLICT (repo_id) DO UPDATE SET about = EXCLUDED.about, via = EXCLUDED.via, read_at = EXCLUDED.read_at,
            fresh_until = EXCLUDED.fresh_until, next_read_at = EXCLUDED.next_read_at, refusal = NULL, refusal_via = NULL
          WHERE repo_about.read_at IS NULL OR repo_about.read_at <= EXCLUDED.read_at`.pipe(Effect.asVoid)),
    refuse: (repoId, refusal, nextReadAtMs, via) =>
      run("refuse", (sql) =>
        sql`
          INSERT INTO repo_about (repo_id, refusal, next_read_at, refusal_via)
          VALUES (${repoId}, ${refusal}, ${iso(nextReadAtMs)}::timestamptz, ${via ?? null})
          ON CONFLICT (repo_id) DO UPDATE SET refusal = EXCLUDED.refusal, next_read_at = EXCLUDED.next_read_at, refusal_via = EXCLUDED.refusal_via,
            about = CASE WHEN EXCLUDED.refusal = 'not_found' THEN NULL ELSE repo_about.about END,
            via = CASE WHEN EXCLUDED.refusal = 'not_found' THEN NULL ELSE repo_about.via END,
            read_at = CASE WHEN EXCLUDED.refusal = 'not_found' THEN NULL ELSE repo_about.read_at END,
            fresh_until = CASE WHEN EXCLUDED.refusal = 'not_found' THEN NULL ELSE repo_about.fresh_until END`
          .pipe(Effect.asVoid)),
    appAbsent: (repoId, untilMs) =>
      run("app_absent", (sql) =>
        sql`
          INSERT INTO repo_about (repo_id, app_absent_until) VALUES (${repoId}, ${iso(untilMs)}::timestamptz)
          ON CONFLICT (repo_id) DO UPDATE SET app_absent_until = EXCLUDED.app_absent_until`.pipe(Effect.asVoid)),
  }
}
