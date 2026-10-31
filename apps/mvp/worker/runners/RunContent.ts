import { Transcript } from "@smthrs/agent"
import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { GENESIS, PAGE_BYTES, PAGE_EVENTS } from "../../src/features/transcript/contract.ts"
import { chain } from "../../src/features/transcript/digest.ts"
import type { Row } from "../../src/features/transcript/schema.ts"

// A run's transcript store (decision 0141, docs/features/agent-transcripts.md#the-store): what the run's `RunContent`
// Durable Object (worker/RunContent.ts) keeps in its own SQLite, written here over a synchronous SQL port so the same
// code runs on the object's storage and, in tests, on Node's SQLite. One object per run, so one writer: every call here
// runs inside one object event, and nothing here awaits.
//
// - `events`: each event once, by `(generation, seq)`, numbered `n` in the order it was stored, with its update as JSON.
// - `generations`: per job generation, the lowest `seq` not stored yet: what the runner sends from next.
// - `meta`: the run's totals: events, bytes, the digest chain (worker and tab compute the same,
//   src/features/transcript/digest.ts), and whether the run hit `Transcript.MAX_RUN_BYTES`.
//
// A run that reaches `Transcript.MAX_RUN_BYTES` keeps one `_smithers/truncated` event and drops every later one, still
// counting its seq as taken so the runner stops sending it. Nothing here logs an event.

/** A value SQLite binds or answers. */
export type SqlValue = string | number | null

/** The synchronous SQL a Durable Object's storage offers (`ctx.storage.sql.exec(...).toArray()`). */
export interface Sql {
  readonly exec: (query: string, ...bindings: ReadonlyArray<SqlValue>) => ReadonlyArray<Record<string, SqlValue>>
}

/** Creates the store's tables, once per object incarnation; a no-op when they exist. */
export const migrate = (sql: Sql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS events (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    generation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    received INTEGER NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (generation, seq))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS generations (generation INTEGER PRIMARY KEY, next INTEGER NOT NULL)`)
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value)`)
}

/** The run's totals: how many events and bytes it holds, the last event's `n`, and the digest chain there. */
export interface Summary {
  readonly events: number
  readonly bytes: number
  readonly last: number
  readonly digest: string
  readonly truncated: boolean
}

const metaOf = (sql: Sql): Summary => {
  const values = new Map(sql.exec(`SELECT key, value FROM meta`).map((row) => [row.key, row.value]))
  return {
    events: Number(values.get("events") ?? 0),
    bytes: Number(values.get("bytes") ?? 0),
    last: Number(values.get("last") ?? 0),
    digest: String(values.get("digest") ?? GENESIS),
    truncated: values.get("truncated") === 1,
  }
}

const putMeta = (sql: Sql, summary: Summary) => {
  for (const [key, value] of Object.entries(summary)) {
    sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key,
      typeof value === "boolean" ? (value ? 1 : 0) : value)
  }
}

/** The run's totals now. */
export const summary = (sql: Sql): Summary => metaOf(sql)

/** What one append did: the next `seq` of the generation not stored, the events it stored, and the run's totals. */
export interface Appended {
  readonly next: number
  readonly stored: ReadonlyArray<Row>
  readonly summary: Summary
}

const has = (sql: Sql, generation: number, seq: number) =>
  sql.exec(`SELECT 1 AS one FROM events WHERE generation = ? AND seq = ?`, generation, seq).length > 0

/**
 * Stores `events` of job generation `generation`, received at `now`: each `(generation, seq)` once, in seq order.
 * Answers the generation's lowest seq not stored yet, the events stored now (for the sockets), and the totals.
 */
export const append = (
  sql: Sql,
  generation: number,
  events: ReadonlyArray<Transcript.Event>,
  now: number,
): Appended => {
  let totals = metaOf(sql)
  let next = Number(sql.exec(`SELECT next FROM generations WHERE generation = ?`, generation)[0]?.next ?? 0)
  const stored: Array<Row> = []
  const store = (event: Transcript.Event, body: string) => {
    const [row] = sql.exec(
      `INSERT INTO events (generation, seq, at, received, kind, body) VALUES (?, ?, ?, ?, ?, ?) RETURNING n`,
      generation, event.seq, event.at, now, event.kind, body,
    )
    const stored_: Row = { n: Number(row!.n), generation, seq: event.seq, at: event.at, kind: event.kind, update: JSON.parse(body) }
    totals = {
      ...totals,
      events: totals.events + 1,
      bytes: totals.bytes + body.length,
      last: stored_.n,
      digest: chain(totals.digest, stored_),
    }
    stored.push(stored_)
  }
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq < next || has(sql, generation, event.seq)) continue
    if (totals.truncated) {
      // Past the run's cap: the seq is taken, the event is dropped.
      if (event.seq === next) next++
      continue
    }
    const body = JSON.stringify(event.update)
    if (totals.bytes + body.length > Transcript.MAX_RUN_BYTES) {
      store({ ...event, kind: Transcript.KINDS.truncated }, "{}")
      totals = { ...totals, truncated: true }
    } else {
      store(event, body)
    }
    if (event.seq === next) next++
  }
  while (has(sql, generation, next)) next++
  sql.exec(`INSERT INTO generations (generation, next) VALUES (?, ?)
    ON CONFLICT (generation) DO UPDATE SET next = excluded.next`, generation, next)
  putMeta(sql, totals)
  return { next, stored, summary: totals }
}

/** The events after `after`, in order: at most `PAGE_EVENTS` of them and about `PAGE_BYTES`, at least one. */
export const page = (sql: Sql, after: number): ReadonlyArray<Row> => {
  const rows = sql.exec(
    `SELECT n, generation, seq, at, kind, body FROM events WHERE n > ? ORDER BY n LIMIT ?`, after, PAGE_EVENTS,
  )
  const out: Array<Row> = []
  let bytes = 0
  for (const row of rows) {
    const body = String(row.body)
    if (out.length > 0 && bytes + body.length > PAGE_BYTES) break
    bytes += body.length
    out.push({
      n: Number(row.n),
      generation: Number(row.generation),
      seq: Number(row.seq),
      at: Number(row.at),
      kind: String(row.kind),
      update: JSON.parse(body),
    })
  }
  return out
}

/** The run's transcript could not be reached; the runner sends again. */
export class TranscriptsUnavailable extends Schema.TaggedError<TranscriptsUnavailable>()(
  "@smthrs/mvp/runners/TranscriptsUnavailable",
  {},
) {}

/**
 * The runs' transcripts, as the runner events route reaches them: `append` stores a job generation's events in run
 * `runId`'s transcript and answers what `append` above answers but the stored events. ChatApi provides it from the
 * `RunContent` namespace (worker/RunContent.ts).
 */
export class Transcripts extends Context.Service<Transcripts, {
  readonly append: (
    runId: string,
    generation: number,
    events: ReadonlyArray<Transcript.Event>,
  ) => Effect.Effect<{ readonly next: number; readonly summary: Summary }, TranscriptsUnavailable>
}>()("@smthrs/mvp/runners/Transcripts") {}
