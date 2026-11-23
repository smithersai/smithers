import { Fuzz } from "@smthrs/fuzz"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BranchProjection, BranchProtocol } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const CmdSpec = Schema.Struct({
  seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  participant: Schema.Literals(["p-alice", "p-bob", "p-carol"]),
  foreign: Schema.Boolean,
  kind: Schema.Literals(["say", "edit"]),
  target: Schema.Literals(["title", "summary", "body"]),
  text: Schema.String
})

const makeEntry = (
  branchId: BranchProtocol.BranchId,
  otherBranchId: BranchProtocol.BranchId,
  spec: typeof CmdSpec.Type,
  idx: number
): JournalEvent.Entry => {
  const runId = BranchProtocol.branchRunId(spec.foreign ? otherBranchId : branchId)
  const commandId = Schema.decodeSync(BranchProtocol.CommandId)(`cmd-${spec.id}-${idx}`)
  const participantId = Schema.decodeSync(BranchProtocol.ParticipantId)(spec.participant)
  const seq = Schema.decodeSync(JournalEvent.Seq)(spec.seq)
  const sourceId = Schema.decodeSync(JournalEvent.SourceId)("fuzz-src")
  const sourceSeq = Schema.decodeSync(JournalEvent.SourceSeq)(idx + 1)
  const payload = spec.kind === "say"
    ? {
      commandId,
      participantId,
      capabilityId: "cap-1",
      name: BranchProtocol.SayCommand,
      args: (spec.text.trim() || "hello").slice(0, 64),
      target: ""
    }
    : {
      commandId,
      participantId,
      capabilityId: "cap-1",
      name: "branch.edit",
      args: spec.text.slice(0, 64),
      target: spec.target
    }
  return new JournalEvent.Entry({
    runId,
    seq,
    eventId: JournalEvent.makeEventId(runId, sourceId, sourceSeq),
    sourceId,
    sourceSeq,
    emittedAtMs: 1000 + spec.seq,
    eventType: BranchProtocol.CommandEvent,
    payload,
    meta: {}
  })
}

const permute = <T>(items: ReadonlyArray<T>, shift: number): Array<T> => {
  const arr = [...items]
  if (arr.length <= 1) return arr
  const rot = shift % arr.length
  return [...arr.slice(rot), ...arr.slice(0, rot)].reverse()
}

describe("@smthrs/sync BranchProjection CRDT convergence fuzz invariants", () => {
  it("converges identically under reordered, duplicated, and foreign-branch polluted delivery", async () => {
    const branchId = Schema.decodeSync(BranchProtocol.BranchId)("branch-main")
    const otherBranchId = Schema.decodeSync(BranchProtocol.BranchId)("branch-foreign")
    const arb = Arbitrary.schema(
      Schema.Struct({
        specs: Schema.Array(CmdSpec),
        shift: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ specs, shift }) => {
          const seenSeq = new Set<number>()
          const entries: Array<JournalEvent.Entry> = []
          for (let i = 0; i < Math.min(specs.length, 16); i++) {
            const sp = specs[i]!
            if (!sp.foreign && seenSeq.has(sp.seq)) continue
            if (!sp.foreign) seenSeq.add(sp.seq)
            entries.push(makeEntry(branchId, otherBranchId, sp, i))
          }

          const streamA = [...entries, ...entries.slice(0, 3)]
          const streamB = [...permute(entries, shift), ...permute(entries, shift + 1).slice(0, 4)]

          const projA = BranchProjection.project(branchId, streamA)
          const projB = BranchProjection.project(branchId, streamB)

          let foldA = BranchProjection.empty(branchId)
          for (const e of streamA) foldA = BranchProjection.apply(foldA, e)
          let foldB = BranchProjection.empty(branchId)
          for (const e of streamB) foldB = BranchProjection.apply(foldB, e)

          const norm = (s: BranchProjection.State) =>
            JSON.stringify({
              branchId: s.branchId,
              seq: s.seq,
              messages: s.messages,
              commands: s.commands,
              fields: [...s.fields].sort((a, b) => a.target.localeCompare(b.target))
            })
          if (norm(projA) !== norm(projB)) return false
          if (norm(foldA) !== norm(projA)) return false
          if (norm(foldB) !== norm(projA)) return false

          for (let i = 1; i < projA.messages.length; i++) {
            if (!(projA.messages[i - 1]!.seq < projA.messages[i]!.seq)) return false
          }

          const ownCount = entries.filter((e) => e.runId === BranchProtocol.branchRunId(branchId)).length
          return projA.commands.length === ownCount
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
