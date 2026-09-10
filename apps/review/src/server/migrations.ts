import type { D1Database } from "./d1.ts";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS repos (
    repo TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    quiz TEXT NOT NULL DEFAULT 'auto',
    prs_per_month INTEGER NOT NULL,
    spend_cap_usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    hash TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    repos_json TEXT NOT NULL,
    spend_cap_usd REAL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    spend_cap_usd REAL NOT NULL,
    spent_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_events_repo_idx ON usage_events(repo, created_at)`,
  `CREATE TABLE IF NOT EXISTS usage_totals (
    repo TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, model)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_reservations (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    session_hash TEXT,
    cost_usd REAL NOT NULL CHECK (cost_usd > 0),
    created_at INTEGER NOT NULL,
    settlement_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS usage_reservations_repo_idx ON usage_reservations(repo)`,
  `CREATE INDEX IF NOT EXISTS usage_reservations_session_idx ON usage_reservations(session_hash)`,
  `CREATE TABLE IF NOT EXISTS reviewed_prs (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    month TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (repo, pr, month)
  )`,
  `CREATE INDEX IF NOT EXISTS reviewed_prs_month_idx ON reviewed_prs(repo, month)`,
  `CREATE TABLE IF NOT EXISTS walkthroughs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    session_hash TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS walkthroughs_repo_idx ON walkthroughs(repo, created_at)`,
  `CREATE INDEX IF NOT EXISTS walkthroughs_session_hash_idx ON walkthroughs(session_hash)`,
];

const ensured = new WeakSet<D1Database>();

/**
 * Idempotently create the worker's tables. Cheap enough to run on first
 * request and guarded per worker instance so a hot worker only pays the round
 * trips once. Each CREATE is its own prepare().run() because real D1 exec()
 * requires one statement per line.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ensured.has(db)) return;
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
  // Additive columns for databases created before the column existed; SQLite
  // has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error means done.
  // Any OTHER error (transient D1 failure, locked db) must propagate so it does
  // not get mistaken for "migrated" — otherwise later SELECTs of the missing
  // column fail far from the cause, and ensured.add() below would make the
  // half-applied schema sticky for the life of this worker instance.
  await addColumnIfMissing(db, `ALTER TABLE repos ADD COLUMN quiz TEXT NOT NULL DEFAULT 'auto'`);
  await addColumnIfMissing(db, `ALTER TABLE api_keys ADD COLUMN spend_cap_usd REAL`);
  await addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN api_key_hash TEXT`);
  await addColumnIfMissing(db, `ALTER TABLE usage_events ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`);
  await addColumnIfMissing(db, `ALTER TABLE usage_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
  await addColumnIfMissing(db, `ALTER TABLE walkthroughs ADD COLUMN status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete'))`);
  // Backfill the per-(repo, model) rollup from the event log exactly once: a
  // database that already has totals (from a previous backfill or from
  // settlements) must not be double counted. One statement, so a concurrent
  // worker instance sees either an empty or a fully populated table.
  await db
    .prepare(
      `INSERT OR IGNORE INTO usage_totals (repo, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
      SELECT repo, model, SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens), SUM(cost_usd)
      FROM usage_events WHERE NOT EXISTS (SELECT 1 FROM usage_totals) GROUP BY repo, model`,
    )
    .run();
  ensured.add(db);
}

async function addColumnIfMissing(db: D1Database, alter: string): Promise<void> {
  try {
    await db.prepare(alter).run();
  } catch (err) {
    // D1/SQLite reports "duplicate column name: <col>"; the message can also be
    // nested in the error's cause. Anything else is a real failure — rethrow.
    const message = `${String(err)} ${String((err as { cause?: { message?: unknown } })?.cause?.message ?? "")}`;
    if (!/duplicate column/i.test(message)) throw err;
  }
}
