/**
 * flows-sync/simplicity/8: admission decodes every branch command's payload as
 * a full `CommandEventPayload`, and the ledger's history walk then decoded the
 * same payload a second time, as a one-field `CommandIdentity`, to read its id.
 * Admission now hands the decoded command back beside its entry, so the walk
 * reads the id and decodes nothing.
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect } from "effect"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as Admission from "../src/internal/admission.ts"

const branchId = "admitted" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const entry = (seq: number, eventType: string, payload: unknown) =>
  new JournalEvent.Entry({
    runId,
    seq: seq as JournalEvent.Seq,
    eventId: `entry-${seq}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType,
    payload,
    meta: null
  })

describe("Admission.withCommands", () => {
  it.effect("returns each command beside the payload admission decoded, and nothing beside other events", () =>
    Effect.gen(function*() {
      // A row written before `args` and `target` existed: the decoded command
      // carries their defaults, which a second decode could not add back.
      const command = { branchId, commandId: "c-1", participantId: "p-1", name: BranchProtocol.SayCommand }
      const admitted = yield* Admission.withCommands(
        [entry(0, BranchProtocol.CommandEvent, command), entry(1, "extension", { note: "not a command" })],
        runId,
        -1
      )
      expect(admitted.map(({ entry }) => entry.seq)).toEqual([0, 1])
      expect(admitted[0]?.command).toBeInstanceOf(BranchProtocol.CommandEventPayload)
      expect(admitted[0]?.command).toMatchObject({
        commandId: "c-1",
        participantId: "p-1",
        name: BranchProtocol.SayCommand,
        args: "",
        target: ""
      })
      expect(admitted[1]?.command).toBeUndefined()
    }))

  it.effect("refuses a batch that does not ascend above its cursor, as entries() does", () =>
    Effect.gen(function*() {
      const refused = yield* Effect.flip(
        Admission.withCommands([entry(3, "extension", 1), entry(3, "extension", 2)], runId, 2)
      )
      expect(refused).toMatchObject({ code: "protocol_violation", cause: "non_monotonic_sequence" })
    }))
})
