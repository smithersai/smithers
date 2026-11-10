/**
 * A read snapshot of engine state answers while another process holds the
 * store's write lock.
 *
 * `AgentSession.readExecution` read one run's round, wait and parents inside
 * `transaction`, a write transaction. Every health beat of every open run, in
 * every process on one project, took the engine store's write lock and the
 * process's one write permit; a run's lease heartbeat queued behind them, the
 * lease lapsed after 19 s, and the engine interrupted the run mid-step
 * (docs-sync, 2026-10-20). `readTransaction` reads one snapshot without either.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as Migrations from "../src/Migrations.vibe"

it("reads one snapshot while another connection holds the write lock; a write transaction cannot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "engine-read-lock-"))
  const filename = join(directory, "engine.db")
  // One retry keeps the refused write transaction fast: the production
  // budget backs off for about 23 s, longer than a lease tolerates.
  const store = Layer.provideMerge(DurableWriter.layer({ maxAttempts: 1 }), NodeDatabase.layer({ filename }))
  const peer = new DatabaseSync(filename)
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* Migrations.run
        const sql = yield* SqlClient.SqlClient
        yield* sql`
        INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason)
        VALUES ('run-1', 'suspended', 0, '{}', 'event')
      `
      }).pipe(Effect.provide(store))
    ))

    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.make
        // Another process's writer, as a busy project has many.
        peer.exec("BEGIN IMMEDIATE")
        const read = yield* Effect.exit(state.readTransaction(state.waiting("run-1")))
        const written = yield* Effect.exit(state.transaction(state.waiting("run-1")))
        peer.exec("ROLLBACK")
        return { read, written }
      }).pipe(Effect.provide(store))
    ))

    expect(Exit.isSuccess(observed.read)).toBe(true)
    if (Exit.isSuccess(observed.read)) {
      expect(Option.map(observed.read.value, (row) => row.reason)).toEqual(Option.some("event"))
    }
    expect(Exit.isFailure(observed.written)).toBe(true)
  } finally {
    peer.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("the memory twin's read snapshot answers what its transaction answers", async () => {
  const state = DurableEngineState.makeMemory()
  const read = await Effect.runPromise(state.readTransaction(state.waiting("absent")))
  expect(Option.isNone(read)).toBe(true)
})

it("a read snapshot that cannot begin dies with the storage failure instead of failing as the body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "engine-read-begin-"))
  const filename = join(directory, "engine.db")
  const store = Layer.provideMerge(DurableWriter.layer({ maxAttempts: 1 }), NodeDatabase.layer({ filename }))
  try {
    const read = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* Migrations.run
        const state = yield* DurableEngineState.make
        const sql = yield* SqlClient.SqlClient
        // The connection is already inside a transaction the store did not
        // open, so the snapshot's own BEGIN is refused.
        yield* sql.unsafe("BEGIN")
        const read = yield* Effect.exit(state.readTransaction(state.waiting("run-1")))
        yield* sql.unsafe("ROLLBACK")
        return read
      }).pipe(Effect.provide(store))
    ))

    expect(Exit.isFailure(read)).toBe(true)
    if (Exit.isFailure(read)) {
      expect(Cause.hasDies(read.cause)).toBe(true)
      expect(Cause.hasFails(read.cause)).toBe(false)
      expect(SqlError.isSqlError(Cause.squash(read.cause))).toBe(true)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
