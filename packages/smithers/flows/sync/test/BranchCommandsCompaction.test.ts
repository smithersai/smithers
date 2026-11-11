/**
 * Admission onto a branch run whose history a host has compacted.
 *
 * A process with no in-memory state for a branch (a restart, or an idle
 * eviction) hydrates it from the journal. Once the run is compacted, a read
 * from the start of history fails with `compacted`, and that refusal must
 * not make the branch unwritable.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Redacted } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"

const branchId = "compacted-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const alice = "alice" as BranchProtocol.ParticipantId
const owner = { hostId: "compactor", pid: 42, nonce: "branch-compactor" }
const floor = 1 as JournalEvent.Seq

const storage = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(JournalMigrations.layer, TestDatabase.layer))
)
const shareLayer = BranchShare.layerHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make("compaction-secret-0123456789abcd") }]
})

describe("BranchCommands on a compacted branch run", () => {
  it.live("admits, deduplicates and resolves conflicts after a restart above the compaction floor", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const sql = yield* SqlClient.SqlClient
      const share = yield* BranchShare.BranchShare
      const capability = yield* share.mint({
        branchId,
        capabilityId: "compaction-capability",
        access: "write",
        ttlMs: 600_000
      })
      const submitTo = (commands: BranchCommands.Service, id: string, args = "") =>
        Effect.flatMap(
          BranchCommands.submission({
            branchId,
            commandId: id as BranchProtocol.CommandId,
            participantId: alice,
            name: BranchProtocol.SayCommand,
            args
          }),
          (submission) => commands.submit({ capability, submission })
        )

      const beforeRestart = yield* BranchCommands.makeLive
      for (const id of ["c0", "c1", "c2"]) yield* submitTo(beforeRestart, id)
      // Only the ownership lease is fixture data: checkpoint and compaction go
      // through the production fenced journal APIs.
      yield* sql`
        INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
        VALUES (${runId}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0)
      `
      yield* journal.checkpoint({ runId, seq: floor, state: { commands: 2 } }, owner)
      yield* journal.compact({ runId, upTo: floor }, owner)
      const fromStart = yield* journal.entries({ runId, limit: 10 }).pipe(Effect.flip)
      expect(fromStart).toMatchObject({ code: "compacted", checkpointSeq: floor })

      // A fresh ledger is what a restart or an idle eviction leaves behind.
      // Capacity 1 forces the conflict path into its whole-history read.
      const afterRestart = yield* BranchCommands.makeLiveWith({ ledgerCapacity: 1 })
      const fresh = yield* submitTo(afterRestart, "c3")
      // Same command id, different content: the journal reports a conflict,
      // and the command it collides with sits at the floor, evicted from the
      // ledger, so only the whole-history read from the floor finds it.
      const conflicting = yield* submitTo(afterRestart, "c1", "changed")
      // Below the floor the entry is gone; the journal's retained producer
      // identity still answers an exact retransmission.
      const retransmitted = yield* submitTo(afterRestart, "c0")
      const tail = yield* journal.entries({ runId, after: floor, limit: 10 })

      expect(fresh).toMatchObject({ status: "admitted", seq: 3 })
      expect(conflicting).toMatchObject({ status: "duplicate", seq: 1 })
      expect(retransmitted).toMatchObject({ status: "duplicate", seq: 0 })
      expect(tail.entries.map((entry) => entry.seq)).toEqual([2, 3])
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(storage, shareLayer))))

  // The floor is where the walk resumes, so it must lie above the cursor. A
  // journal that keeps refusing the cursor it just resumed from would hold the
  // branch's admission permit in a loop that never reads an entry.
  it.effect("fails a walk whose compaction refusal does not move the cursor", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      let reads = 0
      const stuck = Journal.make({
        ...journal,
        entries: () => {
          reads += 1
          return Effect.fail(
            new Journal.JournalError({ code: "compacted", message: "compacted", checkpointSeq: 0 as JournalEvent.Seq })
          )
        }
      })
      const commands = yield* BranchCommands.makeLive.pipe(Effect.provideService(Journal.Journal, stuck))
      const share = yield* BranchShare.BranchShare
      const failure = yield* commands.submit({
        capability: yield* share.mint({ branchId, capabilityId: "stuck", access: "write", ttlMs: 600_000 }),
        submission: yield* BranchCommands.submission({
          branchId,
          commandId: "stuck-command" as BranchProtocol.CommandId,
          participantId: alice,
          name: BranchProtocol.SayCommand
        })
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(SyncError)
      expect(failure.message).toBe("Branch journal write failed")
      expect(failure.cause).toMatch(/\(compacted\)$/)
      expect(reads).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestJournal.layer(), shareLayer))))
})
