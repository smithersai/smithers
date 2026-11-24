import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Clock, Duration, Effect, Fiber, Layer, Option, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { AttemptStore, Migrations, Ownership, RunStore } from "../src/index.ts"
import { admitJsonText, rememberAdmittedText } from "../src/internal/Boundary.ts"
import * as TestRunStore from "../src/test/TestRunStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "50"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const owners: Record<"a" | "b" | "c", Ownership.OwnerId> = {
  a: { hostId: "host-a", pid: 1001, nonce: "nonce-a" },
  b: { hostId: "host-b", pid: 1002, nonce: "nonce-b" },
  c: { hostId: "host-a", pid: 1003, nonce: "nonce-c" }
}

const sameOwner = (x: Ownership.OwnerId | null | undefined, y: Ownership.OwnerId): boolean =>
  x != null && x.hostId === y.hostId && x.pid === y.pid && x.nonce === y.nonce

const evidenceFor = (
  expectedOwner: Ownership.OwnerId,
  claimant: Ownership.OwnerId,
  checkedAtMs: number,
  kind: "lease-expired" | "same-host-pid-dead" | "cross-host-unreachable-stale"
): Ownership.LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: kind === "same-host-pid-dead" && expectedOwner.hostId !== claimant.hostId
    ? "cross-host-unreachable-stale"
    : kind
})

