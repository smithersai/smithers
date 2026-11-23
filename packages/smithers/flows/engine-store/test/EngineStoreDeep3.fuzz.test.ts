import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Fuzz } from "@smthrs/fuzz"
import type { Journal, JournalEvent } from "@smthrs/journal"
import { Arbitrary, Cause, Duration, Effect, Exit, Logger, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CacheSync from "../src/CacheSync.ts"
import * as CachePublication from "../src/internal/CachePublication.ts"
import * as NodeJournal from "../src/internal/NodeJournal.ts"
import * as SandboxedExecution from "../src/internal/SandboxedExecution.ts"
import * as StepLogCapture from "../src/internal/StepLogCapture.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepLogs from "../src/StepLogs.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const hex64 = (ch: string) => ch.repeat(64)

describe("@smthrs/engine-store Deep3 Fuzz (NodeJournal, CachePublication, SandboxedExecution, StepLogCapture)", () => {
  it("NodeJournal.resultSummary, entry, hostRoot & secret-redaction-before-truncation invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["small", "secretLong", "utf8Clamp", "surrogateClamp", "oversized", "cycle", "bigint", "throwingToJson"]),
        recordTag: Schema.Literals(["PlanRecorded", "SubgraphAppended", "NodeScheduled", "NodeSettled"]),
        hasRoot: Schema.Boolean,
        hasRevision: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            if (NodeJournal.hostRoot("/a", { root: "/b" }) !== "/a") return false
            if (NodeJournal.hostRoot(undefined, { root: "/b" }) !== "/b") return false
            if (NodeJournal.hostRoot(undefined, undefined) !== undefined) return false

            let val: unknown
            if (c.kind === "small") {
              val = { ok: true, count: 42 }
            } else if (c.kind === "secretLong") {
              val = { apiKey: "sk-live-secret-token-value-1234567890", pad: "a".repeat(3000) }
            } else if (c.kind === "utf8Clamp") {
              val = "é".repeat(1500) // 3000 UTF-8 bytes
            } else if (c.kind === "surrogateClamp") {
              val = "😀".repeat(700) // 2800 UTF-8 bytes with surrogate pairs
            } else if (c.kind === "oversized") {
              val = "x".repeat(NodeJournal.maximumSummarizedBytes + 500)
            } else if (c.kind === "cycle") {
              const obj: Record<string, unknown> = { a: 1 }
              obj["self"] = obj
              val = obj
            } else if (c.kind === "bigint") {
              val = 12345678901234567890n
            } else {
              val = { toJSON: () => { throw new Error("boom") } }
            }

            const summary = NodeJournal.resultSummary(val)
            if (c.kind === "bigint" || c.kind === "throwingToJson") {
              if (summary !== undefined) return false
            } else {
              if (summary === undefined) return false
              if (c.kind === "small" && summary.truncated) return false
              if (c.kind === "oversized" && (summary.preview !== "" || !summary.truncated)) return false
              if (c.kind === "secretLong") {
                if (summary.preview.includes("sk-live-secret-token")) return false
                if (!summary.truncated) return false
              }
              if (c.kind === "utf8Clamp" || c.kind === "surrogateClamp") {
                const byteLen = new TextEncoder().encode(summary.preview).length
                if (byteLen > NodeJournal.maximumResultBytes) return false
                if (!summary.truncated) return false
              }
            }

            const scope: NodeJournal.Scope = {
              runId: "r-nj",
              sourceId: "engine",
              lineageId: "lin-1",
              ...(c.hasRoot ? { root: "/repo" } : {}),
              ...(c.hasRevision ? { sourceRevision: "rev-abc" } : {})
            }
            const nodeSummary = {
              id: "n1",
              kind: "action" as const,
              dependsOn: [] as ReadonlyArray<string>,
              tier: "reversible" as const,
              action: "act/a",
              effects: { reads: [], writes: [] },
              declaredAt: { path: "/repo/src/flow.ts", line: 12 }
            }

            if (c.recordTag === "PlanRecorded") {
              const e = NodeJournal.entry(scope, {
                _tag: "PlanRecorded",
                sourceId: "plan/0",
                flow: "f1",
                digest: hex64("a"),
                generation: 1,
                nodeCount: 1,
                page: 0,
                pages: 1,
                nodes: [nodeSummary],
                edges: []
              } as any)
              if (e.sourceSeq !== 0) return false
            } else if (c.recordTag === "SubgraphAppended") {
              const e = NodeJournal.entry(scope, {
                _tag: "SubgraphAppended",
                sourceId: "sub/0",
                flow: "f1",
                generation: 2,
                page: 0,
                pages: 1,
                nodes: [nodeSummary],
                edges: []
              } as any)
              if (e.sourceSeq !== 0) return false
            } else if (c.recordTag === "NodeScheduled") {
              const e = NodeJournal.entry(scope, {
                _tag: "NodeScheduled",
                sourceId: "sched/n1/0",
                nodeId: "n1",
                kind: "action",
                attempt: 1,
                action: "act/a"
              } as any)
              if (e.sourceSeq !== 0) return false
            } else {
              const e = NodeJournal.entry(scope, {
                _tag: "NodeSettled",
                sourceId: "settle/n1",
                nodeId: "n1",
                outcome: "succeeded",
                attempts: 1,
                stepKeyDigests: [hex64("b")],
                action: "act/a",
                childExecutionId: "child-1",
                value: c.kind === "small" ? { ok: 1 } : undefined
              } as any)
              if (e.sourceSeq !== 0) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("CachePublication (publishArtifacts, publishEntry, hydrateArtifacts, replayMissingArtifact) fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hasEvidence: Schema.Boolean,
        hasDigests: Schema.Boolean,
        artifactSyncMode: Schema.Literals(["default", "ok", "fail"]),
        cacheSyncMode: Schema.Literals(["default", "ok", "refuse"]),
        hydrateFound: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const evidence: StepBoundary.BoundaryEvidence | undefined = !c.hasEvidence
              ? undefined
              : {
                declaredOutputs: {
                  version: 1,
                  outputs: c.hasDigests
                    ? [{ path: "out.txt", kind: "file", digest: hex64("1"), bytes: 5 }]
                    : []
                }
              } as any

            const artSyncLayer = c.artifactSyncMode === "default"
              ? undefined
              : ArtifactSync.ArtifactSync
            const artSyncSvc: ArtifactSync.Service = {
              publish: () =>
                c.artifactSyncMode === "fail"
                  ? Effect.fail({ message: "s3 down" } as any)
                  : Effect.void,
              hydrate: () => Effect.succeed(c.hydrateFound)
            } as any

            const cacheSyncSvc: CacheSync.Service = {
              publishEntry: () =>
                Effect.succeed(c.cacheSyncMode === "refuse" ? Option.some({ message: "entry refused" } as any) : Option.none())
            } as any

            const pubArtEff = CachePublication.publishArtifacts(evidence)
            const pubArtRes = yield* (
              artSyncLayer !== undefined
                ? pubArtEff.pipe(Effect.provideService(ArtifactSync.ArtifactSync, artSyncSvc))
                : pubArtEff
            )
            if (c.hasEvidence && c.hasDigests && c.artifactSyncMode === "fail") {
              if (pubArtRes?.stage !== "artifacts") return false
            } else if (pubArtRes !== undefined) {
              return false
            }

            const pubEntEff = CachePublication.publishEntry({ stepKeyDigest: hex64("2") } as any)
            const pubEntRes = yield* (
              c.cacheSyncMode !== "default"
                ? pubEntEff.pipe(Effect.provideService(CacheSync.CacheSync, cacheSyncSvc))
                : pubEntEff
            )
            if (c.cacheSyncMode === "refuse") {
              if (pubEntRes?.stage !== "entry") return false
            } else if (pubEntRes !== undefined) {
              return false
            }

            if (evidence !== undefined) {
              const hydEff = CachePublication.hydrateArtifacts(evidence)
              const hydrated = yield* (
                artSyncLayer !== undefined
                  ? hydEff.pipe(Effect.provideService(ArtifactSync.ArtifactSync, artSyncSvc))
                  : hydEff
              )
              if (!c.hasDigests && hydrated) return false
              if (c.hasDigests && c.artifactSyncMode !== "default" && hydrated !== c.hydrateFound) return false
            }

            const missing = new StepBoundary.MissingArtifact({
              code: "missing_artifact",
              path: "out.txt",
              digest: hex64("1")
            })
            if (CachePublication.replayMissingArtifact(Cause.fail(missing)) !== missing) return false
            if (CachePublication.replayMissingArtifact(Cause.fail(new Error("other"))) !== undefined) return false
            return true
          }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(silentLogger)),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("SandboxedExecution.execute fuzzes clean settlement, rebases, conflict exhaustion, invalidations, and body failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcome: Schema.Literals(["clean", "rebaseRecover", "rebaseExhaust", "invalidatedWrite", "invalidatedRead", "bodyFail"]),
        maxRebases: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isLessThanOrEqualTo(2))),
        mode: Schema.Literals(["expected", "hard"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            let calls = 0
            const sandbox: WorkspaceSandbox.Service = {
              execute: () =>
                Effect.suspend(() => {
                  calls++
                  if (c.outcome === "bodyFail") {
                    return Effect.fail(new Error("user-body-error"))
                  }
                  if (c.outcome === "invalidatedWrite" || c.outcome === "invalidatedRead") {
                    return Effect.succeed({
                      _tag: "Invalidated",
                      violations: [{
                        kind: c.outcome === "invalidatedRead" ? "undeclared-read" : "undeclared-write",
                        resource: { id: "rogue.txt" }
                      }],
                      provenance: {
                        outputs: [{ resource: { id: "rogue.txt" }, digest: hex64("d") }]
                      }
                    } as any)
                  }
                  return Effect.succeed({
                    _tag: "Committed",
                    result: {
                      output: { ok: calls },
                      files: [{ path: "a.txt", beforeDigest: undefined, afterDigest: hex64("c") }],
                      effects: []
                    },
                    violations: c.mode === "expected" ? [{ kind: "undeclared-write", resource: { id: "extra.txt" } }] : []
                  } as any)
                }),
              materialize: () =>
                Effect.suspend(() => {
                  if (c.outcome === "rebaseRecover" && calls === 1) {
                    return Effect.fail(new WorkspaceSandbox.MaterializationConflict({ message: "race", paths: ["a.txt"] } as any))
                  }
                  if (c.outcome === "rebaseExhaust") {
                    return Effect.fail(new WorkspaceSandbox.MaterializationConflict({ message: "always-race", paths: ["a.txt"] } as any))
                  }
                  return Effect.void
                })
            } as any

            const exit = yield* Effect.exit(
              SandboxedExecution.execute({
                sandbox,
                descriptor: { reads: [], writes: ["a.txt"], mode: c.mode } as any,
                workflow: Effect.succeed("body"),
                maxRebases: c.maxRebases
              })
            )

            if (c.outcome === "clean") {
              if (Exit.isFailure(exit)) return false
              return exit.value.rebases === 0 && exit.value.bundleIdentity.length > 0
            }
            if (c.outcome === "rebaseRecover") {
              if (c.maxRebases === 0) return Exit.isFailure(exit)
              if (Exit.isFailure(exit)) return false
              return exit.value.rebases === 1
            }
            return Exit.isFailure(exit)
          }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(silentLogger)),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("StepLogCapture.capture fuzzes disabled limits, accepted/dropped/failed receipts, and flush timeout accounting", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["disabled", "accepted", "dropped", "failed", "slowTimeout"]),
        logCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isLessThanOrEqualTo(4)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const emitted: Array<JournalEvent.Input> = []
            const target: Journal.Service = {
              emitLossy: (inp: JournalEvent.Input) =>
                Effect.gen(function*() {
                  if (c.mode === "slowTimeout") {
                    yield* Effect.sleep(Duration.millis(20))
                  }
                  if (c.mode === "failed") {
                    return yield* Effect.fail({ code: "sink_failed", message: "sink fail" } as any)
                  }
                  emitted.push(inp)
                  if (c.mode === "dropped") return { _tag: "Dropped" } as any
                  return { _tag: "Accepted", seq: emitted.length } as any
                })
            } as any

            const limits = {
              records: c.mode === "disabled" ? 0 : 10,
              queue: 2,
              flush: c.mode === "slowTimeout" ? Duration.millis(5) : Duration.millis(200),
              maxBytes: 4096
            }

            const result = yield* StepLogCapture.capture(target, {
              runId: "r-log",
              stepKeyDigest: hex64("9"),
              attempt: 1
            })(
              Effect.gen(function*() {
                for (let i = 0; i < c.logCount; i++) {
                  yield* Effect.logInfo(`step log ${i}`)
                }
                return "body-value"
              })
            ).pipe(
              Effect.provideService(StepLogs.Limits, limits as any),
              Effect.provide(silentLogger)
            )

            // Body return value must NEVER be altered by log capture failures/drops/timeouts!
            if (result !== "body-value") return false
            if (c.mode === "disabled" && emitted.length !== 0) return false
            return true
          }),
        { seed: seed + 3, executions: Math.min(executions, 45) }
      )
    )
    assertPassed(report)
  })
})
