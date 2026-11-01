/** Real process death: no transaction rollback, journal drain, or connection finalization. */
import { layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.vibe"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = "process-death" as RunId
const sourceId = "driver" as SourceId
const input = (sequence: number, implicit = false) =>
  new Input({
    runId,
    sourceId,
    ...(implicit ? {} : { sourceSeq: sequence as SourceSeq }),
    eventType: `event-${sequence}`,
    payload: { sequence }
  })

const recover = (filename: string, operation: "append" | "compact", acknowledged: boolean) =>
  Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<
        { seq: number; source_id: string; source_seq: number; event_type: string; payload_json: string }
      >`
      SELECT seq, source_id, source_seq, event_type, payload_json FROM flows_journal_events ORDER BY seq
    `
      const expected = operation === "append" ? (acknowledged ? [0, 1, 2] : [0, 1]) : (acknowledged ? [2] : [0, 1, 2])
      expect(rows).toEqual(expected.map((sequence) => ({
        seq: sequence,
        source_id: sourceId,
        source_seq: sequence,
        event_type: `event-${sequence}`,
        payload_json: JSON.stringify({ sequence })
      })))

      const checkpoints = yield* sql<{ seq: number; state_json: string; compacted_at_ms: number | null }>`
      SELECT seq, state_json, compacted_at_ms FROM flows_journal_checkpoints ORDER BY seq
    `
      if (operation === "append") {
        expect(checkpoints).toEqual([])
        expect(Option.isNone(yield* journal.latestCheckpoint(runId))).toBe(true)
        if (!acknowledged) {
          const retry = yield* journal.emitDurableUnfenced(input(2))
          expect(retry).toMatchObject({ _tag: "Accepted", seq: 2, sourceSeq: 2 })
        }
      } else {
        expect(checkpoints.map((row) => row.seq)).toEqual(acknowledged ? [2] : [0, 2])
        expect(checkpoints.map((row) => JSON.parse(row.state_json))).toEqual(
          acknowledged ? [{ sequence: 2 }] : [{ sequence: 0 }, { sequence: 2 }]
        )
        expect(checkpoints.map((row) => row.compacted_at_ms)).toEqual(
          acknowledged ? [expect.any(Number)] : [null, null]
        )
        const checkpoint = Option.getOrThrow(yield* journal.latestCheckpoint(runId))
        expect(checkpoint).toMatchObject({ seq: 2, state: { sequence: 2 } })
        if (acknowledged) {
          const failure = yield* Effect.flip(journal.entries({ runId, limit: 10 }))
          expect(failure).toMatchObject({ code: "compacted", checkpointSeq: 2 })
        } else {
          expect((yield* journal.entries({ runId, limit: 10 })).entries.map((entry) => entry.seq)).toEqual([0, 1, 2])
        }
      }
      // An implicit producer sequence proves both floors were recovered from disk.
      const next = yield* journal.emitDurableUnfenced(input(3, true))
      expect(next).toMatchObject({ _tag: "Accepted", seq: 3, sourceSeq: 3 })
      const lossy = yield* journal.emitLossy(input(4, true))
      expect(lossy).toMatchObject({ _tag: "Accepted", seq: 4, sourceSeq: 4 })
      yield* journal.flush
      // Check duplicates after the cold allocation: a duplicate attempt may
      // reserve an unused in-memory run sequence, so it is not a cold-floor probe.
      const retry = yield* journal.emitDurableUnfenced(input(2))
      expect(retry).toMatchObject({ _tag: "Duplicate", seq: 2, sourceSeq: 2 })
      const page = yield* journal.entries({ runId, after: 1 as Seq, limit: 10 })
      expect(page.entries.map((entry) => [entry.seq, entry.sourceSeq])).toEqual([[2, 2], [3, 3], [4, 4]])
      expect(page.hasMore).toBe(false)
      expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }])
    }).pipe(Effect.provide(
      SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
        Layer.provideMerge(Layer.provideMerge(
          Migrations.layer,
          Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
        ))
      )
    ))
  ))

describe("SqlJournal SIGKILL recovery", () => {
  for (const operation of ["append", "compact"] as const) {
    for (const phase of ["pre-commit", "post-ack"] as const) {
      it(`${operation}: recovers after SIGKILL at ${phase}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "flows-journal-process-death-"))
        const filename = join(directory, "journal.sqlite")
        const fixture = fileURLToPath(new URL("./fixtures/recovery-child.ts", import.meta.url))
        const child = spawn(process.execPath, [fixture, filename, operation], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60_000,
          killSignal: "SIGKILL"
        })
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }))
        })
        let stdout = ""
        let stderr = ""
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk)
        })
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(`child missed ${phase}: ${stdout}\n${stderr}`)), 30_000)
            const finish = (error?: Error) => {
              clearTimeout(timer)
              if (error) reject(error)
              else resolve()
            }
            let released = false
            child.stdout.on("data", (chunk) => {
              stdout += String(chunk)
              if (phase === "post-ack" && !released && stdout.includes("pre-commit\n")) {
                released = true
                child.stdin.write("commit\n")
              }
              if (stdout.includes(`${phase}\n`)) finish()
            })
            child.once("error", finish)
            child.once(
              "exit",
              (code, signal) => finish(new Error(`child exited before ${phase} (${code}, ${signal}): ${stderr}`))
            )
          })
          expect(existsSync(`${filename}.finalized`)).toBe(false)
          expect(child.kill("SIGKILL")).toBe(true)
          expect(await closed).toEqual({ code: null, signal: "SIGKILL" })
          expect(existsSync(`${filename}.finalized`)).toBe(false)
          await recover(filename, operation, phase === "post-ack")
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
          await closed
          await rm(directory, { recursive: true, force: true })
        }
      }, 90_000)
    }
  }
})
