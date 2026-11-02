import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The order every writer of a person's feed takes its locks in (docs/features/notifications.md#locks). A notice's
// rows and a role read that denies its recipient meet on one advisory lock per (repository, person): a fold, a role
// read's cleanup and the redaction pass each take every pair they may touch, sorted, de-duplicated and all at once,
// before any notification or role row. Nobody takes one later, out of order, so none can wait on another in a cycle.
// A notice of no repository is `""`'s.

/** One person's feed on one repository. */
export interface Pair {
  readonly repoId: string | null
  readonly personId: string
}

const keyOf = (pair: Pair) => `feed:${pair.repoId ?? ""}:${pair.personId}`

/** `pairs` as their lock keys, de-duplicated and sorted: the one order. */
export const keysOf = (pairs: Iterable<Pair>): ReadonlyArray<string> => [...new Set([...pairs].map(keyOf))].sort()

/**
 * Takes the locks of `pairs` for the rest of the caller's transaction, in the one order. Answers the keys it holds:
 * a writer touches only rows of a pair among them.
 */
export const lock = (sql: SqlClient.SqlClient, pairs: Iterable<Pair>) =>
  Effect.gen(function* () {
    const keys = keysOf(pairs)
    for (const key of keys) yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    return new Set(keys)
  })

/** Whether `held` (from `lock`) covers `pair`. */
export const holds = (held: ReadonlySet<string>, pair: Pair) => held.has(keyOf(pair))
