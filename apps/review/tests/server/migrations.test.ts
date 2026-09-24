import { expect, test } from "bun:test";
import { REVIEW_MIGRATIONS } from "../../src/server/migrations.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { sqliteD1 } from "./helpers/sqliteD1.ts";

test("the deploy baseline creates the current schema idempotently", async () => {
  const db = sqliteD1();
  for (let i = 0; i < 2; i++) await db.exec(REVIEW_MIGRATIONS[0].sql);
  for (const migration of REVIEW_MIGRATIONS.slice(1)) await db.exec(migration.sql);
  await db.prepare("INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, created_at, api_key_hash) VALUES ('s', 'r', 1, 1, 1, 1, 'key')").run();
  expect(await db.prepare("SELECT api_key_hash FROM sessions").first<{ api_key_hash: string }>()).toEqual({ api_key_hash: "key" });
  await expect(db.prepare("INSERT INTO walkthroughs (id, repo, pr, bytes, created_at, status) VALUES ('w', 'r', 1, 1, 1, 'invalid')").run()).rejects.toThrow("CHECK constraint failed");
});

test("adoption refuses a legacy schema missing required columns", async () => {
  const db = sqliteD1();
  await db.exec("CREATE TABLE repos (repo TEXT PRIMARY KEY, mode TEXT, prs_per_month INTEGER, spend_cap_usd REAL, created_at INTEGER)");
  await expect(db.exec(REVIEW_MIGRATIONS[0].sql)).rejects.toThrow("quiz");
});

test("cold requests never mutate the database schema", async () => {
  const env = await buildTestEnv();
  const original = env.DB;
  const queries: string[] = [];
  env.DB = { prepare: (query) => { queries.push(query); return original.prepare(query); }, exec: (q) => original.exec(q), batch: (s) => original.batch(s) };
  await createReviewWorker().fetch(new Request("https://review.test/missing"), env);
  expect(queries).toEqual([]);
});
