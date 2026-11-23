import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Clock, Duration, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { AttemptStore, Migrations, Ownership, RunStore } from "../src/index.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const staleMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const skewMs = Duration.toMillis(Ownership.heartbeatSkewAllowance)

type Owner = Ownership.OwnerId
type Snapshot = RunStore.RunSnapshot
type Evidence = Ownership.LivenessEvidence
type EvidenceKind = Evidence["kind"]

const sameOwner = (left: Owner | null, right: Owner | null): boolean =>
  left === null || right === null
    ? left === right
    : left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

/** A violated invariant. Thrown inside a property so the finding names the broken rule. */
const must: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`invariant violated: ${message}`)
}

const storesLayer = (putMode: "insert" | "upsert") =>
  Layer.mergeAll(RunStore.layer, Layer.orDie(AttemptStore.layerWith({ putMode }))).pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
    Layer.orDie
  )

const runFuzz = async <A, R>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => Effect.Effect<boolean, never, R>,
  layer: (value: A) => Layer.Layer<R>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arbitrary,
      (value) => property(value).pipe(Effect.provide(layer(value)), Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** An outcome or typed failure, flattened to one comparable string. */
const seen = <A>(
  effect: Effect.Effect<A, { readonly code: string }>,
  show: (value: A) => string
): Effect.Effect<string> => Effect.match(effect, { onFailure: (error) => `error:${error.code}`, onSuccess: show })

const tag = (outcome: { readonly _tag: string }) => outcome._tag
const claimTag = (outcome: RunStore.StealOutcome) =>
  outcome._tag === "Claimed" ? `Claimed@${outcome.claimedAtMs}` : outcome._tag
const cancelTag = (outcome: RunStore.RequestCancelOutcome) =>
  outcome._tag === "Terminal"
    ? `Terminal:${outcome.status}`
    : outcome._tag === "NotFound"
    ? outcome._tag
    : `${outcome._tag}@${outcome.requestedAtMs}`

interface LeaseRow {
  readonly owner_host_id: string | null
  readonly owner_pid: number | null
  readonly owner_nonce: string | null
  readonly granted_at_ms: number | null
  readonly heartbeat_at_ms: number | null
  readonly claim_host_id: string | null
  readonly claim_pid: number | null
  readonly claim_nonce: string | null
  readonly claimed_at_ms: number | null
}

/** The consensus lease a run's ownership is fenced through, read straight from SQLite. */
const leaseOf = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.map(
    sql<LeaseRow>`
      SELECT owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms,
        claim_host_id, claim_pid, claim_nonce, claimed_at_ms
      FROM flows_consensus_leases WHERE run_id = ${runId}
    `,
    (rows) => {
      const row = rows[0]
      if (row === undefined) return undefined
      return {
        owner: row.owner_host_id === null
          ? null
          : { hostId: row.owner_host_id, pid: Number(row.owner_pid), nonce: String(row.owner_nonce) },
        grantedAtMs: row.granted_at_ms === null ? null : Number(row.granted_at_ms),
        heartbeatAtMs: row.heartbeat_at_ms === null ? null : Number(row.heartbeat_at_ms),
        claim: row.claim_host_id === null
          ? null
          : { hostId: row.claim_host_id, pid: Number(row.claim_pid), nonce: String(row.claim_nonce) },
        claimedAtMs: row.claimed_at_ms === null ? null : Number(row.claimed_at_ms)
      }
    }
  )

const evidenceValid = (expectedOwner: Owner, observer: Owner, nowMs: number, evidence: Evidence): boolean =>
  sameOwner(expectedOwner, evidence.expectedOwner) && evidence.checkedAtMs === nowMs &&
  (evidence.kind === "lease-expired" ||
    (evidence.kind === "same-host-pid-dead") === (expectedOwner.hostId === observer.hostId))

const provesDeath = (evidence: Evidence, claimant: Owner): boolean =>
  evidence.kind === "same-host-pid-dead" && evidence.expectedOwner.pid !== claimant.pid

describe("@smthrs/run-store state machine, lease generations and claim races", () => {
  // -------------------------------------------------------------------------
  // Reference state machine
  // -------------------------------------------------------------------------

  const owners: Record<"a" | "b" | "c", Owner> = {
    a: { hostId: "host-a", pid: 1001, nonce: "nonce-a" },
    b: { hostId: "host-b", pid: 1002, nonce: "nonce-b" },
    c: { hostId: "host-a", pid: 1003, nonce: "nonce-c" }
  }
  const ownerKeys = ["a", "b", "c"] as const
  const runIds = ["run-0", "run-1", "run-2"] as const
  const digests = ["step-x", "step-y"] as const

  const OwnerKey = Schema.Literals(ownerKeys)
  const times = <A>(count: number, value: A): ReadonlyArray<A> => Array.from({ length: count }, () => value)

  // One flat operation record. Its fields default to what the model says is current, so most operations
  // are enabled and sequences reach deep states; the minority values are the adversarial twists: a stale
  // snapshot, a spent token, a skewed clock reading, evidence about the wrong owner, a writer that is not
  // the holder.
  const Op = Schema.Struct({
    _tag: Schema.Literals([
      ...times(2, "claim" as const),
      ...times(5, "claimAndOwn" as const),
      ...times(3, "steal" as const),
      ...times(3, "activate" as const),
      "abandon",
      ...times(2, "recover" as const),
      ...times(3, "heartbeat" as const),
      "reconfirm",
      ...times(3, "transition" as const),
      "requestCancel",
      "ackCancel",
      ...times(3, "attemptPut" as const),
      ...times(2, "attemptHeartbeat" as const),
      ...times(2, "attemptPatch" as const),
      ...times(2, "attemptFinish" as const),
      ...times(3, "advance" as const),
      "remember",
      "read",
      "create"
    ]),
    run: Schema.Literals([0, 0, 0, 1, 1, 2]),
    /** Aim at a run, or an attempt, the operation can act on when the model has one. */
    prefer: Schema.Literals([true, true, true, false]),
    owner: OwnerKey,
    actor: Schema.Literals([...times(5, "holder" as const), "claimer", "a", "b", "c"]),
    snap: Schema.Literals([...times(5, "current" as const), "remembered", "pending", "forged"]),
    offset: Schema.Literals([...times(6, 0), -1, -35_000, 5_000, 10_000, 10_001, 60_000]),
    withEvidence: Schema.Literals([true, true, true, false]),
    kind: Schema.Literals([
      ...times(4, "auto" as const),
      "lease-expired",
      "same-host-pid-dead",
      "cross-host-unreachable-stale"
    ]),
    about: Schema.Literals([...times(5, "snapshotOwner" as const), "other"]),
    exact: Schema.Literals([...times(5, true), false]),
    token: Schema.Literals([...times(5, "current" as const), "staleToken", "wrongOwner"]),
    to: Schema.Literals([
      ...times(3, "running" as const),
      ...times(3, "suspended" as const),
      "completed",
      "failed",
      "cancelled",
      "pending"
    ]),
    stateArg: Schema.Literals(["omit", "new", "same"]),
    cancelGuard: Schema.Literals(["none", "none", "none", "absent", "present"]),
    restorePending: Schema.Literals([false, false, true]),
    lineage: Schema.Boolean,
    digest: Schema.Literals([0, 1]),
    attempt: Schema.Literals([0, 1]),
    putState: Schema.Literals(["running", "running", "running", "completed"]),
    finishState: Schema.Literals(["completed", "failed"]),
    beatOffset: Schema.Literals([0, 0, -500, 500]),
    flagA: Schema.Boolean,
    flagB: Schema.Boolean,
    value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    // 30 000 ms is exactly `heartbeatStaleAfter`: a lease or claim that old is still live, one ms later it is not.
    ms: Schema.Literals([1, 1_000, 9_000, 30_000, 30_000, 31_000, 31_000])
  })
  type Operation = typeof Op.Type

  interface ModelRun {
    status: RunStore.RunStatus
    owner: Owner | null
    heartbeatAtMs: number | null
    grantedAtMs: number | null
    claim: Owner | null
    claimedAtMs: number | null
    cancelRequestedAtMs: number | null
    stateJson: string
    readonly createdAtMs: number
    startedAtMs: number | null
    finishedAtMs: number | null
    /** How many times ownership was granted: the generation a fenced write belongs to. */
    epoch: number
    remembered: Snapshot
  }

  it("every RunStore and AttemptStore operation matches a reference state machine, step by step", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        putMode: Schema.Literals(["insert", "upsert"]),
        ops: Schema.Array(Op).check(Schema.isMinLength(12), Schema.isMaxLength(40))
      })
    )

    await runFuzz(
      arbitrary,
      ({ ops, putMode }) =>
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const sql = yield* SqlClient.SqlClient
          yield* TestClock.setTime(1_000_000)
          const clock = Clock.currentTimeMillis.pipe(Effect.map(Math.floor))

          const runs = new Map<string, ModelRun>()
          const stored = new Map<string, AttemptStore.Attempt>()
          let stateCounter = 0
          const nextState = () => JSON.stringify({ step: ++stateCounter })
          const pendingSnapshot: Snapshot = { status: "pending", owner: null, heartbeatAtMs: null }

          const createModel = (runId: string, stateJson: string, createdAtMs: number) =>
            runs.set(runId, {
              status: "pending",
              owner: null,
              heartbeatAtMs: null,
              grantedAtMs: null,
              claim: null,
              claimedAtMs: null,
              cancelRequestedAtMs: null,
              stateJson,
              createdAtMs,
              startedAtMs: null,
              finishedAtMs: null,
              epoch: 0,
              remembered: pendingSnapshot
            })

          const snapshotOf = (run: ModelRun | undefined): Snapshot =>
            run === undefined
              ? pendingSnapshot
              : { status: run.status, owner: run.owner, heartbeatAtMs: run.heartbeatAtMs }
          const matches = (run: ModelRun, expected: Snapshot) =>
            run.status === expected.status && sameOwner(run.owner, expected.owner) &&
            run.heartbeatAtMs === expected.heartbeatAtMs
          const owned = (run: ModelRun | undefined, owner: Owner): run is ModelRun =>
            run !== undefined && run.status === "running" && sameOwner(run.owner, owner)
          const claimLoss = (run: ModelRun | undefined, nowMs: number) =>
            run === undefined
              ? "NotFound"
              : run.claim !== null
              ? "AlreadyClaimed"
              : run.status === "running" && run.heartbeatAtMs !== null && run.heartbeatAtMs >= nowMs - staleMs
              ? "HeartbeatFresh"
              : "SnapshotChanged"
          const claimMatches = (run: ModelRun | undefined, claimant: Owner, claimedAtMs: number): run is ModelRun =>
            run !== undefined && run.claim !== null && sameOwner(run.claim, claimant) &&
            run.claimedAtMs === claimedAtMs
          const grant = (run: ModelRun, owner: Owner, grantedAtMs: number, heartbeatAtMs: number) => {
            run.status = "running"
            run.startedAtMs = run.startedAtMs ?? heartbeatAtMs
            run.finishedAtMs = null
            run.owner = owner
            run.heartbeatAtMs = heartbeatAtMs
            run.grantedAtMs = grantedAtMs
            run.claim = null
            run.claimedAtMs = null
            run.epoch += 1
          }
          const pickSnapshot = (
            choice: Operation["snap"],
            run: ModelRun | undefined,
            claimant: Owner,
            nowMs: number
          ): Snapshot =>
            choice === "current"
              ? snapshotOf(run)
              : choice === "remembered"
              ? run?.remembered ?? pendingSnapshot
              : choice === "pending"
              ? pendingSnapshot
              : {
                status: "running",
                owner: sameOwner(claimant, owners.a) ? owners.b : owners.a,
                heartbeatAtMs: nowMs
              }
          /** `auto` is the kind a real probe would report for this pair of identities. */
          const kindFor = (choice: Operation["kind"], expectedOwner: Owner, observer: Owner): EvidenceKind =>
            choice !== "auto"
              ? choice
              : expectedOwner.hostId === observer.hostId && expectedOwner.pid !== observer.pid
              ? "same-host-pid-dead"
              : "lease-expired"
          const pickEvidence = (op: Operation, expected: Snapshot, claimant: Owner, nowMs: number): Evidence => {
            const expectedOwner = op.about === "snapshotOwner" && expected.owner !== null
              ? expected.owner
              : sameOwner(claimant, owners.c)
              ? owners.a
              : owners.c
            return {
              expectedOwner,
              checkedAtMs: op.exact ? nowMs : Math.max(0, nowMs - 1),
              kind: kindFor(op.kind, expectedOwner, claimant)
            }
          }
          const pickToken = (choice: Operation["token"], run: ModelRun | undefined, owner: Owner) => ({
            claimant: choice === "wrongOwner" ? owner : run?.claim ?? owner,
            claimedAtMs: Math.max(0, (run?.claimedAtMs ?? 7) - (choice === "staleToken" ? 1 : 0))
          })
          const actorOf = (actor: Operation["actor"], run: ModelRun | undefined): Owner =>
            actor === "holder"
              ? run?.owner ?? owners.a
              : actor === "claimer"
              ? run?.claim ?? owners.b
              : owners[actor]
          const enabledOn = (op: Operation, run: ModelRun): boolean =>
            op._tag === "claim"
              ? (run.status === "pending" || run.status === "suspended") && run.claim === null
              : op._tag === "activate" || op._tag === "abandon" || op._tag === "recover"
              ? run.claim !== null
              : run.status === "running"
          const runFor = (op: Operation): string => {
            const indexed = runIds[op.run]
            const unaimed = op._tag === "create" || op._tag === "read" || op._tag === "remember" ||
              op._tag === "claimAndOwn" || op._tag === "requestCancel"
            if (!op.prefer || unaimed) return indexed
            const enabled = runIds.filter((runId) => {
              const run = runs.get(runId)
              return run !== undefined && enabledOn(op, run)
            })
            return enabled[op.value % Math.max(1, enabled.length)] ?? indexed
          }
          const attemptKey = (runId: string, digest: string, attempt: number) => `${runId}|${digest}|${attempt}`
          const sameAttempt = (left: AttemptStore.Attempt, right: AttemptStore.Attempt) =>
            left.state === right.state && left.startedAtMs === right.startedAtMs &&
            left.finishedAtMs === right.finishedAtMs && left.heartbeatAtMs === right.heartbeatAtMs &&
            JSON.stringify([left.checkpoint, left.error, left.outcome, left.meta]) ===
              JSON.stringify([right.checkpoint, right.error, right.outcome, right.meta])

          /** The whole persisted state agrees with the model: rows, the consensus lease mirror, and attempts. */
          const expectStore = (label: string) =>
            Effect.gen(function*() {
              for (const runId of runIds) {
                const model = runs.get(runId)
                const lease = yield* leaseOf(sql, runId)
                if (model === undefined) {
                  expect(yield* seen(store.get(runId), () => "found"), `${label}: ${runId}`).toBe("error:not_found_row")
                  must(lease === undefined, `${label}: ${runId} has a lease but no row`)
                  continue
                }
                const row = yield* store.get(runId)
                expect(
                  {
                    status: row.status,
                    owner: row.owner,
                    heartbeatAtMs: row.heartbeatAtMs,
                    claim: row.claim,
                    claimedAtMs: row.claimedAtMs,
                    cancelRequestedAtMs: row.cancelRequestedAtMs,
                    stateJson: row.stateJson,
                    createdAtMs: row.createdAtMs,
                    startedAtMs: row.startedAtMs,
                    finishedAtMs: row.finishedAtMs
                  },
                  `${label}: ${runId} row`
                ).toEqual({
                  status: model.status,
                  owner: model.owner,
                  heartbeatAtMs: model.heartbeatAtMs,
                  claim: model.claim,
                  claimedAtMs: model.claimedAtMs,
                  cancelRequestedAtMs: model.cancelRequestedAtMs,
                  stateJson: model.stateJson,
                  createdAtMs: model.createdAtMs,
                  startedAtMs: model.startedAtMs,
                  finishedAtMs: model.finishedAtMs
                })
                // Ownership columns are a mirror of the lease the consensus strategy fences with.
                expect(lease, `${label}: ${runId} lease`).toEqual(
                  model.owner === null && model.claim === null ? undefined : {
                    owner: model.owner,
                    grantedAtMs: model.grantedAtMs,
                    heartbeatAtMs: model.heartbeatAtMs,
                    claim: model.claim,
                    claimedAtMs: model.claimedAtMs
                  }
                )
                must(
                  (row.status === "running") === (row.owner !== null),
                  `${label}: ${runId} is owned exactly while running`
                )
                const listed = attempts.listRun === undefined ? [] : yield* attempts.listRun(runId)
                expect(listed, `${label}: ${runId} attempts`).toEqual(
                  [...stored.values()]
                    .filter((attempt) => attempt.runId === runId)
                    .sort((left, right) =>
                      left.stepKeyDigest === right.stepKeyDigest
                        ? left.attempt - right.attempt
                        : left.stepKeyDigest < right.stepKeyDigest
                        ? -1
                        : 1
                    )
                )
              }
            })

          /** Every identity that does not hold the run is fenced out of every write, and changes nothing. */
          const expectFenced = (label: string, runId: string, run: ModelRun) =>
            Effect.gen(function*() {
              const nowMs = yield* clock
              for (const key of ownerKeys) {
                const intruder = owners[key]
                if (owned(run, intruder)) continue
                const refusals = [
                  yield* seen(store.heartbeat(runId, intruder, nowMs), tag),
                  yield* seen(store.reconfirm(runId, intruder, nowMs), tag),
                  yield* seen(store.transitionOwned(runId, intruder, "completed", nextState()), tag),
                  yield* seen(store.transitionOwned(runId, intruder, "running", nextState()), tag),
                  yield* seen(
                    attempts.put(
                      { runId, stepKeyDigest: "step-z", attempt: 9, state: "running", startedAtMs: nowMs, meta: {} },
                      intruder
                    ),
                    tag
                  )
                ]
                expect(refusals, `${label}: ${key} must be fenced`).toEqual(refusals.map(() => "FenceLost"))
                must(
                  !(yield* store.acknowledgeCancel(runId, intruder, nowMs)),
                  `${label}: ${key} acknowledged a cancel it does not own`
                )
              }
            })

          for (const runId of [runIds[0], runIds[1]]) {
            const state = nextState()
            yield* store.create(runId, state)
            createModel(runId, state, yield* clock)
          }
          // The first run starts held, so fenced writes have a live lease to succeed or fail against.
          const held = runs.get(runIds[0])
          must(held !== undefined, "the first run exists")
          expect(yield* seen(store.claimAndOwn(runIds[0], pendingSnapshot, owners.a, 1_000_000), tag)).toBe("Activated")
          grant(held, owners.a, 1_000_000, 1_000_000)

          yield* expectStore("initial")

          for (const [index, op] of ops.entries()) {
            const label = `op ${index} ${op._tag}`
            const clockMs = yield* clock
            if (op._tag === "advance") {
              yield* TestClock.adjust(Duration.millis(op.ms))
              continue
            }
            const runId = runFor(op)
            const run = runs.get(runId)
            const before = run === undefined ? undefined : { status: run.status, epoch: run.epoch }
            let want: string
            let got: string

            if (op._tag === "remember") {
              if (run !== undefined) run.remembered = snapshotOf(run)
              continue
            } else if (op._tag === "create") {
              const state = nextState()
              want = run === undefined ? "created" : "error:constraint"
              got = yield* seen(store.create(runId, state), () => "created")
              if (run === undefined) createModel(runId, state, clockMs)
            } else if (op._tag === "read") {
              want = run === undefined ? "error:not_found_row/0/error:not_found_row" : `${runId}/1/${runId}`
              const single = yield* seen(store.get(runId), (row) => row.runId)
              const lineage = yield* store.lineage(runId, { includeState: false })
              const latest = yield* seen(store.latestRound(runId), (row) => row.runId)
              got = `${single}/${lineage.length}/${latest}`
            } else if (op._tag === "claim") {
              const claimant = owners[op.owner]
              const nowMs = clockMs + op.offset
              const expected = pickSnapshot(op.snap, run, claimant, nowMs)
              if (nowMs > clockMs + skewMs) {
                want = "error:invalid_run"
              } else if (
                run !== undefined && (run.status === "pending" || run.status === "suspended") &&
                matches(run, expected) && run.claim === null
              ) {
                want = `Claimed@${nowMs}`
                run.claim = claimant
                run.claimedAtMs = nowMs
              } else {
                want = claimLoss(run, nowMs)
              }
              got = yield* seen(store.claim(runId, expected, claimant, nowMs), claimTag)
            } else if (op._tag === "claimAndOwn") {
              const owner = owners[op.owner]
              const nowMs = clockMs + op.offset
              const expected = pickSnapshot(op.snap, run, owner, nowMs)
              const evidence = op.withEvidence ? pickEvidence(op, expected, owner, nowMs) : undefined
              if (nowMs > clockMs + skewMs) {
                want = "error:invalid_run"
              } else if (
                expected.status === "running" && expected.owner !== null && !sameOwner(expected.owner, owner) &&
                !(evidence !== undefined && evidenceValid(expected.owner, owner, nowMs, evidence))
              ) {
                const loss = claimLoss(run, nowMs)
                want = loss === "SnapshotChanged" && run !== undefined && matches(run, expected)
                  ? "EvidenceRequired"
                  : loss
              } else if (
                run !== undefined && run.status !== "completed" && run.status !== "failed" &&
                run.status !== "cancelled" && matches(run, expected) && run.claim === null &&
                (run.status !== "running" || run.heartbeatAtMs === null || run.heartbeatAtMs < nowMs - staleMs ||
                  (evidence !== undefined && provesDeath(evidence, owner)))
              ) {
                want = "Activated"
                grant(run, owner, nowMs, nowMs)
              } else {
                want = claimLoss(run, nowMs)
              }
              got = yield* seen(store.claimAndOwn(runId, expected, owner, nowMs, evidence), tag)
            } else if (op._tag === "steal") {
              const claimant = owners[op.owner]
              const nowMs = clockMs + op.offset
              const expected = pickSnapshot(op.snap, run, claimant, nowMs)
              const evidence = pickEvidence(op, expected, claimant, nowMs)
              if (nowMs > clockMs + skewMs) {
                want = "error:invalid_run"
              } else if (
                !(expected.status === "running" && expected.owner !== null &&
                  evidenceValid(expected.owner, claimant, nowMs, evidence))
              ) {
                want = "LivenessUnconfirmed"
              } else if (
                run !== undefined && matches(run, expected) && run.claim === null && run.heartbeatAtMs !== null &&
                (run.heartbeatAtMs < nowMs - staleMs || provesDeath(evidence, claimant))
              ) {
                want = `Claimed@${nowMs}`
                run.claim = claimant
                run.claimedAtMs = nowMs
              } else {
                want = claimLoss(run, nowMs)
              }
              got = yield* seen(store.steal(runId, expected, claimant, nowMs, evidence), claimTag)
            } else if (op._tag === "activate") {
              const token = pickToken(op.token, run, owners[op.owner])
              const expected = pickSnapshot(op.snap, run, token.claimant, clockMs)
              if (!claimMatches(run, token.claimant, token.claimedAtMs)) {
                want = "ClaimLost"
              } else if (!matches(run, expected)) {
                want = "SnapshotChanged"
                run.claim = null
                run.claimedAtMs = null
              } else {
                want = "Activated"
                grant(run, token.claimant, token.claimedAtMs, clockMs)
              }
              got = yield* seen(store.activate(runId, token.claimant, token.claimedAtMs, expected), tag)
            } else if (op._tag === "abandon") {
              const token = pickToken(op.token, run, owners[op.owner])
              if (claimMatches(run, token.claimant, token.claimedAtMs)) {
                want = "Abandoned"
                run.claim = null
                run.claimedAtMs = null
              } else {
                want = "ClaimLost"
              }
              got = yield* seen(store.abandonClaim(runId, token.claimant, token.claimedAtMs), tag)
            } else if (op._tag === "recover") {
              const observer = owners[op.owner]
              const token = pickToken(op.token, run, observer)
              const nowMs = clockMs + op.offset
              const evidence: Evidence = {
                expectedOwner: token.claimant,
                checkedAtMs: op.exact ? nowMs : Math.max(0, nowMs - 1),
                kind: kindFor(op.kind, token.claimant, observer)
              }
              if (nowMs > clockMs + skewMs) {
                want = "error:invalid_run"
              } else if (!evidenceValid(token.claimant, observer, nowMs, evidence)) {
                want = "LivenessUnconfirmed"
              } else if (run === undefined) {
                want = "NotFound"
              } else if (!claimMatches(run, token.claimant, token.claimedAtMs)) {
                want = "ClaimChanged"
              } else if (token.claimedAtMs >= nowMs - staleMs) {
                want = "ClaimFresh"
              } else {
                want = "Recovered"
                run.claim = null
                run.claimedAtMs = null
              }
              got = yield* seen(
                store.recoverClaim(runId, token.claimant, token.claimedAtMs, observer, nowMs, evidence),
                tag
              )
            } else if (op._tag === "heartbeat" || op._tag === "reconfirm") {
              const owner = actorOf(op.actor, run)
              const nowMs = clockMs + op.offset
              const held = owned(run, owner) && (op._tag === "heartbeat" || run.claim === null)
              if (nowMs > clockMs + skewMs) {
                want = "error:invalid_run"
              } else if (run === undefined) {
                want = "NotFound"
              } else if (held) {
                want = "Updated"
                // A renewal never moves the lease back.
                run.heartbeatAtMs = Math.max(run.heartbeatAtMs ?? 0, nowMs)
              } else {
                want = "FenceLost"
              }
              got = yield* seen(
                op._tag === "heartbeat"
                  ? store.heartbeat(runId, owner, nowMs)
                  : store.reconfirm(runId, owner, nowMs),
                tag
              )
            } else if (op._tag === "transition") {
              const owner = actorOf(op.actor, run)
              const state = op.stateArg === "omit"
                ? undefined
                : op.stateArg === "new"
                ? nextState()
                : run?.stateJson ?? "{}"
              const guard: RunStore.TransitionGuard | undefined = op.cancelGuard === "none" && !op.restorePending
                ? undefined
                : {
                  ...(op.cancelGuard === "none" ? {} : { cancelRequested: op.cancelGuard }),
                  ...(op.restorePending ? { restorePending: true as const } : {})
                }
              if (op.to === "pending" && (!op.restorePending || state === undefined)) {
                want = "error:invalid_run"
              } else if (run === undefined) {
                want = "NotFound"
              } else if (!owned(run, owner)) {
                want = "FenceLost"
              } else if (
                (op.cancelGuard === "absent" && run.cancelRequestedAtMs !== null) ||
                (op.cancelGuard === "present" && run.cancelRequestedAtMs === null) ||
                (op.to === "pending" && run.stateJson !== state)
              ) {
                want = "GuardFailed"
              } else {
                want = "Transitioned"
                run.stateJson = state ?? run.stateJson
                run.finishedAtMs = RunStore.isTerminalRunStatus(op.to) ? clockMs : null
                if (op.to !== "running") {
                  run.status = op.to
                  run.owner = null
                  run.heartbeatAtMs = null
                  run.grantedAtMs = null
                  run.claim = null
                  run.claimedAtMs = null
                }
              }
              got = yield* seen(store.transitionOwned(runId, owner, op.to, state, guard), tag)
            } else if (op._tag === "requestCancel") {
              if (run === undefined) {
                want = "NotFound"
              } else if (RunStore.isTerminalRunStatus(run.status)) {
                want = `Terminal:${run.status}`
              } else if (run.cancelRequestedAtMs !== null) {
                want = `AlreadyRequested@${run.cancelRequestedAtMs}`
              } else {
                want = `CancelRequested@${clockMs}`
                run.cancelRequestedAtMs = clockMs
              }
              got = yield* seen(
                op.lineage ? store.requestCancelLineage(runId, clockMs) : store.requestCancel(runId, clockMs),
                cancelTag
              )
            } else if (op._tag === "ackCancel") {
              const owner = actorOf(op.actor, run)
              want = String(owned(run, owner) && run.cancelRequestedAtMs !== null)
              got = yield* seen(store.acknowledgeCancel(runId, owner, clockMs), String)
            } else {
              const owner = actorOf(op.actor, run)
              const known = [...stored.values()].filter((attempt) => attempt.runId === runId)
              const aimed = op.prefer && op._tag !== "attemptPut"
                ? known[op.value % Math.max(1, known.length)]
                : undefined
              const stepKeyDigest = aimed?.stepKeyDigest ?? digests[op.digest]
              const attemptNumber = aimed?.attempt ?? op.attempt
              const key = attemptKey(runId, stepKeyDigest, attemptNumber)
              const existing = stored.get(key)
              const id = { runId, stepKeyDigest, attempt: attemptNumber }
              const holds = owned(run, owner)
              const miss = existing === undefined ? "NotFound" : !holds ? "FenceLost" : "StateChanged"
              if (op._tag === "attemptPut") {
                const candidate: AttemptStore.Attempt = {
                  ...id,
                  state: op.putState,
                  startedAtMs: clockMs,
                  checkpoint: { at: op.value },
                  meta: { put: op.value }
                }
                if (run === undefined) {
                  want = "RunNotFound"
                } else if (!holds) {
                  want = "FenceLost"
                } else if (existing === undefined) {
                  want = "Inserted"
                  stored.set(key, candidate)
                } else if (putMode === "upsert" && existing.state === "running") {
                  want = "Upserted"
                  stored.set(key, candidate)
                } else {
                  want = sameAttempt(existing, candidate) ? "ExistingSame" : "Conflict"
                }
                got = yield* seen(attempts.put(candidate, owner), tag)
              } else if (op._tag === "attemptHeartbeat") {
                const nowMs = clockMs + op.beatOffset
                const checkpoint = op.flagA ? { beat: nowMs } : undefined
                if (existing !== undefined && holds && existing.state === "running") {
                  want = "Updated"
                  stored.set(key, {
                    ...existing,
                    heartbeatAtMs: Math.max(existing.heartbeatAtMs ?? nowMs, nowMs),
                    ...(checkpoint === undefined ? {} : { checkpoint })
                  })
                } else {
                  want = miss
                }
                got = yield* seen(
                  attempts.heartbeat(runId, stepKeyDigest, attemptNumber, owner, nowMs, checkpoint),
                  tag
                )
              } else if (op._tag === "attemptPatch") {
                const patch: AttemptStore.AttemptPatch = {
                  ...(op.flagA ? { meta: { patched: op.value } } : {}),
                  ...(op.flagB ? { error: { reason: op.value } } : {})
                }
                if (existing !== undefined && holds) {
                  want = "Patched"
                  stored.set(key, { ...existing, ...patch })
                } else {
                  want = existing === undefined ? "NotFound" : "FenceLost"
                }
                got = yield* seen(attempts.patch(id, patch, owner), tag)
              } else {
                const outcome = op.flagA ? { outcome: { result: op.value } } : {}
                if (existing !== undefined && holds && existing.state === "running") {
                  want = "Finished"
                  stored.set(key, { ...existing, state: op.finishState, finishedAtMs: clockMs, ...outcome })
                } else {
                  want = miss
                }
                got = yield* seen(
                  attempts.finish({ ...id, state: op.finishState, finishedAtMs: clockMs, ...outcome }, owner),
                  tag
                )
              }
              const read = yield* attempts.get(id)
              expect(Option.getOrUndefined(read), `${label}: attempt read back`).toEqual(stored.get(key))
            }

            expect(got, label).toBe(want)
            yield* expectStore(label)

            // One claim per snapshot: a rival repeating a granted claim or steal is told it is taken.
            if ((op._tag === "claim" || op._tag === "steal") && want.startsWith("Claimed@") && run !== undefined) {
              const rival = sameOwner(owners[op.owner], owners.b) ? owners.c : owners.b
              const nowMs = clockMs + op.offset
              const expected = snapshotOf(run)
              const repeat = expected.owner === null
                ? yield* seen(store.claim(runId, expected, rival, nowMs), claimTag)
                : yield* seen(
                  store.steal(runId, expected, rival, nowMs, {
                    expectedOwner: expected.owner,
                    checkedAtMs: nowMs,
                    kind: "lease-expired"
                  }),
                  claimTag
                )
              expect(repeat, `${label}: rival repeat`).toBe("AlreadyClaimed")
              yield* expectStore(`${label} rival repeat`)
            }

            const after = runs.get(runId)
            if (before !== undefined && after !== undefined) {
              // A settled run never leaves its status, and ownership generations only move forward.
              if (RunStore.isTerminalRunStatus(before.status)) {
                must(after.status === before.status && after.owner === null, `${label}: a terminal run changed`)
              }
              must(after.epoch >= before.epoch, `${label}: the ownership generation went backwards`)
              if (after.epoch > before.epoch) yield* expectFenced(label, runId, after)
            }
          }

          for (const runId of runIds) {
            const run = runs.get(runId)
            if (run !== undefined) yield* expectFenced("final", runId, run)
          }
          yield* expectStore("final")
          return true
        }).pipe(Effect.orDie),
      ({ putMode }) => Layer.mergeAll(storesLayer(putMode), TestClock.layer()),
      { seed: seed + 21, executions: Math.min(ioExecutions * 2, 100) }
    )
  }, 120_000)

  // -------------------------------------------------------------------------
  // Lease generations and terminal absorption
  // -------------------------------------------------------------------------

  it("an expired lease is reclaimed under a strictly newer generation, deposed owners stay fenced, and a settled run never runs again", async () => {
    const Barrage = Schema.Struct({
      actor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
      action: Schema.Literals([
        "claim",
        "claimAndOwn",
        "claimAndOwnEvidence",
        "steal",
        "activate",
        "abandon",
        "heartbeat",
        "reconfirm",
        "toRunning",
        "toSuspended",
        "toPending",
        "toTerminal",
        "requestCancel",
        "requestCancelLineage",
        "ackCancel",
        "attemptFinish",
        "attemptPut",
        "advance"
      ]),
      kind: Schema.Literals(["lease-expired", "same-host-pid-dead", "cross-host-unreachable-stale"])
    })
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        generations: Schema.Array(
          Schema.Struct({
            path: Schema.Literals(["claimAndOwn", "stealThenActivate"]),
            evidence: Schema.Literals(["lease-expired", "probe"]),
            wait: Schema.Literals([30_001, 45_000, 120_000]),
            abandonedClaim: Schema.Boolean,
            renewals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
            crossHost: Schema.Boolean
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
        terminal: Schema.Literals(["completed", "failed", "cancelled"]),
        cancelFirst: Schema.Boolean,
        barrage: Schema.Array(Barrage).check(Schema.isMaxLength(14))
      })
    )

    await runFuzz(
      arbitrary,
      (input) =>
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const sql = yield* SqlClient.SqlClient
          yield* TestClock.setTime(5_000_000)
          const clock = Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
          const runId = "run-generations"
          yield* store.create(runId, JSON.stringify({ generation: -1 }))

          // Each generation is a fresh process incarnation: its own pid and nonce.
          const incarnation = (generation: number, hostId: string): Owner => ({
            hostId,
            pid: 2_000 + generation,
            nonce: `incarnation-${generation}`
          })
          const tenures: Array<{ owner: Owner; token: number }> = []
          const everything = Effect.gen(function*() {
            return {
              row: yield* store.get(runId),
              lease: yield* leaseOf(sql, runId),
              attempts: attempts.listRun === undefined ? [] : yield* attempts.listRun(runId)
            }
          })

          /** Every fenced write a deposed incarnation can still issue is refused and leaves no trace. */
          const expectDeposedFenced = (label: string) =>
            Effect.gen(function*() {
              const before = yield* everything
              const nowMs = yield* clock
              const current = before.row.owner
              for (const [generation, tenure] of tenures.entries()) {
                if (sameOwner(tenure.owner, current)) continue
                const who = `${label}: generation ${generation}`
                const outcomes = [
                  yield* seen(store.heartbeat(runId, tenure.owner, nowMs), tag),
                  yield* seen(store.reconfirm(runId, tenure.owner, nowMs), tag),
                  yield* seen(
                    store.transitionOwned(runId, tenure.owner, "completed", JSON.stringify({ by: who })),
                    tag
                  ),
                  yield* seen(store.transitionOwned(runId, tenure.owner, "running", JSON.stringify({ by: who })), tag),
                  yield* seen(store.transitionOwned(runId, tenure.owner, "suspended"), tag),
                  yield* seen(
                    attempts.put(
                      {
                        runId,
                        stepKeyDigest: "step-late",
                        attempt: generation,
                        state: "running",
                        startedAtMs: nowMs,
                        meta: {}
                      },
                      tenure.owner
                    ),
                    tag
                  )
                ]
                expect(outcomes, who).toEqual(outcomes.map(() => "FenceLost"))
                // The claim token that made it owner is spent: it neither activates nor abandons anything.
                expect(yield* seen(store.activate(runId, tenure.owner, tenure.token, before.row), tag), who).toBe(
                  "ClaimLost"
                )
                expect(yield* seen(store.abandonClaim(runId, tenure.owner, tenure.token), tag), who).toBe("ClaimLost")
                must(!(yield* store.acknowledgeCancel(runId, tenure.owner, nowMs)), `${who} acknowledged a cancel`)
                for (const attempt of before.attempts) {
                  const id = { runId, stepKeyDigest: attempt.stepKeyDigest, attempt: attempt.attempt }
                  const late = [
                    yield* seen(
                      attempts.heartbeat(runId, id.stepKeyDigest, id.attempt, tenure.owner, nowMs, { late: true }),
                      tag
                    ),
                    yield* seen(attempts.patch(id, { meta: { late: true } }, tenure.owner), tag),
                    yield* seen(attempts.finish({ ...id, state: "completed", finishedAtMs: nowMs }, tenure.owner), tag)
                  ]
                  expect(late, `${who} attempt ${id.attempt}`).toEqual(late.map(() => "FenceLost"))
                }
              }
              expect(yield* everything, `${label}: deposed owners changed nothing`).toEqual(before)
            })

          let previousGrant = -1
          let previousHeartbeat = -1
          let firstStart: number | null = null
          for (const [generation, spec] of input.generations.entries()) {
            const label = `generation ${generation}`
            const holder = tenures[tenures.length - 1]?.owner
            const hostId = holder === undefined
              ? "host-a"
              : spec.crossHost === (holder.hostId === "host-a")
              ? "host-b"
              : "host-a"
            const claimant = incarnation(generation, hostId)
            let token: number

            if (holder === undefined) {
              const snapshot = yield* store.get(runId)
              const nowMs = yield* clock
              if (spec.path === "claimAndOwn") {
                expect(yield* seen(store.claimAndOwn(runId, snapshot, claimant, nowMs), tag), label).toBe("Activated")
              } else {
                expect(yield* seen(store.claim(runId, snapshot, claimant, nowMs), claimTag), label).toBe(
                  `Claimed@${nowMs}`
                )
                expect(yield* seen(store.activate(runId, claimant, nowMs, snapshot), tag), label).toBe("Activated")
              }
              token = nowMs
            } else {
              // The holder renews while it lives; each renewal is accepted and moves the lease forward only.
              for (let renewal = 0; renewal < spec.renewals; renewal++) {
                yield* TestClock.adjust(Duration.seconds(1))
                const beat = yield* clock
                expect(yield* seen(store.heartbeat(runId, holder, beat), tag), `${label} renewal`).toBe("Updated")
                expect(yield* seen(store.heartbeat(runId, holder, beat - 500), tag), `${label} late renewal`).toBe(
                  "Updated"
                )
                must((yield* store.get(runId)).heartbeatAtMs === beat, `${label}: a late renewal moved the lease back`)
              }
              // A live lease cannot be taken: not without evidence, and not by claiming it has expired.
              const live = yield* store.get(runId)
              const early = yield* clock
              const expired: Evidence = { expectedOwner: holder, checkedAtMs: early, kind: "lease-expired" }
              expect(yield* seen(store.claimAndOwn(runId, live, claimant, early), tag), `${label} early`).toBe(
                "HeartbeatFresh"
              )
              expect(yield* seen(store.claimAndOwn(runId, live, claimant, early, expired), tag), `${label} early`).toBe(
                "HeartbeatFresh"
              )
              expect(yield* seen(store.steal(runId, live, claimant, early, expired), claimTag), `${label} early`).toBe(
                "HeartbeatFresh"
              )
              expect(yield* store.get(runId), `${label}: an early takeover changed the run`).toEqual(live)

              // At exactly `heartbeatStaleAfter` the lease is still live; it expires one millisecond later.
              yield* TestClock.adjust(Duration.millis(staleMs))
              const cutoff = yield* clock
              expect(
                yield* seen(store.steal(runId, live, claimant, cutoff, { ...expired, checkedAtMs: cutoff }), claimTag),
                `${label} at the cutoff`
              ).toBe("HeartbeatFresh")
              yield* TestClock.adjust(Duration.millis(spec.wait - staleMs))
              const probedAt = yield* clock
              // Staleness alone is not consent: the claimant must bring evidence about this exact owner.
              expect(yield* seen(store.claimAndOwn(runId, live, claimant, probedAt), tag), `${label} bare`).toBe(
                "EvidenceRequired"
              )
              const forged: Evidence = { expectedOwner: claimant, checkedAtMs: probedAt, kind: "lease-expired" }
              expect(yield* seen(store.steal(runId, live, claimant, probedAt, forged), claimTag), `${label} forged`)
                .toBe(
                  "LivenessUnconfirmed"
                )
              const kind: EvidenceKind = spec.evidence === "lease-expired"
                ? "lease-expired"
                : holder.hostId === claimant.hostId
                ? "same-host-pid-dead"
                : "cross-host-unreachable-stale"
              expect(
                yield* seen(
                  store.steal(runId, live, claimant, probedAt, {
                    expectedOwner: holder,
                    checkedAtMs: probedAt - 1,
                    kind
                  }),
                  claimTag
                ),
                `${label} old probe`
              ).toBe("LivenessUnconfirmed")

              if (spec.abandonedClaim) {
                // A claimant that dies between steal and activate blocks the run until its claim is recovered,
                // and its claim is recoverable only once it is older than the cutoff.
                const doomed = incarnation(800 + generation, claimant.hostId)
                const taken: Evidence = { expectedOwner: holder, checkedAtMs: probedAt, kind: "lease-expired" }
                expect(yield* seen(store.steal(runId, live, doomed, probedAt, taken), claimTag), `${label} doomed`)
                  .toBe(
                    `Claimed@${probedAt}`
                  )
                expect(yield* seen(store.steal(runId, live, claimant, probedAt, taken), claimTag), `${label} blocked`)
                  .toBe(
                    "AlreadyClaimed"
                  )
                expect(yield* seen(store.claimAndOwn(runId, live, claimant, probedAt, taken), tag), `${label} blocked`)
                  .toBe(
                    "AlreadyClaimed"
                  )
                const recover = (claimedAtMs: number, at: number) =>
                  seen(
                    store.recoverClaim(runId, doomed, claimedAtMs, claimant, at, {
                      expectedOwner: doomed,
                      checkedAtMs: at,
                      kind: "lease-expired"
                    }),
                    tag
                  )
                yield* TestClock.adjust(Duration.millis(staleMs))
                const edge = yield* clock
                expect(yield* recover(probedAt, edge), `${label} claim at the cutoff`).toBe("ClaimFresh")
                yield* TestClock.adjust(Duration.millis(1))
                const late = yield* clock
                expect(yield* recover(probedAt - 1, late), `${label} wrong token`).toBe("ClaimChanged")
                expect(yield* recover(probedAt, late), `${label} recovered`).toBe("Recovered")
                expect(yield* recover(probedAt, late), `${label} recovered twice`).toBe("ClaimChanged")
                expect(yield* seen(store.activate(runId, doomed, probedAt, live), tag), `${label} spent claim`).toBe(
                  "ClaimLost"
                )
              }
              const nowMs = yield* clock
              const evidence: Evidence = { expectedOwner: holder, checkedAtMs: nowMs, kind }
              if (spec.path === "claimAndOwn") {
                expect(yield* seen(store.claimAndOwn(runId, live, claimant, nowMs, evidence), tag), label).toBe(
                  "Activated"
                )
              } else {
                expect(yield* seen(store.steal(runId, live, claimant, nowMs, evidence), claimTag), label).toBe(
                  `Claimed@${nowMs}`
                )
                // While the takeover is pending the old owner cannot reconfirm, and nobody else can claim.
                expect(yield* seen(store.reconfirm(runId, holder, nowMs), tag), `${label} pending`).toBe("FenceLost")
                const rival = incarnation(900 + generation, claimant.hostId)
                expect(
                  yield* seen(store.steal(runId, live, rival, nowMs, { ...evidence, kind: "lease-expired" }), claimTag),
                  label
                )
                  .toBe("AlreadyClaimed")
                expect(yield* seen(store.activate(runId, rival, nowMs, live), tag), `${label} rival`).toBe("ClaimLost")
                expect(yield* seen(store.activate(runId, claimant, nowMs, live), tag), label).toBe("Activated")
              }
              token = nowMs
            }
            tenures.push({ owner: claimant, token })

            const state = yield* everything
            must(
              sameOwner(state.row.owner, claimant) && state.row.status === "running",
              `${label}: claimant must own the run`
            )
            must(
              state.lease !== undefined && sameOwner(state.lease.owner, claimant),
              `${label}: the lease names another owner`
            )
            // The generation a lease was granted under, and its heartbeat, strictly increase across owners.
            must((state.lease.grantedAtMs ?? -1) > previousGrant, `${label}: the grant did not advance`)
            must((state.row.heartbeatAtMs ?? -1) > previousHeartbeat, `${label}: the heartbeat did not advance`)
            previousGrant = state.lease.grantedAtMs ?? -1
            previousHeartbeat = state.row.heartbeatAtMs ?? -1
            firstStart = firstStart ?? state.row.startedAtMs
            must(state.row.startedAtMs === firstStart, `${label}: a takeover rewrote the first start time`)

            const nowMs = yield* clock
            expect(
              yield* seen(
                attempts.put(
                  {
                    runId,
                    stepKeyDigest: "step-work",
                    attempt: generation,
                    state: "running",
                    startedAtMs: nowMs,
                    meta: { generation }
                  },
                  claimant
                ),
                tag
              ),
              `${label} attempt`
            ).toBe("Inserted")
            yield* expectDeposedFenced(label)
          }

          // Settle the run, then throw every operation at it from every identity that ever existed.
          const last = tenures[tenures.length - 1]
          must(last !== undefined, "at least one generation ran")
          if (input.cancelFirst) yield* store.requestCancel(runId, yield* clock)
          expect(yield* seen(store.transitionOwned(runId, last.owner, input.terminal), tag), "settle").toBe(
            "Transitioned"
          )
          const settled = yield* everything
          must(settled.row.status === input.terminal && settled.row.owner === null, "the run settled")
          must(settled.row.finishedAtMs !== null && settled.lease === undefined, "a settled run holds no lease")

          const forbidden = new Set([
            "Activated",
            "Updated",
            "Transitioned",
            "Abandoned",
            "Recovered",
            "Finished",
            "Inserted",
            "true"
          ])
          for (const [index, shot] of input.barrage.entries()) {
            const label = `barrage ${index} ${shot.action}`
            if (shot.action === "advance") {
              yield* TestClock.adjust(Duration.seconds(40))
              continue
            }
            const actor = tenures[shot.actor % (tenures.length + 1)]?.owner ?? incarnation(700 + index, "host-a")
            const token = tenures[shot.actor % tenures.length]?.token ?? 0
            const nowMs = yield* clock
            const row = yield* store.get(runId)
            const ghost: Snapshot = { status: "running", owner: last.owner, heartbeatAtMs: previousHeartbeat }
            const evidence: Evidence = { expectedOwner: last.owner, checkedAtMs: nowMs, kind: shot.kind }
            const result = shot.action === "claim"
              ? yield* seen(store.claim(runId, row, actor, nowMs), claimTag)
              : shot.action === "claimAndOwn"
              ? yield* seen(store.claimAndOwn(runId, row, actor, nowMs), tag)
              : shot.action === "claimAndOwnEvidence"
              ? yield* seen(store.claimAndOwn(runId, ghost, actor, nowMs, evidence), tag)
              : shot.action === "steal"
              ? yield* seen(store.steal(runId, ghost, actor, nowMs, evidence), claimTag)
              : shot.action === "activate"
              ? yield* seen(store.activate(runId, actor, token, row), tag)
              : shot.action === "abandon"
              ? yield* seen(store.abandonClaim(runId, actor, token), tag)
              : shot.action === "heartbeat"
              ? yield* seen(store.heartbeat(runId, actor, nowMs), tag)
              : shot.action === "reconfirm"
              ? yield* seen(store.reconfirm(runId, actor, nowMs), tag)
              : shot.action === "toRunning"
              ? yield* seen(store.transitionOwned(runId, actor, "running", JSON.stringify({ revived: index })), tag)
              : shot.action === "toSuspended"
              ? yield* seen(store.transitionOwned(runId, actor, "suspended"), tag)
              : shot.action === "toPending"
              ? yield* seen(
                store.transitionOwned(runId, actor, "pending", row.stateJson, { restorePending: true }),
                tag
              )
              : shot.action === "toTerminal"
              ? yield* seen(store.transitionOwned(runId, actor, "failed"), tag)
              : shot.action === "requestCancel"
              ? yield* seen(store.requestCancel(runId, nowMs), cancelTag)
              : shot.action === "requestCancelLineage"
              ? yield* seen(store.requestCancelLineage(runId, nowMs), cancelTag)
              : shot.action === "ackCancel"
              ? yield* seen(store.acknowledgeCancel(runId, actor, nowMs), String)
              : shot.action === "attemptFinish"
              ? yield* seen(
                attempts.finish({
                  runId,
                  stepKeyDigest: "step-work",
                  attempt: 0,
                  state: "completed",
                  finishedAtMs: nowMs
                }, actor),
                tag
              )
              : yield* seen(
                attempts.put(
                  {
                    runId,
                    stepKeyDigest: "step-after",
                    attempt: index,
                    state: "running",
                    startedAtMs: nowMs,
                    meta: {}
                  },
                  actor
                ),
                tag
              )
            must(
              !forbidden.has(result) && !result.startsWith("Claimed") && !result.startsWith("CancelRequested"),
              `${label} got ${result}`
            )
            if (shot.action === "requestCancel" || shot.action === "requestCancelLineage") {
              expect(result, label).toBe(`Terminal:${input.terminal}`)
            }
            // Nothing a settled run is asked to do changes its row, its lease, or its attempts.
            expect(yield* everything, `${label}: a settled run changed`).toEqual(settled)
          }
          return true
        }).pipe(Effect.orDie),
      () => Layer.mergeAll(storesLayer("insert"), TestClock.layer()),
      { seed: seed + 22, executions: ioExecutions }
    )
  })

  // -------------------------------------------------------------------------
  // Claim races
  // -------------------------------------------------------------------------

  it("concurrent claimants produce at most one winner per generation, typed losses for the rest, and no double claim", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        contenders: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
        rounds: Schema.Array(
          Schema.Struct({
            mode: Schema.Literals(["claimAndOwn", "claimThenActivate", "stealThenActivate"]),
            ownerFights: Schema.Literals(["no", "no", "suspend", "complete"])
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
        attemptRace: Schema.Boolean
      })
    )
    const losses = new Set(["AlreadyClaimed", "HeartbeatFresh", "SnapshotChanged", "ClaimLost", "LivenessUnconfirmed"])

    await runFuzz(
      arbitrary,
      (input) =>
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const sql = yield* SqlClient.SqlClient
          const runId = "run-race"
          yield* store.create(runId, JSON.stringify({ round: -1 }))
          const everyone: Array<Owner> = []
          let generation = 0

          for (const [round, spec] of input.rounds.entries()) {
            const label = `round ${round}`
            const snapshot = yield* store.get(runId)
            if (RunStore.isTerminalRunStatus(snapshot.status)) break
            const nowMs = Math.floor(yield* Clock.currentTimeMillis)
            const holder = snapshot.owner
            // Every contender is a distinct process on the holder's host, so a pid probe proves the holder gone.
            const contenders = Array.from({ length: input.contenders }, (_, index): Owner => ({
              hostId: "host-race",
              pid: 3_000 + round * 10 + index,
              nonce: `contender-${round}-${index}`
            }))
            const evidence: Evidence | undefined = holder === null
              ? undefined
              : { expectedOwner: holder, checkedAtMs: nowMs, kind: "same-host-pid-dead" }
            // A free run is claimed and a held one is stolen; `claimAndOwn` covers both.
            const mode = spec.mode === "claimAndOwn"
              ? spec.mode
              : holder === null
              ? "claimThenActivate"
              : "stealThenActivate"

            const contend = (owner: Owner): Effect.Effect<string> =>
              Effect.gen(function*() {
                if (mode === "claimAndOwn") {
                  return yield* seen(store.claimAndOwn(runId, snapshot, owner, nowMs, evidence), tag)
                }
                const claimed = yield* Effect.result(
                  mode === "stealThenActivate" && evidence !== undefined
                    ? store.steal(runId, snapshot, owner, nowMs, evidence)
                    : store.claim(runId, snapshot, owner, nowMs)
                )
                if (Result.isFailure(claimed)) return `error:${claimed.failure.code}`
                if (claimed.success._tag !== "Claimed") return claimed.success._tag
                return yield* seen(store.activate(runId, owner, claimed.success.claimedAtMs, snapshot), tag)
              })
            // The holder may race the takeover with its own last write: exactly one of the two lands.
            const fight = holder === null || spec.ownerFights === "no"
              ? Effect.succeed("absent")
              : seen(
                store.transitionOwned(runId, holder, spec.ownerFights === "suspend" ? "suspended" : "completed"),
                tag
              )
            // Identities deposed in earlier rounds hammer the run throughout and must never land a write.
            const ghosts = everyone.filter((owner) => !sameOwner(owner, holder))
            const haunt = Effect.forEach(
              ghosts,
              (ghost) =>
                Effect.all([
                  seen(store.heartbeat(runId, ghost, nowMs), tag),
                  seen(store.transitionOwned(runId, ghost, "failed"), tag)
                ]),
              { concurrency: "unbounded" }
            )

            const [results, fought, haunted] = yield* Effect.all(
              [Effect.forEach(contenders, contend, { concurrency: "unbounded" }), fight, haunt],
              { concurrency: "unbounded" }
            )

            const winners = contenders.filter((_, index) => results[index] === "Activated")
            for (const [index, result] of results.entries()) {
              must(
                result === "Activated" || losses.has(result),
                `${label}: contender ${index} got untyped loss ${result}`
              )
            }
            must(winners.length <= 1, `${label}: ${winners.length} contenders activated in one generation`)
            must(
              winners.length + (fought === "Transitioned" ? 1 : 0) === 1,
              `${label}: expected exactly one of takeover or holder write, got ${results.join(",")} and ${fought}`
            )
            expect(haunted.flat(), `${label}: deposed owners`).toEqual(haunted.flat().map(() => "FenceLost"))

            const row = yield* store.get(runId)
            const lease = yield* leaseOf(sql, runId)
            must(row.claim === null && (lease?.claim ?? null) === null, `${label}: a claim outlived the race`)
            const winner = winners[0]
            if (winner === undefined) {
              must(
                row.owner === null && row.status !== "running" && lease === undefined,
                `${label}: no winner yet owned`
              )
            } else {
              generation += 1
              must(sameOwner(row.owner, winner) && sameOwner(lease?.owner ?? null, winner), `${label}: winner must own`)
              must(row.status === "running", `${label}: the won run must be running`)
            }
            everyone.push(...contenders)

            // No double claim: exactly the winner can renew, and every other identity is fenced.
            const renewals = yield* Effect.forEach(
              everyone,
              (owner) => seen(store.heartbeat(runId, owner, nowMs), tag),
              { concurrency: "unbounded" }
            )
            expect(renewals.filter((result) => result === "Updated").length, `${label}: lease holders`).toBe(
              winner === undefined ? 0 : 1
            )
            must(
              renewals.every((result) => result === "Updated" || result === "FenceLost"),
              `${label}: renewals must be typed, got ${renewals.join(",")}`
            )
          }

          const final = yield* store.get(runId)
          if (input.attemptRace && final.owner !== null) {
            const owner = final.owner
            const id = { runId, stepKeyDigest: "step-race", attempt: generation }
            // One owner, many concurrent writers of one attempt: one insert, the rest observe the conflict.
            const puts = yield* Effect.forEach(
              Array.from({ length: input.contenders }, (_, index) => index),
              (index) =>
                seen(
                  attempts.put({ ...id, state: "running", startedAtMs: 1, meta: { writer: index } }, owner),
                  tag
                ),
              { concurrency: "unbounded" }
            )
            expect(puts.filter((result) => result === "Inserted").length, "attempt race winners").toBe(1)
            must(
              puts.every((result) => result === "Inserted" || result === "Conflict"),
              `attempt race losers must conflict, got ${puts.join(",")}`
            )
            const strangers = yield* Effect.forEach(
              everyone.filter((candidate) => !sameOwner(candidate, owner)),
              (stranger) =>
                seen(
                  attempts.put({ ...id, state: "running", startedAtMs: 1, meta: { stranger: true } }, stranger),
                  tag
                ),
              { concurrency: "unbounded" }
            )
            expect(strangers, "attempt race strangers").toEqual(strangers.map(() => "FenceLost"))
            const winnerIndex = puts.indexOf("Inserted")
            const read = yield* attempts.get(id)
            expect(Option.getOrUndefined(read)?.meta, "attempt race survivor").toEqual({ writer: winnerIndex })
          }
          return true
        }).pipe(Effect.orDie),
      () => storesLayer("insert"),
      {
        seed: seed + 23,
        executions: Math.min(ioExecutions, 30),
        execution: FuzzSimulation.execution()
      }
    )
  })
})
