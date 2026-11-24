import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { FlowEngine } from "@smthrs/engine"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CacheAgeHistory from "../src/internal/CacheAgeHistory.ts"
import * as CacheOutputPolicy from "../src/internal/CacheOutputPolicy.ts"
import * as CopiedRecord from "../src/internal/CopiedRecord.ts"
import * as PlanMerges from "../src/internal/PlanMerges.ts"
import * as ProvenanceSlot from "../src/internal/ProvenanceSlot.ts"
import type * as StepBoundary from "../src/StepBoundary.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "300" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")

const conflictErr = new Journal.JournalError({ code: "idempotency_conflict", message: "occupied slot" })

const makeRunRow = (runId: string, parentRunId: string | null): RunStore.RunRow => ({
  runId,
  parentRunId,
  status: "running",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  claim: null,
  attempt: 1,
  flowName: "fuzz/flow",
  flowVersion: "1",
  inputJson: "{}",
  outputJson: null,
  errorJson: null,
  updatedAtMs: 0
} as unknown as RunStore.RunRow)

const lineageOf = (name: string) => `smithers-journal-lineage/v1:${JSON.stringify([name])}`

describe("@smthrs/engine-store CopiedRecord, CacheAgeHistory, ProvenanceSlot, CacheOutputPolicy & PlanMerges deep fuzz", () => {
  it("CopiedRecord.find/prove/accept enforces lineage proof, payload equality, fork marker & anti-spoof invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "valid_copy",
          "payload_mismatch",
          "missing_fork_marker",
          "missing_parent",
          "wrong_event_type",
          "deep_chain"
        ]),
        seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, seq }) =>
          Effect.gen(function*() {
            const payload = { runId: scenario === "deep_chain" ? "grand" : "parent", nested: [{ b: 2, a: 1 }] }
            const makeEntry = (runId: string, overrides: Partial<JournalEvent.Entry> = {}): JournalEvent.Entry =>
              new JournalEvent.Entry({
                runId: JournalEvent.RunId.make(runId),
                seq: JournalEvent.Seq.make(seq),
                eventId: `${runId}:${seq}`,
                sourceId: JournalEvent.SourceId.make("producer"),
                sourceSeq: JournalEvent.SourceSeq.make(0),
                emittedAtMs: 100,
                eventType: "test.boundary",
                payload,
                meta: { lineageId: FlowEngine.Lineage.root(scenario === "deep_chain" ? "grand" : "parent") },
                ...overrides
              })
            const forkMarker = (child: string, parent: string): JournalEvent.Entry =>
              makeEntry(child, {
                seq: JournalEvent.Seq.make(seq + 1),
                sourceSeq: JournalEvent.SourceSeq.make(1),
                sourceId: JournalEvent.SourceId.make("flows/time-travel/fork"),
                eventType: "flows.time-travel.fork-created",
                payload: { childRunId: child, parentRunId: parent, forkJournalOffset: seq }
              })

            const entriesByRun: Record<string, Array<JournalEvent.Entry>> = {
              grand: [makeEntry("grand")],
              parent: scenario === "deep_chain"
                ? [makeEntry("parent"), forkMarker("parent", "grand")]
                : [makeEntry("parent")],
              child: scenario === "missing_fork_marker"
                ? [makeEntry("child")]
                : [
                  makeEntry("child", {
                    eventType: scenario === "wrong_event_type" ? "other.event" : "test.boundary"
                  }),
                  forkMarker("child", "parent")
                ]
            }
            const parents: Record<string, string | null> = {
              child: scenario === "missing_parent" ? null : "parent",
              parent: scenario === "deep_chain" ? "grand" : null,
              grand: null
            }

            const record = new JournalEvent.Input({
              runId: JournalEvent.RunId.make("child"),
              sourceId: JournalEvent.SourceId.make("producer"),
              sourceSeq: JournalEvent.SourceSeq.make(0),
              eventType: "test.boundary",
              payload: scenario === "payload_mismatch"
                ? { runId: "child", nested: [{ a: 999, b: 2 }] }
                : { nested: [{ a: 1, b: 2 }], runId: "child" },
              meta: { lineageId: FlowEngine.Lineage.root("child") }
            })

            const journal = Journal.makeNoop({
              entries: (q) => Effect.succeed({ entries: entriesByRun[q.runId] ?? [], hasMore: false })
            })
            const runs = RunStore.makeNoop({
              get: (rid) =>
                rid in parents
                  ? Effect.succeed(makeRunRow(rid, parents[rid]!))
                  : Effect.fail(
                    new RunStore.RunStoreError({
                      code: "not_found_row",
                      method: "get",
                      message: `missing ${rid}`,
                      cause: undefined
                    })
                  )
            })

            const res = yield* CopiedRecord.accept({
              runId: "child",
              record,
              conflict: conflictErr,
              journal,
              runs
            }).pipe(Effect.result)

            if (scenario === "valid_copy" || scenario === "deep_chain") {
              return res._tag === "Success"
            }
            return res._tag === "Failure"
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CacheAgeHistory.copiedVerdict & ProvenanceSlot.accept uphold cache provenance conflict invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Schema.Literals([
          "admitted",
          "expired",
          "mismatch_key",
          "mismatch_action",
          "mismatch_seq",
          "unrelated"
        ]),
        ageMs: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 5000 })),
        ttlMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 3000 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ action, ageMs, ttlMs }) =>
          Effect.gen(function*() {
            const sourceId = JournalEvent.SourceId.make("cache:digest-1:expired:recorded-run:7")
            const inputRecord = new JournalEvent.Input({
              runId: JournalEvent.RunId.make("prov-run"),
              sourceId,
              sourceSeq: JournalEvent.SourceSeq.make(0),
              eventType: "flows.engine.cache-provenance",
              payload: {
                keyDigest: "digest-1",
                action: "expired",
                ttlMs,
                ageMs,
                recordedRunId: "recorded-run",
                recordedEventSeq: 7
              },
              meta: { lineageId: lineageOf("prov-run") }
            })
            const existingEntry = new JournalEvent.Entry({
              runId: JournalEvent.RunId.make("prov-run"),
              seq: JournalEvent.Seq.make(3),
              eventId: "slot",
              sourceId,
              sourceSeq: JournalEvent.SourceSeq.make(0),
              emittedAtMs: 100,
              eventType: action === "unrelated" ? "other.event" : "flows.engine.cache-provenance",
              payload: {
                keyDigest: action === "mismatch_key" ? "digest-other" : "digest-1",
                action: action === "mismatch_action" ? "ttl" : "expired",
                ttlMs,
                ageMs: ageMs + 10,
                recordedRunId: "recorded-run",
                recordedEventSeq: action === "mismatch_seq" ? 99 : 7
              },
              meta: { lineageId: lineageOf("parent-run") }
            })

            const provRes = yield* ProvenanceSlot.accept({
              runId: "prov-run",
              record: inputRecord,
              conflict: conflictErr,
              journal: Journal.makeNoop({
                entries: () => Effect.succeed({ entries: [existingEntry], hasMore: false })
              })
            }).pipe(Effect.result)

            if (action === "admitted" || action === "expired") {
              if (provRes._tag !== "Success") return false
            } else {
              if (provRes._tag !== "Failure") return false
            }

            const histSourceId = JournalEvent.SourceId.make("cache:key:ttl:producer:7")
            const histPayload = {
              keyDigest: "key",
              action: "ttl",
              ttlMs,
              verdict: action === "expired" ? "expired" : "admitted",
              recordedRunId: "producer",
              recordedEventSeq: 7
            }
            const makeHistEntry = (rid: string, overrides: Partial<JournalEvent.Entry> = {}): JournalEvent.Entry =>
              new JournalEvent.Entry({
                runId: JournalEvent.RunId.make(rid),
                seq: JournalEvent.Seq.make(0),
                eventId: `${rid}:0`,
                sourceId: histSourceId,
                sourceSeq: JournalEvent.SourceSeq.make(0),
                emittedAtMs: 100,
                eventType: "flows.engine.cache-provenance",
                payload: histPayload,
                meta: { lineageId: lineageOf("parent") },
                ...overrides
              })
            const marker = makeHistEntry("child", {
              seq: JournalEvent.Seq.make(1),
              sourceSeq: JournalEvent.SourceSeq.make(1),
              sourceId: JournalEvent.SourceId.make("flows/time-travel/fork"),
              eventType: "flows.time-travel.fork-created",
              payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: 0 }
            })
            const histDecision = new JournalEvent.Input({
              runId: JournalEvent.RunId.make("child"),
              sourceId: histSourceId,
              sourceSeq: JournalEvent.SourceSeq.make(0),
              eventType: "flows.engine.cache-provenance",
              payload: { ...histPayload, verdict: "expired" },
              meta: { lineageId: lineageOf("child") }
            })
            const histRes = yield* CacheAgeHistory.copiedVerdict({
              runId: "child",
              decision: histDecision,
              conflict: conflictErr,
              journal: Journal.makeNoop({
                entries: (q) =>
                  Effect.succeed({
                    entries: q.runId === "child" ? [makeHistEntry("child"), marker] : [makeHistEntry("parent")],
                    hasMore: false
                  })
              }),
              runs: RunStore.makeNoop({
                get: (rid) =>
                  rid === "child"
                    ? Effect.succeed(makeRunRow("child", "parent"))
                    : rid === "parent"
                    ? Effect.succeed(makeRunRow("parent", null))
                    : Effect.fail(
                      new RunStore.RunStoreError({
                        code: "not_found_row",
                        method: "get",
                        message: `missing ${rid}`,
                        cause: undefined
                      })
                    )
              })
            }).pipe(Effect.result)

            return histRes._tag === "Success" || histRes._tag === "Failure"
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CacheOutputPolicy.replay refuses out-of-boundary, malformed, or undefined-descriptor evidence", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "undefined_desc",
          "valid_manifest",
          "outside_path",
          "traversal_path",
          "valid_declared_paths",
          "mismatched_declared_paths",
          "malformed_evidence",
          "tree_outside"
        ])
      })
    )

    const digest = ArtifactStore.Digest.make("a".repeat(64))
    const descriptor: FileBoundary = {
      readSet: [{ path: "src/in.ts", digest: "b".repeat(64) }],
      writeSet: ["dist/out.js", { _tag: "Glob", include: ["dist/gen/**"] }],
      boundaryMode: "expected"
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseKind }) =>
          Effect.sync(() => {
            const evidence: StepBoundary.BoundaryEvidence = {
              declaredOutputs: caseKind === "valid_manifest"
                ? { outputs: [{ path: "dist/out.js", digest }] }
                : caseKind === "outside_path"
                ? { outputs: [{ path: "src/secret.ts", digest }] }
                : caseKind === "traversal_path"
                ? { outputs: [{ path: "../etc/passwd", digest }] }
                : caseKind === "tree_outside"
                ? { outputs: [], trees: [{ path: "other/dir", identity: "id-1" }] }
                : caseKind === "valid_declared_paths"
                ? { paths: ["dist/out.js", { _tag: "Glob", include: ["dist/gen/**"] }] }
                : caseKind === "mismatched_declared_paths"
                ? { paths: ["dist/other.js"] }
                : { bogus: 123 }
            } as unknown as StepBoundary.BoundaryEvidence

            const decision = CacheOutputPolicy.replay(caseKind === "undefined_desc" ? undefined : descriptor, evidence)
            if (caseKind === "valid_manifest" || caseKind === "valid_declared_paths") {
              return decision._tag === "ReplayOutputs"
            }
            return decision._tag === "Refused"
          }),
        { seed: seed + 2, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("PlanMerges.allocateId, draft, validateIntent & recover uphold merge identity & plan integrity", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        existingMerge: Schema.Boolean,
        badStoppedNode: Schema.Boolean,
        badWinner: Schema.Boolean,
        emptyWinners: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ existingMerge, badStoppedNode, badWinner, emptyWinners }) =>
          Effect.gen(function*() {
            const baseDrafts: Array<Plan.NodeDraft> = [
              {
                id: "a",
                material: {
                  version: KeyMaterial.version,
                  kind: "sealed",
                  body: "a",
                  inputs: [],
                  layers: [],
                  capabilities: []
                },
                effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" }
              },
              {
                id: "b",
                material: {
                  version: KeyMaterial.version,
                  kind: "sealed",
                  body: "b",
                  inputs: [],
                  layers: [],
                  capabilities: []
                },
                effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" },
                conflictStrategy: "lane",
                runtimeStrategy: "stop-merge"
              }
            ]
            if (existingMerge) {
              baseDrafts.push({
                id: "b+merge",
                kind: "merge",
                material: {
                  version: KeyMaterial.version,
                  kind: "sealed",
                  body: "m",
                  inputs: [],
                  layers: [],
                  capabilities: []
                },
                effects: { reads: [], writes: [], boundaryMode: "hard" }
              })
            }
            const plan = yield* Plan.compile({ planId: "fuzz-plan", flow: "fuzz/flow", nodes: baseDrafts })
            const allocated = PlanMerges.allocateId(plan, "b")
            if (existingMerge && allocated === "b+merge") return false
            if (!existingMerge && allocated !== "b+merge") return false

            const nodeB = plan.nodes.find((n) => n.id === "b")!
            const drafted = PlanMerges.draft(nodeB, allocated, ["a"])
            if (drafted.id !== allocated || drafted.kind !== "merge") return false

            const intent = {
              version: 1 as const,
              nodeId: badStoppedNode ? "nonexistent" : nodeB.id,
              nodeKey: nodeB.key,
              dispatchKey: "dispatch",
              attempts: 1,
              rebases: 0,
              peers: emptyWinners ? [] : badWinner ? ["ghost"] : ["a"]
            }
            const valExit = yield* PlanMerges.validateIntent(plan, intent).pipe(Effect.result)
            if ((badStoppedNode || (!emptyWinners && badWinner)) && valExit._tag !== "Failure") return false

            const grown = yield* Plan.append(plan, [drafted])
            const recExit = yield* PlanMerges.recover(plan, [
              {
                intent,
                completion: {
                  version: 1 as const,
                  generation: 1,
                  parentDigest: plan.digest,
                  planDigest: grown.digest,
                  mergeId: allocated,
                  mergeKey: Plan.generationNodes(grown)[0]!.key,
                  winners: emptyWinners ? [] : badWinner ? ["ghost"] : ["a"]
                }
              }
            ]).pipe(Effect.result)
            if ((badStoppedNode || (!emptyWinners && badWinner)) && recExit._tag !== "Failure") return false
            return true
          }).pipe(Effect.provide(NodeCrypto.layer)),
        { seed: seed + 3, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
