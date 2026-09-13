---
title: "Durability"
description: "What the score store guarantees across a restart: the rows it refuses, how a job claim stays atomic, how a long history pages, and what nothing prunes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/durability.md"
---

`SqlScoreStore.layer` runs this package's migrations when it is built and then
serves `ScoreStore` over the SQLite database supplied by
[`@smthrs/database`](https://database.smithers.sh/reference/api/). It owns three tables: `flows_scores`,
`flows_score_jobs`, and its own migration ledger `flows_scorers_migrations`.
Every write goes through that package's `DurableWriter`, which serializes writes
against the database file and retries the ones worth retrying.

## What the store refuses to persist

`ScoreStore.Observation` is the contract, and the store decodes against it and
fully encodes `meta` before the transaction opens, so a rejection never leaves a
partial row and never holds the single-writer lock. Both entry points snapshot
what they are given as they are _called_, so a caller that mutates the object
before running the returned Effect cannot change what is stored.

`flows_scores` repeats the rules a bad row could otherwise make unreadable as
SQL `CHECK` constraints, so no writer, including a hand-written `INSERT`, can
bypass them:

- `target_step_key` and `scorer_key` are non-empty. The read path requires a
  non-empty key, so a blank-keyed row would make every later `observations()`
  call for that target fail.
- `at_ms` is a non-negative integer. SQLite's REAL affinity would otherwise
  store a fractional `1.7` intact.
- A score is non-null and within `[0, 1]`, has no failure code, and an
  inconclusive row has no value, a non-empty `reason`, and one of the eight
  `ScorerErrorCode` literals. Migration `0004_require_failure_codes` backfills
  older unclassified failures as `inconclusive` before making the code
  mandatory. A migration's literal list is frozen once it ships, so adding a
  literal to `ScorerErrorCode` requires a new migration that rebuilds the
  check. The store tests write every literal through `SqlScoreStore`, so the
  two vocabularies cannot drift unnoticed.
- `metadata_json` is `NULL` or valid JSON.

The remaining rules have no useful SQL spelling and are enforced by the store
alone, before the write:

- `reason` is at most `maxReasonBytes` UTF-8 bytes and `meta` at most
  `maxMetadataBytes` encoded, measured on the redacted text the row stores.
  Producers inside this package truncate on a code-point boundary; a direct
  caller is told rather than silently trimmed. A legacy row over either bound
  still reads back, so neither is a poison vector.
- `meta` must be losslessly representable as canonical JSON, the same rule
  `Scorer.make` applies to a scorer configuration. A nested function, symbol, or
  explicit `undefined`, a non-enumerable own property, a value nested more than
  1,000 levels, or a `toJSON` member is refused by path rather than silently
  dropped or substituted. A `Date` is refused because its `toJSON` conversion
  to a string loses the original value type.
- `meta` is encoded through the same canonical JSON the scorer key uses, so key
  order is stable. Encoding happens before the transaction opens: a bare
  `JSON.stringify` inside it would run caller getters, Proxy traps, and `toJSON`
  while holding the write lock.

A read decodes every row against that same contract and names the row id in the
failure, so a hand-edited database produces an actionable error rather than an
anonymous one.

## Redaction

`reason` and `meta` are scrubbed with the journal's redaction rules
([`@smthrs/journal`](https://journal.smithers.sh/reference/api/)) before the `INSERT`, and are otherwise
stored verbatim. The store shares a database with the journal and nothing
prunes `flows_scores`, so a credential that reached a score row would outlive
every other copy of it: rows are read back by `observations()`, by eval
reports, and by gate summaries printed in CI. A scorer earns those strings from
places nobody controls, a judge client whose failure message quotes the request
it sent, or a judge whose prose quotes the agent output it graded, and the byte
bounds do not help because a bearer token or a URL with embedded credentials
fits inside the first kilobyte.

The rule set is the journal's, so both durable prose surfaces of the database
scrub the same shapes: URL credentials, `Bearer` and `Basic` values, JWTs,
private-key blocks, common API-key and token spellings, and any member whose
key names a secret. It is a best-effort net over credential shapes, not a
guarantee: a value that must never persist belongs in a `Redacted` field of the
caller's own schema rather than in a scorer reason.

A placeholder can be longer than the credential it replaces. A `reason` the
scrub grows past `maxReasonBytes` is truncated again on a code-point boundary,
because refusing it would lose exactly the diagnostic that carried the
credential. `meta` has no truncation that leaves valid JSON, so a payload the
scrub grows past `maxMetadataBytes` is refused with `invalid_observation`.

## Idempotency

`recordOnce(identity, observation)` inserts the identity into
`flows_score_jobs` with `ON CONFLICT DO NOTHING` and writes the observation
only when the claim is new, both inside one transaction. The affected-row count
is read with `DurableWriter.affectedRows`, which is dialect-agnostic and
accepts the bigint that `SqlClient.SafeIntegers` produces. Reading a driver's
own numeric `changes` instead would read that bigint as "already claimed",
commit the claim, and drop the observation on every retry.

The single-row insert may report only zero or one affected row. Zero is the
conflict path and one is a new claim; a larger count is a contradictory driver
result, so the store fails and rolls the whole transaction back.

A failure inside the transaction rolls the claim back, so the job can be
retried. A committed claim survives a process restart against the same
database file.

## Reading

`observations(targetStepKey, scorerKey?, page?)` orders by `(at_ms, id)`, with
`id` only breaking ties inside one millisecond. A read that also filters
`scorer_key` is served by the `(target_step_key, scorer_key, at_ms)` index; a
read across every scorer sorts, because the index's second column is
`scorer_key`.

It is always bounded, and every bound must be a safe integer in range or the
call fails with `invalid_request` naming the value. `page.limit` defaults to and
may not exceed `maxObservations`. `page.offset` is the cursor: `(at_ms, id)` is
a total order, so walking `offset` in steps of `limit` reaches every row,
including rows that share one millisecond. `page.before` is a time _filter_, an
exclusive upper `at` bound, and not a cursor: it walks nothing on its own, and a
page of rows sharing the last timestamp would leave the rest of that
millisecond permanently unreachable.

`aggregate` reports `count`, `mean`, and `min` over successful scores plus
`inconclusive`, the count of failures. Without that denominator a target scored
a hundred times where ninety-nine attempts were inconclusive reported exactly
what a target scored once, cleanly, reports. `mean` and `min` are `undefined`
when `count` is zero, and the whole aggregate is `undefined` only when the
target has no observations of either kind.

## Retention

Nothing prunes `flows_scores` or `flows_score_jobs`; there is no `gc` path for
them and no automatic expiry. A stored row is permanent, which is why `reason`
and `meta` are redacted on the way in rather than at each reader. A deployment that scores every step of a
long-running flow owns that growth. Both tables are keyed by strings the caller
supplies, so bounding identity and key length is the caller's job as well as
this package's.

## See also

- [Record a score exactly once](/guides/record-a-score-once/): the caller
  side of the job claim.
- [Read scores back](/guides/read-scores-back/): paging a long history and
  reading an aggregate.
- [Observations](/concepts/observations/): what each kind of row means.