describe("@smthrs/run-store SQLite lifecycle, ownership, and attempt fuzz invariants", () => {
  it("RunStore lifecycle preserves ownership fencing, monotonic heartbeats/cancellation, steal/recovery, guards, and lineage over SQLite", async () => {
    const ownerArb = Schema.Literals(["a", "b", "c"])
    const evidenceKindArb = Schema.Literals([
      "lease-expired",
      "same-host-pid-dead",
      "cross-host-unreachable-stale"
    ])
    const opArb = Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("claim"), owner: ownerArb }),
      Schema.Struct({
        _tag: Schema.Literal("claimAndOwn"),
        owner: ownerArb,
        withEvidence: Schema.Boolean,
        evKind: evidenceKindArb
      }),
      Schema.Struct({ _tag: Schema.Literal("activate"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("abandon"), owner: ownerArb }),
      Schema.Struct({
        _tag: Schema.Literal("recoverClaim"),
        observer: ownerArb,
        evKind: evidenceKindArb
      }),
      Schema.Struct({ _tag: Schema.Literal("heartbeat"), owner: ownerArb, skew: Schema.Boolean }),
      Schema.Struct({ _tag: Schema.Literal("reconfirm"), owner: ownerArb }),
      Schema.Struct({
        _tag: Schema.Literal("steal"),
        claimant: ownerArb,
        evKind: evidenceKindArb,
        staleTimestamp: Schema.Boolean
      }),
      Schema.Struct({
        _tag: Schema.Literal("transition"),
        owner: ownerArb,
        to: Schema.Literals(["running", "suspended", "completed", "failed", "cancelled", "pending"]),
        guardCancel: Schema.Literals(["none", "absent", "present"]),
        restorePending: Schema.Boolean
      }),
      Schema.Struct({ _tag: Schema.Literal("advanceClock"), secs: Schema.Literals([1, 5, 35]) }),
      Schema.Struct({ _tag: Schema.Literal("cancel"), lineage: Schema.Boolean }),
      Schema.Struct({ _tag: Schema.Literal("ackCancel"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("addRound") }),
      Schema.Struct({ _tag: Schema.Literal("get") })
    ])
    const arb = Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(20))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            yield* TestClock.setTime(1_000_000)

            const runId = "run-fuzz-1"
            const initState = JSON.stringify({ step: 0 })
            yield* store.create(runId, initState)
            const dup = yield* Effect.result(store.create(runId, JSON.stringify({ step: 1 })))
            if (Result.isSuccess(dup)) return false

            // Missing row & bad inputs fail with typed RunStoreError
            const missingGet = yield* Effect.result(store.get("no-such-run"))
            if (Result.isSuccess(missingGet) || missingGet.failure.code !== "not_found_row") return false
            const missingLatest = yield* Effect.result(store.latestRound("no-such-run"))
            if (Result.isSuccess(missingLatest) || missingLatest.failure.code !== "not_found_row") return false
            const missingLin = yield* store.lineage("no-such-run")
            if (missingLin.length !== 0) return false
            const badJson = yield* Effect.result(store.create("bad-json-run", "{broken"))
            if (Result.isSuccess(badJson)) return false

            // Exercise withPermit
            const permitVal = yield* store.withPermit(
              "fuzz-res",
              owners.a,
              Ownership.leaseLiveness(),
              Effect.succeed(42)
            )
            if (permitVal !== 42) return false

            // Exercise RunStore.layerNoop refusal paths
            const noopOk = yield* Effect.gen(function*() {
              const ns = yield* RunStore.RunStore
              const r1 = yield* Effect.result(ns.create("x", "{}"))
              const r2 = yield* Effect.result(ns.get("x"))
              const r3 = yield* Effect.result(ns.lineage("x"))
              const r4 = yield* Effect.result(ns.latestRound("x"))
              const r5 = yield* ns.requestCancel("x", 1)
              const r6 = yield* ns.acknowledgeCancel("x", owners.a, 1)
              return Result.isFailure(r1) && Result.isFailure(r2) && Result.isFailure(r3) &&
                Result.isFailure(r4) && r5._tag === "NotFound" && r6 === false
            }).pipe(Effect.provide(RunStore.layerNoop()))
            if (!noopOk) return false

            let cancelRequested = false
            let lastClaimedBy: Ownership.OwnerId | undefined
            let lastClaimedAt: number | undefined
            let rounds = 1
            let lastRoundId = runId

            for (const op of ops) {
              const nowMs = Math.floor(yield* Clock.currentTimeMillis)
              const current = yield* store.get(runId)
              if (cancelRequested && current.cancelRequestedAtMs === null) return false

              if (op._tag === "advanceClock") {
                yield* TestClock.adjust(Duration.seconds(op.secs))
              } else if (op._tag === "claim") {
                const claimant = owners[op.owner]
                const outcome = yield* store.claim(runId, current, claimant, nowMs)
                if (outcome._tag === "Claimed") {
                  lastClaimedBy = claimant
                  lastClaimedAt = outcome.claimedAtMs
                }
              } else if (op._tag === "claimAndOwn") {
                const claimant = owners[op.owner]
                const ev = op.withEvidence && current.owner !== null
                  ? evidenceFor(current.owner, claimant, nowMs, op.evKind)
                  : undefined
                const outcome = yield* store.claimAndOwn(runId, current, claimant, nowMs, ev)
                if (outcome._tag === "Activated") {
                  const after = yield* store.get(runId)
                  if (after.status !== "running" || !sameOwner(after.owner, claimant)) return false
                }
              } else if (op._tag === "activate") {
                if (lastClaimedAt !== undefined) {
                  const claimant = owners[op.owner]
                  const outcome = yield* store.activate(runId, claimant, lastClaimedAt, current)
                  if (
                    lastClaimedBy !== undefined && !sameOwner(lastClaimedBy, claimant) && outcome._tag === "Activated"
                  ) {
                    return false
                  }
                }
              } else if (op._tag === "abandon") {
                if (lastClaimedAt !== undefined) {
                  yield* store.abandonClaim(runId, owners[op.owner], lastClaimedAt)
                }
              } else if (op._tag === "recoverClaim") {
                if (current.claim !== null && current.claimedAtMs !== null) {
                  const observer = owners[op.observer]
                  const ev = evidenceFor(current.claim, observer, nowMs, op.evKind)
                  yield* store.recoverClaim(runId, current.claim, current.claimedAtMs, observer, nowMs, ev)
                }
              } else if (op._tag === "heartbeat") {
                const owner = owners[op.owner]
                const ts = op.skew ? nowMs + 10_000_000 : nowMs
                const res = yield* Effect.result(store.heartbeat(runId, owner, ts))
                if (op.skew) {
                  if (Result.isSuccess(res)) return false
                } else if (Result.isSuccess(res)) {
                  if (res.success._tag === "Updated" && !sameOwner(current.owner, owner)) return false
                  if (res.success._tag === "Updated") {
                    const after = yield* store.get(runId)
                    if (
                      current.heartbeatAtMs !== null &&
                      after.heartbeatAtMs !== null &&
                      after.heartbeatAtMs < current.heartbeatAtMs
                    ) {
                      return false
                    }
                  }
                }
              } else if (op._tag === "reconfirm") {
                const owner = owners[op.owner]
                const out = yield* store.reconfirm(runId, owner, nowMs)
                if (out._tag === "Updated" && !sameOwner(current.owner, owner)) return false
                if (out._tag === "Updated" && current.claim !== null) return false
              } else if (op._tag === "steal") {
                const claimant = owners[op.claimant]
                const targetOwner = current.owner ?? owners.a
                const ev = evidenceFor(
                  targetOwner,
                  claimant,
                  op.staleTimestamp ? nowMs - 1 : nowMs,
                  op.evKind
                )
                const out = yield* store.steal(runId, current, claimant, nowMs, ev)
                if (op.staleTimestamp && out._tag === "Claimed") return false
                if (out._tag === "Claimed") {
                  lastClaimedBy = claimant
                  lastClaimedAt = out.claimedAtMs
                }
              } else if (op._tag === "transition") {
                const owner = owners[op.owner]
                const guard: RunStore.TransitionGuard | undefined = op.guardCancel === "none" && !op.restorePending
                  ? undefined
                  : {
                    ...(op.guardCancel === "none" ? {} : { cancelRequested: op.guardCancel }),
                    ...(op.restorePending ? { restorePending: true as const } : {})
                  }
                const nextStateJson = op.restorePending ? current.stateJson : JSON.stringify({ step: nowMs })
                const outRes = yield* Effect.result(
                  store.transitionOwned(runId, owner, op.to, nextStateJson, guard)
                )
                if (Result.isFailure(outRes)) {
                  if (outRes.failure.code !== "invalid_run") return false
                } else if (outRes.success._tag === "Transitioned") {
                  if (!sameOwner(current.owner, owner)) return false
                  if (op.guardCancel === "absent" && cancelRequested) return false
                  if (op.guardCancel === "present" && !cancelRequested) return false
                }
              } else if (op._tag === "cancel") {
                const res = op.lineage
                  ? yield* store.requestCancelLineage(runId, nowMs)
                  : yield* store.requestCancel(runId, nowMs)
                if (res._tag === "CancelRequested" || res._tag === "AlreadyRequested") {
                  cancelRequested = true
                }
              } else if (op._tag === "ackCancel") {
                const owner = owners[op.owner]
                const acked = yield* store.acknowledgeCancel(runId, owner, nowMs)
                if (acked && !cancelRequested) return false
                if (acked && !sameOwner(current.owner, owner)) return false
              } else if (op._tag === "addRound") {
                const nextId = `run-fuzz-r${rounds}`
                const createRes = yield* Effect.result(
                  store.create(nextId, JSON.stringify({ round: rounds }), {
                    parentRunId: lastRoundId,
                    lineageId: runId,
                    roundOrdinal: rounds
                  })
                )
                if (Result.isSuccess(createRes)) {
                  rounds++
                  lastRoundId = nextId
                  const fullLin = yield* store.lineage(nextId)
                  const metaLin = yield* store.lineage(nextId, { includeState: false })
                  const latest = yield* store.latestRound(runId)
                  if (fullLin.length !== rounds || metaLin.length !== rounds || latest.runId !== nextId) {
                    return false
                  }
                }
              } else {
                const row = yield* store.get(runId)
                if (row.runId !== runId) return false
              }
            }
            return true
          }).pipe(Effect.provide(Layer.mergeAll(TestRunStore.layer, TestClock.layer()))),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("concurrent RunStore claimAndOwn/transition/cancel under FuzzSimulation preserves single-owner mutual exclusion", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cancelConcurrently: Schema.Boolean,
        terminalA: Schema.Literals(["completed", "failed", "suspended"]),
        terminalB: Schema.Literals(["completed", "cancelled", "suspended"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cancelConcurrently, terminalA, terminalB }) =>
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const runId = "run-concurrent"
            yield* store.create(runId, JSON.stringify({ n: 0 }))
            const snap = yield* store.get(runId)
            const nowMs = Math.floor(yield* Clock.currentTimeMillis)

            const worker = (owner: Ownership.OwnerId, to: RunStore.RunStatus) =>
              Effect.gen(function*() {
                const own = yield* store.claimAndOwn(runId, snap, owner, nowMs)
                if (own._tag !== "Activated") return { won: false, transitioned: false }
                const hb = yield* store.heartbeat(runId, owner, nowMs)
                const tr = yield* store.transitionOwned(runId, owner, to, JSON.stringify({ by: owner.nonce }))
                return { won: hb._tag === "Updated", transitioned: tr._tag === "Transitioned" }
              })

            const [resA, resB] = yield* Effect.all(
              [
                worker(owners.a, terminalA),
                worker(owners.b, terminalB),
                ...(cancelConcurrently ? [store.requestCancel(runId, nowMs)] : [])
              ],
              { concurrency: "unbounded" }
            )

            // At most one owner may win claimAndOwn on the initial snapshot!
            const winners = (resA.won ? 1 : 0) + (resB.won ? 1 : 0)
            if (winners !== 1) return false
            const finalRow = yield* store.get(runId)
            if (cancelConcurrently && finalRow.cancelRequestedAtMs === null && finalRow.status === "running") {
              return false
            }
            return true
          }).pipe(
            Effect.provide(
              Layer.provideMerge(RunStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer))
            )
          ),
        { seed: seed + 1, executions: Math.min(executions, 30), execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("AttemptStore enforces owner fencing, insert/upsert semantics, field-preserving patch/finish, and Boundary JSON admission", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        putMode: Schema.Literals(["insert", "upsert"]),
        ops: Schema.Array(
          Schema.Union([
            Schema.Struct({
              _tag: Schema.Literal("put"),
              owner: Schema.Literals(["a", "b"]),
              attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
              state: Schema.Literals(["running", "completed"]),
              val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))
            }),
            Schema.Struct({
              _tag: Schema.Literal("heartbeat"),
              owner: Schema.Literals(["a", "b"]),
              attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
              withCheckpoint: Schema.Boolean
            }),
            Schema.Struct({
              _tag: Schema.Literal("patch"),
              owner: Schema.Literals(["a", "b"]),
              attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
              setMeta: Schema.Boolean,
              setError: Schema.Boolean
            }),
            Schema.Struct({
              _tag: Schema.Literal("finish"),
              owner: Schema.Literals(["a", "b"]),
              attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
              state: Schema.Literals(["completed", "failed"]),
              setOutcome: Schema.Boolean
            }),
            Schema.Struct({
              _tag: Schema.Literal("get"),
              attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
            })
          ])
        ).pipe(Schema.check(Schema.isMaxLength(16)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ putMode, ops }) =>
          Effect.gen(function*() {
            const dbLayer = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
            const fullLayer = Layer.mergeAll(
              RunStore.layer,
              AttemptStore.layerWith({
                putMode,
                inProgressStates: ["running"],
                maxCheckpointBytes: 4096
              })
            ).pipe(Layer.provide(dbLayer))

            return yield* Effect.gen(function*() {
              const runStore = yield* RunStore.RunStore
              const attemptStore = yield* AttemptStore.AttemptStore
              const runId = "run-att-1"
              const stepKeyDigest = "step-digest-1"
              yield* runStore.create(runId, JSON.stringify({ s: 1 }))
              const snap = yield* runStore.get(runId)
              const nowMs = Math.floor(yield* Clock.currentTimeMillis)
              yield* runStore.claimAndOwn(runId, snap, owners.a, nowMs)

              // Nonexistent run -> RunNotFound
              const missingPut = yield* attemptStore.put(
                {
                  runId: "missing-run",
                  stepKeyDigest,
                  attempt: 0,
                  state: "running",
                  startedAtMs: nowMs,
                  meta: { init: true }
                },
                owners.a
              )
              if (missingPut._tag !== "RunNotFound") return false

              // Invalid options to makeWith -> invalid_attempt
              const badOpts = yield* Effect.result(
                AttemptStore.makeWith({ inProgressStates: [] }).pipe(Effect.provide(dbLayer))
              )
              if (Result.isSuccess(badOpts)) return false

              // Invalid JSON / oversized checkpoint -> invalid_attempt
              const bigCkpt = yield* Effect.result(
                attemptStore.put(
                  {
                    runId,
                    stepKeyDigest,
                    attempt: 99,
                    state: "running",
                    startedAtMs: nowMs,
                    checkpoint: { pad: "x".repeat(5000) },
                    meta: {}
                  },
                  owners.a
                )
              )
              if (Result.isSuccess(bigCkpt) || bigCkpt.failure.code !== "invalid_attempt") return false

              for (const op of ops) {
                const owner = "owner" in op ? owners[op.owner] : owners.a
                const id = { runId, stepKeyDigest, attempt: op.attempt }
                if (op._tag === "put") {
                  const res = yield* attemptStore.put(
                    {
                      ...id,
                      state: op.state,
                      startedAtMs: nowMs,
                      checkpoint: { v: op.val },
                      meta: { m: op.val }
                    },
                    owner
                  )
                  if (op.owner === "b" && res._tag !== "FenceLost") return false
                  if (op.owner === "a" && putMode === "upsert" && res._tag !== "Upserted" && res._tag !== "Inserted") {
                    return false
                  }
                } else if (op._tag === "heartbeat") {
                  const res = yield* attemptStore.heartbeat(
                    runId,
                    stepKeyDigest,
                    op.attempt,
                    owner,
                    nowMs + 100,
                    op.withCheckpoint ? { ck: 1 } : undefined
                  )
                  if (op.owner === "b" && res._tag === "Updated") return false
                } else if (op._tag === "patch") {
                  const before = yield* attemptStore.get(id)
                  const res = yield* attemptStore.patch(
                    id,
                    {
                      ...(op.setMeta ? { meta: { patched: true } } : {}),
                      ...(op.setError ? { error: { msg: "err" } } : {})
                    },
                    owner
                  )
                  if (op.owner === "b" && res._tag === "Patched") return false
                  if (res._tag === "Patched" && Option.isSome(before)) {
                    const after = yield* attemptStore.get(id)
                    if (Option.isNone(after)) return false
                    // Omitted meta must be preserved!
                    if (!op.setMeta && JSON.stringify(after.value.meta) !== JSON.stringify(before.value.meta)) {
                      return false
                    }
                  }
                } else if (op._tag === "finish") {
                  const before = yield* attemptStore.get(id)
                  const res = yield* attemptStore.finish(
                    {
                      ...id,
                      state: op.state,
                      finishedAtMs: nowMs + 200,
                      ...(op.setOutcome ? { outcome: { ok: true } } : {})
                    },
                    owner
                  )
                  if (op.owner === "b" && res._tag === "Finished") return false
                  if (res._tag === "Finished" && Option.isSome(before)) {
                    const after = yield* attemptStore.get(id)
                    if (Option.isNone(after)) return false
                    if (after.value.state !== op.state) return false
                    // Omitted meta must be preserved across finish!
                    if (JSON.stringify(after.value.meta) !== JSON.stringify(before.value.meta)) return false
                  }
                } else {
                  const got = yield* attemptStore.get(id)
                  if (Option.isSome(got) && got.value.attempt !== op.attempt) return false
                }
              }

              // Verify listRun agrees with individual get calls
              if (attemptStore.listRun !== undefined) {
                const listed = yield* attemptStore.listRun(runId)
                for (const row of listed) {
                  const single = yield* attemptStore.get({
                    runId: row.runId,
                    stepKeyDigest: row.stepKeyDigest,
                    attempt: row.attempt
                  })
                  if (Option.isNone(single) || single.value.state !== row.state) return false
                }
              }

              // Also exercise makeNoop / layerNoop failure paths
              const noopRes = yield* Effect.gen(function*() {
                const s = yield* AttemptStore.AttemptStore
                const r1 = yield* Effect.result(
                  s.put(
                    { runId, stepKeyDigest, attempt: 0, state: "running", startedAtMs: nowMs, meta: {} },
                    owners.a
                  )
                )
                const r2 = yield* Effect.result(s.get({ runId, stepKeyDigest, attempt: 0 }))
                const r3 = yield* Effect.result(s.heartbeat(runId, stepKeyDigest, 0, owners.a, nowMs))
                const r4 = yield* Effect.result(s.patch({ runId, stepKeyDigest, attempt: 0 }, {}, owners.a))
                const r5 = yield* Effect.result(
                  s.finish(
                    { runId, stepKeyDigest, attempt: 0, state: "completed", finishedAtMs: nowMs },
                    owners.a
                  )
                )
                return Result.isFailure(r1) && Result.isFailure(r2) && Result.isFailure(r3) &&
                  Result.isFailure(r4) && Result.isFailure(r5)
              }).pipe(Effect.provide(AttemptStore.layerNoop()))
              if (!noopRes) return false

              return true
            }).pipe(Effect.provide(fullLayer))
          }),
        { seed: seed + 2, executions: Math.min(executions, 35) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Ownership liveness predicates, heartbeatLoop supervision, and Boundary rememberAdmittedText obey invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        sameHost: Schema.Boolean,
        hbAgeMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
        hbNull: Schema.Boolean,
        scenario: Schema.Literals(["steady", "transientOutage", "reconfirmSuccess", "lapseFenceLost"]),
        texts: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(40))))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sameHost, hbAgeMs, hbNull, scenario, texts }) =>
          Effect.gen(function*() {
            const claimant = sameHost ? owners.c : owners.b
            if (Ownership.sameHostIncarnation(owners.a, claimant) !== sameHost) return false

            const nowMs = 1_000_000
            const heartbeatAtMs = hbNull ? null : nowMs - hbAgeMs
            const staleMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
            const expectedAlive = heartbeatAtMs !== null && heartbeatAtMs >= nowMs - staleMs
            const leaseCheck = Ownership.leaseLiveness()
            const leaseAlive = yield* leaseCheck(owners.a, { claimant, heartbeatAtMs, nowMs })
            if (leaseAlive !== expectedAlive) return false
            const singleAlive = yield* Ownership.singleIncarnationLiveness(owners.a, {
              claimant,
              heartbeatAtMs,
              nowMs
            })
            if (singleAlive !== (sameHost ? false : expectedAlive)) return false

            // Boundary rememberAdmittedText equivalence & LRU bound
            const baseAdmit = (input: unknown) =>
              admitJsonText(input, { maxBytes: 128, maxDepth: 8, maxNodes: 64, maxMembers: 32 })
            const cachedAdmit = rememberAdmittedText(baseAdmit, 64)
            for (const t of [...texts.slice(0, 8), JSON.stringify({ a: 1 }), "{bad"]) {
              const r1 = baseAdmit(t)
              const r2 = cachedAdmit(t)
              const r3 = cachedAdmit(t)
              if (r1.ok !== r2.ok || r2.ok !== r3.ok) return false
            }

            // HeartbeatLoop supervision under TestClock
            let pulses = 0
            let reconfirms = 0
            let lapses = 0
            let hbCalls = 0
            const hbErr = new RunStore.RunStoreError({
              code: "persistence_failed",
              method: "heartbeat",
              message: "temp",
              cause: undefined
            })
            const fakeStore = RunStore.layerNoop({
              heartbeat: () => {
                hbCalls++
                if (scenario === "transientOutage" && hbCalls === 1) {
                  return Effect.fail(hbErr)
                }
                if (scenario === "reconfirmSuccess" || scenario === "lapseFenceLost") {
                  return Effect.fail(hbErr)
                }
                return Effect.succeed({ _tag: "Updated" as const })
              },
              reconfirm: () =>
                scenario === "lapseFenceLost"
                  ? Effect.succeed({ _tag: "FenceLost" as const })
                  : Effect.succeed({ _tag: "Updated" as const })
            })

            const loopResult = yield* Effect.scoped(
              Effect.gen(function*() {
                const fiber = yield* Effect.scoped(
                  Ownership.heartbeatLoop("run-hb", owners.a, {
                    onPulse: () =>
                      Effect.sync(() => {
                        pulses++
                      }),
                    onReconfirm: () =>
                      Effect.sync(() => {
                        reconfirms++
                      }),
                    onLapse: () =>
                      Effect.sync(() => {
                        lapses++
                      })
                  })
                ).pipe(Effect.forkChild({ startImmediately: true }))
                for (let i = 0; i < 4; i++) yield* Effect.yieldNow
                if (scenario === "steady") {
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* Fiber.interrupt(fiber)
                  return pulses >= 2 && lapses === 0
                }
                if (scenario === "transientOutage") {
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* Fiber.interrupt(fiber)
                  return pulses >= 1 && lapses === 0
                }
                if (scenario === "reconfirmSuccess") {
                  yield* TestClock.adjust(Ownership.heartbeatWriteTolerance)
                  yield* Effect.yieldNow
                  yield* Fiber.interrupt(fiber)
                  return reconfirms >= 1 && lapses === 0
                }
                // lapseFenceLost -> fiber self-interrupts after calling onLapse
                yield* TestClock.adjust(Ownership.heartbeatWriteTolerance)
                yield* Effect.yieldNow
                const exit = yield* Fiber.await(fiber)
                return exit._tag === "Failure" && lapses === 1
              })
            ).pipe(
              Effect.provide(fakeStore),
              Effect.provide(TestClock.layer())
            )

            return loopResult
          }),
        { seed: seed + 3, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
