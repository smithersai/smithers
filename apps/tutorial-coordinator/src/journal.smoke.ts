import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TutorialJournal, replayTutorialJournal } from "./TutorialJournal"
import type { LiveTutorialRun } from "@smthrs/rpc/LiveTutorial"

const directory = await mkdtemp(join(tmpdir(), "tutorial-journal-"))
const path = join(directory, "journal.sqlite")
const open = () => {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, playthrough INTEGER NOT NULL, key TEXT NOT NULL, plan TEXT, body TEXT NOT NULL, input TEXT NOT NULL, UNIQUE(session,playthrough,key)); CREATE TABLE IF NOT EXISTS checkpoints (run TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(run,name));")
  return db
}
const db = open()
const fresh = (runId: string): LiveTutorialRun => ({ runId, sessionId: "alice", operation: "research", phase: "queued", createdAt: 100, updatedAt: 100, events: [] })
let checks = 0
try {
  const journal = new TutorialJournal(db), run = fresh("run")
  journal.create(run, { playthrough: 0, idempotencyKey: "key" })
  const unclaimed = journal.get("alice", "run")!
  assert.equal(journal.claim(run, "owner-a"), true); checks++
  assert.throws(() => journal.claim(unclaimed, "owner-b"), /stale writer/); checks++
  assert.equal(journal.claim(journal.get("alice", "run")!, "owner-b"), false); checks++
  run.events.push({ id: "test", label: "Run tests", status: "running", startedAt: 200 }); journal.save(run)
  journal.recordCheckpoint(run, "test", JSON.stringify({ code: 0, output: "actual output" }))
  run.events[0]!.status = "completed"; run.events[0]!.finishedAt = 300
  run.tests = { command: "test", exitCode: 0, output: "actual output" }; run.phase = "completed"; journal.save(run)
  const accepted = journal.get("alice", "run")!
  assert.equal(journal.get("bob", "run"), undefined); checks++
  assert.equal(journal.verify("run"), true); checks++
  const facts = journal.history("run")
  assert.deepEqual(replayTutorialJournal(facts).state.run, accepted); checks++
  assert.equal(facts.filter(row => row.fact.kind === "step.observed").length, 2); checks++
  assert.equal(facts.filter(row => row.fact.kind === "checkpoint.recorded").length, 1); checks++
  db.exec("DELETE FROM runs; DELETE FROM checkpoints")
  const repaired = new TutorialJournal(db)
  assert.deepEqual(repaired.get("alice", "run"), accepted); checks++
  assert.equal(repaired.verify("run"), true); checks++
  assert.equal(repaired.checkpoint(repaired.get("alice", "run")!, "test"), JSON.stringify({ code: 0, output: "actual output" })); checks++

  const another = open(), other = new TutorialJournal(another)
  const stale = other.get("alice", "run")!
  accepted.result = "accepted new result"; journal.save(accepted)
  const head = journal.history("run").at(-1)!
  stale.result = "stale replacement"
  assert.throws(() => other.save(stale), /stale writer/); checks++
  assert.deepEqual(journal.history("run").at(-1), head); checks++
  assert.equal(journal.get("alice", "run")!.result, "accepted new result"); checks++
  another.close()

  const owned = journal.get("alice", "run")!
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  assert.throws(() => journal.recordCheckpoint(owned, "new", '{"ok":true}'), /disk failure/); checks++
  assert.deepEqual(journal.history("run").at(-1), head); checks++
  assert.equal(journal.checkpoint(owned, "new"), undefined); checks++
  db.exec("DROP TRIGGER fail_checkpoint")
  assert.equal(journal.verify("run"), true); checks++

  const legacy = fresh("legacy")
  legacy.phase = "completed"; legacy.result = "old progress"
  db.prepare("INSERT INTO runs(id,session,playthrough,key,body,input) VALUES(?,?,?,?,?,?)").run("legacy", "alice", 1, "legacy", JSON.stringify(legacy), JSON.stringify({ playthrough: 1, idempotencyKey: "legacy" }))
  db.prepare("INSERT INTO checkpoints(run,name,value) VALUES(?,?,?)").run("legacy", "done", '{"value":"old checkpoint"}')
  const migrated = new TutorialJournal(db)
  assert.equal(migrated.history("legacy")[0]!.fact.kind, "legacy-baseline"); checks++
  assert.deepEqual(migrated.get("alice", "legacy"), legacy); checks++
  assert.equal(migrated.checkpoint(migrated.get("alice", "legacy")!, "done"), '{"value":"old checkpoint"}'); checks++

  const original = db.prepare("SELECT body FROM tutorial_events WHERE run=? AND sequence=?").get("run", 2) as { body: string }
  const corrupted = JSON.parse(original.body); corrupted.at++
  db.prepare("UPDATE tutorial_events SET body=? WHERE run=? AND sequence=?").run(JSON.stringify(corrupted), "run", 2)
  const cached = db.prepare("SELECT body FROM runs WHERE id='run'").get() as { body: string }
  assert.throws(() => new TutorialJournal(db), /changed or missing/); checks++
  assert.deepEqual(db.prepare("SELECT body FROM runs WHERE id='run'").get(), cached); checks++
  db.prepare("UPDATE tutorial_events SET body=? WHERE run=? AND sequence=?").run(original.body, "run", 2)
  const legacyOwned = migrated.get("alice", "legacy")!
  migrated.remove(legacyOwned)
  assert.equal(migrated.get("alice", "legacy"), undefined); checks++
  assert.deepEqual(migrated.history("legacy"), []); checks++
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE run='legacy'").get() as { count: number }).count, 0); checks++
  console.log(`Tutorial journal passed ${checks} assertions: replay, cache deletion/rebuild, session scope, durable checkpoint admission, rollback, independent stale writers, legacy baseline, hash verification, scoped retention`)
} finally { db.close(); await rm(directory, { recursive: true, force: true }) }
