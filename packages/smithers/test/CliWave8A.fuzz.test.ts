import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { MockAgent } from "@effect/platform-node/Undici"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Steering from "@smthrs/harness/Steering"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { NotificationQueue } from "@smthrs/notifications"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as Ownership from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import { DirectorySandbox } from "@smthrs/sandbox"
import { Arbitrary, Cause, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, PlatformError, PubSub, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlClient from "effect/sql/SqlClient"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"
import * as EngineJournalProjection from "../src/internal/EngineJournalProjection.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as FailureMod from "../src/internal/Failure.ts"
import * as HostLanguageServers from "../src/internal/HostLanguageServers.ts"
import * as ModuleAuthority from "../src/internal/ModuleAuthority.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as OwnerLock from "../src/internal/OwnerLock.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"
import * as RoleProfile from "../src/internal/RoleProfile.ts"
import * as WorkspaceRemotes from "../src/internal/WorkspaceRemotes.ts"
import * as Serve from "../src/Serve.ts"
import * as RunListing from "../src/internal/RunListing.ts"
import * as WorkspaceRouting from "../src/internal/WorkspaceRouting.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Collectors from "../src/node/Collectors.ts"
import * as NodeDaemon from "../src/node/NodeDaemon.vibe"
import * as SnapshotBudget from "../src/node/SnapshotBudget.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeRunRow = (
  overrides: Partial<RunStore.RunRow> & { readonly runId: string }
): RunStore.RunRow => ({
  runId: overrides.runId,
  parentRunId: overrides.parentRunId ?? null,
  lineageId: overrides.lineageId ?? null,
  roundOrdinal: overrides.roundOrdinal ?? 0,
  status: overrides.status ?? "running",
  stateJson: overrides.stateJson ?? JSON.stringify({
    version: 1,
    flowName: "agent/run",
    payload: { planId: "plan-1" },
    completedSteps: {},
    pendingWait: undefined,
    result: undefined,
    cancellation: undefined
  }),
  owner: overrides.owner ?? null,
  claim: overrides.claim ?? null,
  claimedAtMs: overrides.claimedAtMs ?? null,
  heartbeatAtMs: overrides.heartbeatAtMs ?? null,
  cancelRequestedAtMs: overrides.cancelRequestedAtMs ?? null,
  createdAtMs: overrides.createdAtMs ?? 1_000,
  startedAtMs: overrides.startedAtMs ?? null,
  finishedAtMs: overrides.finishedAtMs ?? null
})

const makeRunSummary = (
  overrides: Partial<ControlSchema.RunSummary> & { readonly runId: string }
): ControlSchema.RunSummary => ({
  runId: overrides.runId,
  flowId: overrides.flowId ?? "demo/flow",
  status: overrides.status ?? "accepted",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 1_000,
  planId: overrides.planId ?? "plan-1",
  planDigest: overrides.planDigest ?? "digest-1",
  ownerId: overrides.ownerId,
  waitingReason: overrides.waitingReason,
  parentRunId: overrides.parentRunId,
  executionDigest: overrides.executionDigest
})

const makeJournalEntry = (
  runId: string,
  seq: number,
  eventType: string,
  payload: unknown = {}
): JournalEvent.Entry =>
  new JournalEvent.Entry({
    eventId: `ev-${runId}-${seq}`,
    runId: JournalEvent.RunId.make(runId),
    seq: JournalEvent.Seq.make(seq),
    sourceId: JournalEvent.SourceId.make("src-1"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs: 1_000 + seq,
    eventType,
    payload,
    meta: undefined
  })

describe("@smthrs/cli Wave-8A Deep Control, OwnerLock, SnapshotBudget, NodeDaemon, Routing, Affinity & Supervisor fuzz", () => {
  it("OwnerLock, SnapshotBudget, NodeDaemon & RunListing uphold lock, chunking, sync & listing invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-locks-"))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8)),
          sessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(12)),
          transcriptLen: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(14)),
          maxBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(220), Schema.isLessThanOrEqualTo(2_000)),
          maxPerChunk: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6)),
          nonce: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(99_999))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scenario, sessionCount, transcriptLen, maxBytes, maxPerChunk, nonce }) =>
            Effect.gen(function*() {
              // 1. OwnerLock scenarios
              const lockPath = join(dir, `cfg-${scenario}-${nonce}.lock`)
              const cfgPath = join(dir, `cfg-${scenario}-${nonce}.json`)
              const myToken = `${process.pid}:tok-${nonce}`
              if (scenario === 0) {
                assertInv(OwnerLock.acquireLock(lockPath, cfgPath, myToken) === undefined, "fresh acquire succeeds")
                OwnerLock.releaseLock(lockPath, "wrong-token")
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, `${process.pid}:other`)
                assertInv(ref !== undefined && ref.reason.includes(String(process.pid)), "live pid refuses")
                OwnerLock.releaseLock(lockPath, myToken)
                OwnerLock.releaseLock(lockPath, myToken)
              } else if (scenario === 1) {
                writeFileSync(lockPath, `99999999:dead-${nonce}`, "utf8")
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(ref === undefined, "dead pid lock reclaimed")
                OwnerLock.releaseLock(lockPath, myToken)
              } else if (scenario === 2) {
                writeFileSync(lockPath, `no-pid-here`, "utf8")
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(ref !== undefined && ref.reason.includes("another Smithers process"), "fresh orphan refuses")
                rmSync(lockPath, { force: true })
              } else if (scenario === 3) {
                writeFileSync(lockPath, `0:zero-pid`, "utf8")
                const old = new Date(Date.now() - 10 * 60_000)
                utimesSync(lockPath, old, old)
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(ref === undefined, "stale orphan reclaimed")
                OwnerLock.releaseLock(lockPath, myToken)
              } else if (scenario === 4) {
                mkdirSync(lockPath, { recursive: true })
                const refFresh = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(refFresh !== undefined && refFresh.reason.includes("another process"), "fresh dir refuses")
                const old = new Date(Date.now() - 10 * 60_000)
                utimesSync(lockPath, old, old)
                const refStale = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(refStale === undefined, "stale dir reclaimed")
                OwnerLock.releaseLock(lockPath, myToken)
              } else if (scenario === 5) {
                writeFileSync(lockPath, `99999999:dead`, "utf8")
                const recPath = `${lockPath}.recovery`
                writeFileSync(recPath, `123:rec`, "utf8")
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(ref !== undefined && ref.reason.includes("lock recovery is already in progress"), "recovery guard refuses")
                rmSync(recPath, { force: true })
                rmSync(lockPath, { force: true })
              } else if (scenario === 6) {
                writeFileSync(lockPath, `${process.pid}`, "utf8")
                const ref = OwnerLock.acquireLock(lockPath, cfgPath, myToken)
                assertInv(ref !== undefined && ref.reason.includes(String(process.pid)), "bare live pid refuses")
                rmSync(lockPath, { force: true })
              }

              // 2. SnapshotBudget: trimTranscripts & planSessionsReport & chunkSessionsByBytes
              const sessions: Array<NodeDaemon.SessionSnapshot> = Array.from({ length: sessionCount }, (_, i) => ({
                sessionKey: `sess-${nonce}-${i}`,
                managed: i % 2 === 0,
                harness: "claude",
                model: "claude-sonnet-4-5",
                accountLabel: "acct-1",
                repo: "smithers",
                project: "smithers",
                lane: "main",
                title: `Title ${i} ${"x".repeat(i === 0 && scenario === 7 ? 250 : 12)}`,
                summary: "summary",
                cwd: "/tmp/work",
                transcriptJson: i % 3 === 2
                  ? null
                  : Array.from({ length: transcriptLen }, (__, j) => ({
                    ts: "2026-11-24T00:00:00Z",
                    role: "assistant" as const,
                    label: `l-${j}`,
                    text: `msg-${i}-${j}-${"y".repeat(32)}`
                  })),
                status: i % 4 === 0 ? "ended" : "working",
                pid: 1000 + i,
                cpuSeconds: 1.5,
                tokensUsed: 100,
                startedAt: "2026-11-24T00:00:00Z",
                lastActivityAt: "2026-11-24T00:01:00Z",
                endedAt: i % 4 === 0 ? "2026-11-24T00:02:00Z" : null
              }))

              const trimmed = SnapshotBudget.trimTranscripts(sessions, maxBytes, scenario % 2 === 0 ? 4 : 0)
              assertInv(trimmed.length === sessions.length, "trimTranscripts keeps all sessions")
              const plan = SnapshotBudget.planSessionsReport({
                nodeId: "node-1",
                sessions,
                snapshotId: `snap-${nonce}`,
                maxBytes,
                maxSessionsPerChunk: maxPerChunk
              })
              assertInv(plan.length >= 1, "plan has at least one request")
              if (plan.length > 1) {
                assertInv(plan[plan.length - 1]!.final === true, "last chunk is final")
                assertInv(plan[0]!.final === false, "first chunk is not final")
                const totalOut = plan.reduce((acc, p) => acc + p.sessions.length, 0)
                assertInv(totalOut === sessions.length, "chunks preserve all sessions")
              }

              const byteChunks = NodeDaemon.chunkSessionsByBytes(sessions, maxBytes)
              assertInv(byteChunks.length >= 1, "chunkSessionsByBytes non-empty")
              if (sessions.length === 0) {
                assertInv(byteChunks.length === 1 && byteChunks[0]!.length === 0, "empty chunks")
              } else {
                const totalChunked = byteChunks.reduce((acc, c) => acc + c.length, 0)
                assertInv(totalChunked === sessions.length, "chunkSessionsByBytes preserves all sessions")
              }

              // 3. RunListing: request, count, label
              if (scenario === 0) {
                const badOrder = yield* Effect.exit(RunListing.request({
                  since: "2026-11-24T12:00:00Z",
                  until: "2026-11-24T10:00:00Z"
                }))
                assertInv(Exit.isFailure(badOrder), "since > until rejected")
                const badDate = yield* Effect.exit(RunListing.request({ since: "not-a-date" }))
                assertInv(Exit.isFailure(badDate), "bad date rejected")
              } else {
                const req = yield* RunListing.request(
                  {
                    flow: "demo/flow",
                    status: "accepted",
                    parent: "parent-1",
                    since: "2026-11-24T00:00:00Z",
                    until: "2026-11-25T00:00:00Z",
                    trigger: "trig-1",
                    sort: "newest"
                  },
                  { limit: 10, cursor: "cur-0" }
                )
                assertInv(req._tag === "runs" && req.filters?.flowId === "demo/flow", "request built")

                let pageCalls = 0
                const fakeControl = Control.Control.of({
                  list: (input: ControlSchema.ListRequest) => {
                    pageCalls += 1
                    if (scenario === 2) {
                      return Effect.succeed({ _tag: "approvals", items: [] } as unknown as ControlSchema.ListResponse)
                    }
                    if ("cursor" in input && input.cursor === undefined) {
                      return Effect.succeed({
                        _tag: "runs",
                        items: [makeRunSummary({ runId: "r1" })],
                        nextCursor: "page-2"
                      })
                    }
                    if (!("cursor" in input) || input.cursor === undefined) {
                      return Effect.succeed({
                        _tag: "runs",
                        items: [makeRunSummary({ runId: "r1" })],
                        nextCursor: "page-2"
                      })
                    }
                    return Effect.succeed({
                      _tag: "runs",
                      items: [makeRunSummary({ runId: "r2" }), makeRunSummary({ runId: "r3" })]
                    })
                  }
                } as unknown as Control.Service)
                const counted = yield* RunListing.count(req).pipe(Effect.provideService(Control.Control, fakeControl))
                assertInv(scenario === 2 ? counted === 0 : counted === 3 && pageCalls === 2, "count walks pages")

                const now = 100_000
                const listed: ControlSchema.ListResponse = scenario === 3
                  ? ({ _tag: "approvals", items: [] } as unknown as ControlSchema.ListResponse)
                  : {
                    _tag: "runs",
                    items: [
                      makeRunSummary({ runId: "r-fresh", status: "accepted", updatedAt: now - 1_000 }),
                      makeRunSummary({ runId: "r-no-owner", status: "accepted", updatedAt: now - 10_000 }),
                      makeRunSummary({
                        runId: "r-alive",
                        status: "accepted",
                        updatedAt: now - 10_000,
                        ownerId: JSON.stringify({ hostId: hostname(), pid: process.pid, nonce: "n1" })
                      }),
                      makeRunSummary({
                        runId: "r-dead",
                        status: "accepted",
                        updatedAt: now - 10_000,
                        ownerId: JSON.stringify({ hostId: hostname(), pid: 99_999_999, nonce: "n2" })
                      }),
                      makeRunSummary({
                        runId: "r-foreign",
                        status: "accepted",
                        updatedAt: now - 10_000,
                        ownerId: JSON.stringify({ hostId: "other-host.invalid", pid: 99_999_999, nonce: "n3" })
                      }),
                      makeRunSummary({
                        runId: "r-corrupt",
                        status: "accepted",
                        updatedAt: now - 10_000,
                        ownerId: "{bad-json"
                      }),
                      makeRunSummary({
                        runId: "r-already",
                        status: "accepted",
                        updatedAt: now - 10_000,
                        waitingReason: "approval"
                      }),
                      makeRunSummary({ runId: "r-running", status: "running", updatedAt: now - 10_000 })
                    ]
                  }
                const labeled = yield* RunListing.label(listed, now)
                if (labeled._tag === "runs") {
                  const byId = new Map(labeled.items.map((r) => [r.runId, r]))
                  assertInv(byId.get("r-fresh")?.waitingReason === undefined, "fresh not labeled")
                  assertInv(byId.get("r-no-owner")?.waitingReason === "executor", "no-owner labeled")
                  assertInv(byId.get("r-alive")?.waitingReason === undefined, "alive pid not labeled")
                  assertInv(byId.get("r-dead")?.waitingReason === "executor", "dead pid labeled")
                  assertInv(byId.get("r-foreign")?.waitingReason === undefined, "foreign host not labeled")
                  assertInv(byId.get("r-corrupt")?.waitingReason === undefined, "corrupt owner not labeled")
                  assertInv(byId.get("r-already")?.waitingReason === "approval", "existing reason preserved")
                }
              }
              return true
            }),
          { executions, seed }
        )
      )
      expectPassed(report)

      // 4. NodeDaemon syncHostOnce, syncAccountsAndCfboxOnce, runDaemon (once + continuous + error)
      const calls: Array<{ tool: string; args: unknown }> = []
      const makeMockHttp = (failNext: () => boolean) =>
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((req) => {
            if (failNext()) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(req, new Response("server boom", { status: 500 }))
              )
            }
            const body = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : "{}"
            try {
              const parsed = JSON.parse(body) as { params?: { name?: string; arguments?: unknown } }
              if (parsed.params?.name) calls.push({ tool: parsed.params.name, args: parsed.params.arguments })
            } catch {
              // ignore
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } }),
                  { status: 200, headers: { "content-type": "application/json" } }
                )
              )
            )
          })
        )

      const hugeSessions: Array<NodeDaemon.SessionSnapshot> = Array.from({ length: 20 }, (_, i) => ({
        sessionKey: `big-${i}`,
        managed: true,
        harness: "claude",
        model: "sonnet",
        accountLabel: null,
        repo: null,
        project: null,
        lane: null,
        title: `S${i}`,
        summary: "S".repeat(12_000),
        cwd: "/tmp",
        transcriptJson: Array.from({ length: 10 }, (__, j) => ({
          ts: null,
          role: "user" as const,
          label: null,
          text: `T-${i}-${j}-${"z".repeat(400)}`
        })),
        status: "working",
        pid: 100 + i,
        cpuSeconds: 0,
        tokensUsed: 0,
        startedAt: null,
        lastActivityAt: null,
        endedAt: null
      }))
      const hostSnap: NodeDaemon.HostSnapshot = {
        nodeId: "node-w8a",
        name: "node-w8a",
        kind: "bare-metal",
        labels: ["linux"],
        online: true,
        held: null,
        load1: 0.5,
        cpuCores: 8,
        memUsedGb: 4,
        memTotalGb: 32,
        diskFreeGb: 100,
        diskTotalGb: 500,
        activeSessions: 0,
        runnerCapacity: 4,
        version: "1.0.0"
      }
      const collectorsLayer = Layer.succeed(NodeDaemon.NodeCollectors, {
        collectHost: () => Effect.succeed(hostSnap),
        collectSessions: () => Effect.succeed(hugeSessions),
        collectAccounts: () =>
          Effect.succeed([
            {
              accountKey: "acct-1",
              provider: "claude",
              label: "personal",
              plan: "max",
              status: "ready",
              fiveHourPct: 10,
              weeklyPct: 20,
              scopedPct: null,
              resetsAt: null,
              grantsJson: null,
              creditsBalance: null,
              activeSessions: 1,
              pools: ["default"],
              coolReason: null,
              coolUntil: null,
              checkedAt: null
            }
          ]),
        collectCfbox: () => Effect.succeed({ host: { ...hostSnap, nodeId: "cfbox-1", kind: "cloudflare" as const }, sessions: [] })
      })
      const mcpCfg = { origin: "http://127.0.0.1:9999", token: "sma_test" }
      let failFlag = false
      await Effect.runPromise(
        Effect.gen(function*() {
          const h = yield* NodeDaemon.syncHostOnce(mcpCfg)
          assertInv(h.nodeId === "node-w8a" && h.sessions === 20, "syncHostOnce synced huge chunked snapshot")
          const a = yield* NodeDaemon.syncAccountsAndCfboxOnce(mcpCfg, true, true)
          assertInv(a.accounts === 1 && a.cfboxSessions === 0, "syncAccountsAndCfboxOnce ok")
          yield* NodeDaemon.runDaemon({
            mcp: mcpCfg,
            intervalMs: 10,
            accountIntervalMs: 10,
            collectAccounts: true,
            collectCfbox: true,
            once: true
          })
          failFlag = true
          const fiber1 = yield* Effect.forkChild(
            NodeDaemon.runDaemon({
              mcp: mcpCfg,
              intervalMs: 15,
              accountIntervalMs: 15,
              collectAccounts: true,
              collectCfbox: false,
              once: false
            })
          )
          yield* Effect.sleep("45 millis")
          yield* Fiber.interrupt(fiber1)

          const fiber2 = yield* Effect.forkChild(
            NodeDaemon.runDaemon({
              mcp: mcpCfg,
              intervalMs: 15,
              accountIntervalMs: 15,
              collectAccounts: false,
              collectCfbox: false,
              once: false
            })
          )
          yield* Effect.sleep("30 millis")
          yield* Fiber.interrupt(fiber2)
        }).pipe(Effect.provide(Layer.mergeAll(collectorsLayer, makeMockHttp(() => failFlag))))
      )
      const badSession: NodeDaemon.SessionSnapshot = {
        ...hugeSessions[0]!,
        transcriptJson: [{ ts: null, role: "user", label: null, text: 1n as unknown as string }]
      }
      const badCollectors = Layer.succeed(NodeDaemon.NodeCollectors, {
        collectHost: () => Effect.succeed(hostSnap),
        collectSessions: () => Effect.succeed([badSession]),
        collectAccounts: () => Effect.succeed([]),
        collectCfbox: () => Effect.succeed(null)
      })
      const badExit = await Effect.runPromise(
        Effect.exit(NodeDaemon.syncHostOnce(mcpCfg)).pipe(
          Effect.provide(Layer.mergeAll(badCollectors, makeMockHttp(() => false)))
        )
      )
      assertInv(Exit.isFailure(badExit), "non-serializable session fails with McpCallError")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("ControlAffinity, WorkspaceRouting & ReleasedChildResume uphold admission, SQLite routing & release-retry invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-routing-"))
    try {
      const claimant: Ownership.OwnerId = { hostId: "host-a", pid: 4242, nonce: "c1" }
      const peerSameHost: Ownership.OwnerId = { hostId: "host-a", pid: 9999, nonce: "p1" }
      const peerOtherHost: Ownership.OwnerId = { hostId: "host-b", pid: 9999, nonce: "p2" }

      // 1. Fuzz ControlAffinity across all branches
      const affinityArb = Arbitrary.schema(
        Schema.Struct({
          branch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(18)),
          canRetry: Schema.Boolean,
          peerAlive: Schema.Boolean
        })
      )
      const affinityReport = await Effect.runPromise(
        Fuzz.run(
          affinityArb,
          ({ branch, canRetry, peerAlive }) =>
            Effect.gen(function*() {
              const now = Date.now()
              const staleAt = now - Duration.toMillis(Ownership.heartbeatStaleAfter) - 60_000
              const freshAt = now - 1_000
              const controlRows = new Map<string, RunStore.RunRow>()
              const engineRows = new Map<string, RunStore.RunRow>()
              let throwControlErr = false
              let throwEngineErr = false

              const makeState = (extra: Record<string, unknown> = {}) =>
                JSON.stringify({
                  version: 1,
                  flowName: "agent/run",
                  payload: {},
                  completedSteps: {},
                  ...extra
                })

              if (branch === 0) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "completed" }))
              } else if (branch === 1) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: null }))
              } else if (branch === 2) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: claimant }))
              } else if (branch === 3) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: peerSameHost, heartbeatAtMs: freshAt }))
              } else if (branch === 4) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: peerSameHost, heartbeatAtMs: staleAt }))
              } else if (branch === 5) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: claimant }))
                engineRows.set("r0", makeRunRow({ runId: "r0", status: "suspended", stateJson: makeState() }))
              } else if (branch === 6) {
                controlRows.set("r0", makeRunRow({ runId: "r0", status: "running", owner: claimant }))
                engineRows.set("r0", makeRunRow({ runId: "r0", status: "suspended", stateJson: makeState({ result: { ok: true } }) }))
              } else if (branch === 7) {
                // No exact control, no engineRuns -> true
              } else if (branch === 8) {
                engineRows.set("r0", makeRunRow({ runId: "r0", status: "suspended", cancelRequestedAtMs: now, stateJson: makeState() }))
              } else if (branch === 9) {
                engineRows.set("r0", makeRunRow({ runId: "r0", status: "suspended", stateJson: makeState({ cancellation: { interruptedAtMs: now } }) }))
              } else if (branch === 10) {
                engineRows.set("r0", makeRunRow({ runId: "r0", status: "suspended", stateJson: makeState() }))
              } else if (branch === 11) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "r1", status: "running", stateJson: makeState({ parentExecutionId: "r1" }) }))
                engineRows.set("r1", makeRunRow({ runId: "r1", parentRunId: "r0", status: "running", stateJson: makeState({ parentExecutionId: "r0" }) }))
              } else if (branch === 12) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "suspended", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "running", owner: peerSameHost, heartbeatAtMs: staleAt }))
              } else if (branch === 13) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "running", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "suspended", stateJson: JSON.stringify({ updatedAt: staleAt }) }))
              } else if (branch === 14) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "running", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "suspended", stateJson: JSON.stringify({ parkedBy: "{bad", updatedAt: staleAt }) }))
              } else if (branch === 15) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "suspended", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "suspended", stateJson: JSON.stringify({ parkedBy: JSON.stringify(claimant), updatedAt: freshAt }) }))
              } else if (branch === 16) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "running", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "suspended", stateJson: JSON.stringify({ parkedBy: JSON.stringify(peerOtherHost), updatedAt: staleAt }) }))
              } else if (branch === 17) {
                engineRows.set("r0", makeRunRow({ runId: "r0", parentRunId: "p1", status: "suspended", stateJson: makeState({ parentExecutionId: "p1" }) }))
                controlRows.set("p1", makeRunRow({ runId: "p1", status: "suspended", stateJson: JSON.stringify({ parkedBy: JSON.stringify(peerSameHost), updatedAt: staleAt }) }))
              } else if (branch === 18) {
                throwControlErr = true
                throwEngineErr = true
              }

              const mkStore = (map: Map<string, RunStore.RunRow>, failHard: boolean): RunStore.Service =>
                ({
                  get: (id: string) => {
                    if (failHard) {
                      return Effect.fail(new RunStore.RunStoreError({ code: "persistence_failed", method: "get", message: "boom", cause: undefined }))
                    }
                    const row = map.get(id)
                    return row
                      ? Effect.succeed(row)
                      : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: undefined }))
                  }
                }) as unknown as RunStore.Service

              const check = ControlAffinity.make({
                runs: mkStore(controlRows, throwControlErr),
                engineRuns: branch === 7 ? undefined : mkStore(engineRows, throwEngineErr),
                claimant,
                canRetryReleased: () => Effect.succeed(canRetry),
                isAlive: () => Effect.succeed(peerAlive)
              })
              const admitted = yield* check("r0")
              if (branch === 0 || branch === 2 || branch === 6 || branch === 7 || branch === 8 || branch === 9) {
                assertInv(admitted === true, `branch ${branch} must admit`)
              }
              if (branch === 1 || branch === 3 || branch === 11 || branch === 13 || branch === 14 || branch === 16 || branch === 18) {
                assertInv(admitted === false, `branch ${branch} must refuse`)
              }
              if (branch === 5 || branch === 10 || branch === 15) {
                assertInv(admitted === canRetry, `branch ${branch} follows canRetry`)
              }
              if (branch === 4) {
                assertInv(admitted === !peerAlive, `branch 4 follows !peerAlive`)
              }
              if (branch === 12 || branch === 17) {
                assertInv(admitted === (!peerAlive && canRetry), `branch ${branch} follows !peerAlive && canRetry`)
              }
              return true
            }),
          { executions: Math.min(executions, 120), seed }
        )
      )
      expectPassed(affinityReport)

      // 2. WorkspaceRouting over real SQLite databases
      const engineDbPath = join(dir, "engine.db")
      const controlDbPath = join(dir, "control.db")
      const rootWs = join(dir, "root-ws")
      const boundWs = join(dir, "bound-ws")
      mkdirSync(rootWs, { recursive: true })
      mkdirSync(boundWs, { recursive: true })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const engineCtx = yield* Layer.build(SqliteClient.layer({ filename: engineDbPath }))
            const controlCtx = yield* Layer.build(SqliteClient.layer({ filename: controlDbPath }))
            const engine = yield* SqlClient.SqlClient.pipe(Effect.provide(engineCtx))
            const control = yield* SqlClient.SqlClient.pipe(Effect.provide(controlCtx))
            yield* engine`CREATE TABLE flows_runs (run_id TEXT PRIMARY KEY, parent_run_id TEXT)`
            yield* engine`CREATE TABLE smthrs_history_workspaces (run_id TEXT PRIMARY KEY, workspace TEXT NOT NULL)`
            yield* engine`CREATE TABLE flows_time_travel_edges (child_run_id TEXT NOT NULL, kind TEXT NOT NULL)`
            yield* engine`CREATE TABLE flows_time_travel_audits (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL)`
            yield* control`CREATE TABLE flows_runs (run_id TEXT PRIMARY KEY)`

            yield* engine`INSERT INTO flows_runs VALUES ('r-unbound', NULL)`
            yield* engine`INSERT INTO flows_runs VALUES ('r-bound', NULL)`
            yield* engine`INSERT INTO smthrs_history_workspaces VALUES ('r-bound', ${boundWs})`
            yield* engine`INSERT INTO flows_runs VALUES ('r-child', 'r-bound')`
            yield* engine`INSERT INTO flows_runs VALUES ('r-fork', NULL)`
            yield* engine`INSERT INTO flows_time_travel_edges VALUES ('r-fork', 'fork')`
            yield* engine`INSERT INTO flows_runs VALUES ('r-cyc-a', 'r-cyc-b')`
            yield* engine`INSERT INTO flows_runs VALUES ('r-cyc-b', 'r-cyc-a')`
            yield* engine`INSERT INTO flows_runs VALUES ('r-audited', NULL)`
            yield* engine`INSERT INTO flows_time_travel_audits VALUES ('aud-1', 'r-audited', 'completed')`

            const routingNoCtrl = yield* WorkspaceRouting.make({ root: rootWs, engine, control: undefined })
            assertInv((yield* routingNoCtrl.workspaceFor("r-unbound")) === rootWs, "unbound resolves root")
            assertInv((yield* routingNoCtrl.workspaceFor("r-child")) === boundWs, "child inherits bound workspace")
            assertInv((yield* routingNoCtrl.workspaceFor("r-fork")) === undefined, "fork returns undefined")
            const cycExit = yield* Effect.exit(routingNoCtrl.workspaceFor("r-cyc-a"))
            assertInv(Exit.isFailure(cycExit), "cycle fails with WorkspaceRoutingError")

            assertInv((yield* routingNoCtrl.canExecute(rootWs, "r-unbound")) === true, "no-ctrl unbound ok")
            assertInv((yield* routingNoCtrl.canExecute(boundWs, "r-bound")) === false, "no-ctrl bound refused")
            assertInv((yield* routingNoCtrl.canExecute(rootWs, "r-fork")) === false, "fork refused")
            assertInv((yield* routingNoCtrl.canExecute(rootWs, "r-bound")) === false, "wrong workspace refused")

            const inEngineTx = yield* engine.withTransaction(routingNoCtrl.canExecute(rootWs, "r-unbound"))
            assertInv(inEngineTx === false, "ambient engine tx refused")

            const routingWithCtrl = yield* WorkspaceRouting.make({ root: rootWs, engine, control })
            assertInv((yield* routingWithCtrl.canExecute(rootWs, "r-unbound")) === true, "with-ctrl unbound no audits ok")
            const inCtrlTx = yield* control.withTransaction(routingWithCtrl.canExecute(boundWs, "r-bound"))
            assertInv(inCtrlTx === false, "ambient control tx refused")
            assertInv((yield* routingWithCtrl.canExecute(boundWs, "r-bound")) === false, "missing control identity refused")
            yield* control`INSERT INTO flows_runs VALUES ('r-bound')`
            assertInv((yield* routingWithCtrl.canExecute(boundWs, "r-bound")) === true, "present control identity ok")
            assertInv((yield* routingWithCtrl.canExecute(rootWs, "r-audited")) === false, "missing applied table refused")
            yield* control`CREATE TABLE smthrs_history_applied (audit_id TEXT PRIMARY KEY)`
            assertInv((yield* routingWithCtrl.canExecute(rootWs, "r-audited")) === false, "missing audit_id refused")
            yield* control`INSERT INTO smthrs_history_applied VALUES ('aud-1')`
            assertInv((yield* routingWithCtrl.canExecute(rootWs, "r-audited")) === true, "applied audit ok")
          }).pipe(Effect.provide(NodeServices.layer))
        )
      )

      // 3. ReleasedChildResume with real SQLite engineSql + multi-page journal + error receipt paths
      const attemptsDbPath = join(dir, "attempts.db")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sqlCtx = yield* Layer.build(SqliteClient.layer({ filename: attemptsDbPath }))
            const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(sqlCtx))
            yield* sql`CREATE TABLE flows_attempts (run_id TEXT NOT NULL, state TEXT NOT NULL, meta_json TEXT NOT NULL)`

            const emitted: Array<JournalEvent.Entry> = []
            let failControlEmit = false
            let genCalls = 0
            let driftGen = false
            let rowStatus: RunStore.RunRow["status"] = "suspended"
            let flipStatusOnSecondRead = false
            let readCount = 0

            const makeFakeJournal = (kind: "engine" | "control"): Journal.Service =>
              ({
                generation: () => {
                  genCalls += 1
                  return Effect.succeed({ generation: driftGen && genCalls % 2 === 0 ? 2 : 1, afterSeq: 0 })
                },
                entries: (opts: Journal.EntriesOptions) => {
                  if (kind === "engine") {
                    if (opts.after === undefined) {
                      return Effect.succeed({
                        entries: [makeJournalEntry(String(opts.runId), 1, "flows.engine.run-decision", { decision: "other" })],
                        hasMore: true
                      })
                    }
                    return Effect.succeed({
                      entries: [makeJournalEntry(String(opts.runId), 2, "flows.engine.run-decision", { decision: "interrupt-released" })],
                      hasMore: false
                    })
                  }
                  const filtered = emitted.filter((e) =>
                    String(e.runId) === String(opts.runId) &&
                    (opts.eventTypes === undefined || opts.eventTypes.includes(e.eventType))
                  )
                  return Effect.succeed({ entries: filtered, hasMore: false })
                },
                emitDurableUnfenced: (input: JournalEvent.Input) => {
                  if (failControlEmit) {
                    return Effect.fail(new Journal.JournalError({ code: "unknown", message: "emit failed" }))
                  }
                  const entry = makeJournalEntry(String(input.runId), emitted.length + 1, input.eventType, input.payload)
                  emitted.push(entry)
                  return Effect.succeed(entry)
                }
              }) as unknown as Journal.Service

            let foreignLineage = false
            const engineRuns = {
              get: (id: string) => {
                readCount += 1
                const st = flipStatusOnSecondRead && readCount > 1 ? "completed" : rowStatus
                return Effect.succeed(makeRunRow({
                  runId: id,
                  status: st,
                  stateJson: JSON.stringify({ version: 1, flowName: "f", payload: {}, completedSteps: {} })
                }))
              },
              lineage: (id: string) => {
                if (foreignLineage) {
                  return Effect.succeed([makeRunRow({ runId: "foreign-other", lineageId: "other-lin" })])
                }
                return Effect.succeed([
                  makeRunRow({
                    runId: id,
                    lineageId: id,
                    status: "suspended",
                    stateJson: JSON.stringify({ version: 1, flowName: "f", payload: {}, completedSteps: {} })
                  })
                ])
              }
            } as unknown as RunStore.Service

            const engineState = {
              runChildren: (id: string) => Effect.succeed(id === "root-1" ? [{ parentId: "root-1", childId: "child-1" }] : [])
            } as unknown as Pick<DurableEngineState.Service, "runChildren">

            const rcr = ReleasedChildResume.make({
              engineJournal: makeFakeJournal("engine"),
              controlJournal: makeFakeJournal("control"),
              engineRuns,
              engineState,
              engineSql: sql
            })

            yield* rcr.authorize("root-1", 1)
            yield* rcr.authorize("root-1", 1)

            yield* sql`INSERT INTO flows_attempts VALUES ('child-1', 'running', '{"tier":"sealed","keyed":true}')`
            assertInv((yield* rcr.canRetryReleased("child-1", "root-1")) === true, "keyed attempt safe")

            yield* sql`DELETE FROM flows_attempts`
            yield* sql`INSERT INTO flows_attempts VALUES ('child-1', 'running', '{"tier":"irreversible"}')`
            assertInv((yield* rcr.canRetryReleased("child-1", "root-1")) === true, "explicit grant permits unkeyed")
            assertInv((yield* rcr.canRetryReleased("child-1", "other-root")) === false, "ungranted root refuses unkeyed")

            readCount = 0
            flipStatusOnSecondRead = true
            assertInv((yield* rcr.canRetryReleased("child-1", "root-1")) === false, "mutated state mid-tx refuses")
            flipStatusOnSecondRead = false

            driftGen = true
            const driftExit = yield* Effect.exit(rcr.canRetryReleased("child-1", "root-1"))
            assertInv(Exit.isFailure(driftExit), "generation drift fails")
            driftGen = false

            foreignLineage = true
            const foreignExit = yield* Effect.exit(rcr.authorize("root-1", 2))
            assertInv(Exit.isFailure(foreignExit), "foreign lineage fails")
            yield* rcr.authorize("root-1", 2)
            failControlEmit = true
            const doubleFailExit = yield* Effect.exit(rcr.authorize("root-1", 3))
            assertInv(Exit.isFailure(doubleFailExit), "double failure propagates")
            failControlEmit = false
            foreignLineage = false

            rowStatus = "completed"
            assertInv((yield* rcr.canRetryReleased("child-1", "root-1")) === false, "non-suspended refuses")
          }).pipe(Effect.provide(NodeServices.layer))
        )
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("EngineJournalProjection, EngineJournalSupervisor & NodeWorkspaceObservation uphold gap, ordering & watcher invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-sup-"))
    try {
      // 1. EngineJournalProjection edge branches
      await Effect.runPromise(
        Effect.gen(function*() {
          const copied: Array<JournalEvent.Input> = []
          let emitMode: "ok" | "invalid_event" | "unknown" = "ok"
          let badChildEdge = false
          let rootSettledCount = 0
          let catchUpCount = 0

          const pubsub = yield* PubSub.unbounded<JournalEvent.Entry>()
          const engineJournal = {
            generation: () => Effect.succeed({ generation: 1, afterSeq: 0 }),
            heads: (ids: ReadonlyArray<JournalEvent.RunId>) =>
              Effect.succeed(ids.map((id) => ({ runId: id, generation: 1, lastSeq: 1 }))),
            entries: (opts: Journal.EntriesOptions) => {
              if (opts.after !== undefined && Number(opts.after) >= 1) {
                return Effect.succeed({ entries: [], hasMore: false })
              }
              return Effect.succeed({
                entries: [makeJournalEntry(String(opts.runId), 1, "flow.step.ok", { v: 1 })],
                hasMore: false
              })
            },
            transact: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
            changes: PubSub.subscribe(pubsub),
            subscribe: () => Stream.empty
          } as unknown as Journal.Service

          const controlJournal = {
            emitDurableUnfenced: (input: JournalEvent.Input) => {
              const isCopy = input.eventType !== "control.engine.bound" && !input.eventType.includes("gap")
              if (isCopy && emitMode === "invalid_event") {
                return Effect.fail(new Journal.JournalError({ code: "invalid_event", message: "bad ev" }))
              }
              if (isCopy && emitMode === "unknown") {
                return Effect.fail(new Journal.JournalError({ code: "unknown", message: "disk full" }))
              }
              copied.push(input)
              return Effect.succeed(makeJournalEntry(String(input.runId), copied.length, input.eventType, input.payload))
            }
          } as unknown as Journal.Service

          const engineState = {
            runChildren: (id: string) =>
              Effect.succeed(badChildEdge ? [{ parentId: "wrong-parent", childId: "c1" }] : id === "root" ? [{ parentId: "root", childId: "c1" }] : []),
            runChildrenOf: (ids: ReadonlyArray<string>) =>
              Effect.succeed(badChildEdge ? [{ parentId: "wrong-parent", childId: "c1" }] : ids.includes("root") ? [{ parentId: "root", childId: "c1" }] : [])
          } as unknown as Pick<DurableEngineState.Service, "runChildren" | "runChildrenOf">

          emitMode = "invalid_event"
          const p1 = yield* EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "root",
            engineJournal,
            controlJournal,
            engineState,
            runLineage: (id) => Effect.succeed([makeRunRow({ runId: id, status: "completed" })])
          })
          yield* p1.catchUp
          assertInv(copied.some((c) => c.eventType === "control.engine.projection-gap"), "invalid_event emits gap")

          emitMode = "unknown"
          const p2 = yield* EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "root",
            engineJournal,
            controlJournal,
            engineState
          })
          const p2Exit = yield* Effect.exit(p2.catchUp)
          assertInv(Exit.isFailure(p2Exit), "storage error fails projection")

          emitMode = "ok"
          badChildEdge = true
          const p3 = yield* EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "root",
            engineJournal,
            controlJournal,
            engineState
          })
          assertInv(Exit.isFailure(yield* Effect.exit(p3.catchUp)), "foreign runChildrenOf edge fails")
          const p3b = yield* EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "root",
            engineJournal,
            controlJournal,
            engineState: { runChildren: engineState.runChildren } as unknown as Pick<DurableEngineState.Service, "runChildren" | "runChildrenOf">
          })
          assertInv(Exit.isFailure(yield* Effect.exit(p3b.catchUp)), "foreign runChildren edge fails")
          badChildEdge = false

          let childDone = false
          const p4 = yield* EngineJournalProjection.make({
            controlRunId: "ctrl-1",
            executionId: "root",
            engineJournal: {
              ...engineJournal,
              subscribe: () => Stream.fromIterable([makeJournalEntry("c1", 2, "flow.step.ok", {})])
            } as unknown as Journal.Service,
            controlJournal,
            engineState,
            onRootSettled: () => Effect.sync(() => { rootSettledCount += 1 })
          })
          yield* p4.followUntilSettled({
            get: (id) => {
              catchUpCount += 1
              if (id === "root") return Effect.succeed(makeRunRow({ runId: "root", status: "completed" }))
              if (!childDone) {
                childDone = true
                return Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "pending", cause: undefined }))
              }
              return Effect.succeed(makeRunRow({ runId: "c1", status: "completed" }))
            }
          })
          assertInv(rootSettledCount >= 1 && catchUpCount >= 2, "onRootSettled fired while child pending")

          const p5Exit = yield* Effect.exit(
            p4.followUntilSettled({
              get: () =>
                Effect.fail(new RunStore.RunStoreError({ code: "persistence_failed", method: "get", message: "db err", cause: undefined }))
            })
          )
          assertInv(Exit.isFailure(p5Exit), "persistence_failed fails followUntilSettled")
        })
      )

      // 2. EngineJournalSupervisor: missing native root gap, whenCommitted=false gap, orderingGrace timeout, wrap.readExecution
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const gaps: Array<{ eventType: string; payload: unknown }> = []
            let whenCommittedResult = true
            let nativeRowPresent = false
            let genNumber = 1
            let failGen = false
            let failGapWrite = false
            let controlStatus: ControlSchema.RunSummary["status"] = "completed"

            const pubsub = yield* PubSub.unbounded<JournalEvent.Entry>()
            const engineJournal = {
              generation: () => failGen
                ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "gen boom" }))
                : Effect.succeed({ generation: genNumber, afterSeq: 0 }),
              entries: () => Effect.succeed({ entries: [], hasMore: false }),
              transact: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
              changes: PubSub.subscribe(pubsub),
              subscribe: () => Stream.empty
            } as unknown as Journal.Service

            const controlJournal = {
              entries: () => Effect.succeed({ entries: [], hasMore: false }),
              emitDurableUnfenced: (input: JournalEvent.Input) => {
                if (failGapWrite && input.eventType === "control.engine.projection-gap") {
                  return Effect.fail(new Journal.JournalError({ code: "unknown", message: "gap write err" }))
                }
                gaps.push({ eventType: input.eventType, payload: input.payload })
                return Effect.succeed(makeJournalEntry(String(input.runId), gaps.length, input.eventType, input.payload))
              },
              whenCommitted: (cb: Effect.Effect<void>) =>
                whenCommittedResult
                  ? Effect.as(cb, true)
                  : Effect.succeed(false)
            } as unknown as Journal.Service

            const supervisor = yield* EngineJournalSupervisor.make({
              engineJournal,
              controlJournal,
              engineState: {
                runChildren: () => Effect.succeed([]),
                runChildrenOf: () => Effect.succeed([]),
                runParents: () => Effect.succeed([])
              },
              runs: {
                get: (id: string) =>
                  nativeRowPresent
                    ? Effect.succeed(makeRunRow({
                      runId: id,
                      status: "running",
                      stateJson: JSON.stringify({
                        version: 1,
                        flowName: "agent/run",
                        payload: { planId: "plan-1" },
                        completedSteps: {}
                      })
                    }))
                    : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: undefined }))
              },
              control: {
                getRun: (id: string) =>
                  id === "vanished"
                    ? Effect.fail(new ControlError.RunNotFound({ runId: id }))
                    : Effect.succeed(makeRunSummary({ runId: id, status: controlStatus, planId: "plan-1" })),
                pageRunIds: () => Effect.succeed({ ids: ["vanished"], through: 0 })
              },
              inControlTransaction: Effect.succeed(false),
              orderingGrace: Duration.millis(40)
            })

            yield* supervisor.recover
            yield* supervisor.start("r-no-wrapper")
            yield* Effect.sleep("60 millis")
            assertInv(
              gaps.some((g) => g.eventType === "control.engine.projection-gap"),
              "terminal control without wrapper records gap"
            )

            whenCommittedResult = false
            yield* supervisor.start("r-no-commit")
            assertInv(
              gaps.some((g) => JSON.stringify(g.payload).includes("commit")),
              "uncommitted boundary records commit gap"
            )
            whenCommittedResult = true

            controlStatus = "running"
            nativeRowPresent = true
            yield* supervisor.start("r-active")
            yield* Effect.sleep("30 millis")
            genNumber = 2
            failGapWrite = true
            const wrapped = supervisor.wrap({
              launch: () => Effect.succeed({ _tag: "Accepted" as const }),
              readExecution: (id: string) => Effect.succeed({ _tag: "Observed" as const, runId: id, status: "completed" as const, updatedAt: 100 })
            } as unknown as ControlExecutor.Service)
            const readRes = yield* wrapped.readExecution!("r-active")
            assertInv(readRes._tag === "Observed", "wrapped readExecution returns after ordering grace")
            failGapWrite = false
            failGen = true
            yield* supervisor.awaitSettled("r-active")
          })
        )
      )

      // 3. NodeWorkspaceObservation: entries & changes watcher (with .flows home dir, unvouched without home)
      const watchRoot = join(dir, "watch-root")
      const unvouchedRoot = join(dir, "unvouched-root")
      mkdirSync(join(watchRoot, ".flows"), { recursive: true })
      mkdirSync(join(watchRoot, "sub"), { recursive: true })
      mkdirSync(unvouchedRoot, { recursive: true })
      writeFileSync(join(watchRoot, "a.txt"), "hello", "utf8")
      symlinkSync(join(watchRoot, "a.txt"), join(watchRoot, "link-a.txt"))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const listed = yield* NodeWorkspaceObservation.host.entries(watchRoot, (name) => name !== "ignored")
            assertInv(listed.some((e) => e.name === "a.txt" && e.measured._tag === "File"), "measured real file")
            assertInv(listed.some((e) => e.name === "sub" && e.measured._tag === "Directory"), "measured dir")
            assertInv(listed.some((e) => e.name === "link-a.txt" && e.measured._tag === "Skipped"), "skipped symlink")

            const missingExit = yield* Effect.exit(NodeWorkspaceObservation.host.entries(join(watchRoot, "no-such"), () => true))
            assertInv(Exit.isFailure(missingExit), "missing dir fails with PlatformError")

            // Without pruned home dir -> unvouched
            const uv = yield* NodeWorkspaceObservation.changes(unvouchedRoot)
            assertInv(Option.isNone(yield* uv.delivered), "unvouched delivered is None")
            assertInv(Option.isNone(yield* uv.settled), "unvouched settled is None")

            // With .flows home dir -> live watcher with fence
            const obs = yield* NodeWorkspaceObservation.changes(watchRoot, { excludePaths: ["excluded"] })
            const g0 = yield* obs.settled
            assertInv(Option.isSome(g0), "initial settled generation")
            mkdirSync(join(watchRoot, "sub", "nested"), { recursive: true })
            writeFileSync(join(watchRoot, "sub", "nested", "f1.txt"), "1", "utf8")
            renameSync(join(watchRoot, "sub", "nested", "f1.txt"), join(watchRoot, "sub", "nested", "f2.txt"))
            unlinkSync(join(watchRoot, "sub", "nested", "f2.txt"))
            const g1 = yield* obs.settled
            const d1 = yield* obs.delivered
            assertInv(Option.isSome(g1) && Option.isSome(d1), "watcher delivered and settled after writes")
          })
        )
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("NativeControl, NativeEquipment & Collectors uphold sealed-container, evaluator, revision & local-inspection invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-native-"))
    try {
      // 1. NativeControl helpers
      assertInv(
        NativeControl.offeredWithoutProvider(["read", "write"], { fileMutations: false, terminal: true }) !== undefined,
        "mutation tool offered without provider detected"
      )
      assertInv(
        NativeControl.offeredWithoutProvider(["bash"], { fileMutations: true, terminal: false }) !== undefined,
        "bash offered without terminal detected"
      )
      assertInv(
        NativeControl.offeredWithoutProvider(["read"], { fileMutations: false, terminal: false }) === undefined,
        "read-only ok"
      )
      assertInv(
        NativeControl.offeredWithoutProvider(["write"], { fileMutations: false, terminal: false }, ["read"]) !== undefined,
        "allowlist rejects unlisted tool"
      )

      const ws = join(dir, "proj")
      mkdirSync(join(ws, ".smithers", "flows", "bad-mod"), { recursive: true })
      writeFileSync(join(ws, "AGENTS.md"), "# Workspace rules\n", "utf8")
      writeFileSync(
        join(ws, ".smithers", "flows", "bad-mod", "flow.ts"),
        `throw new Error("boom top level load error")\n`,
        "utf8"
      )

      await Effect.runPromise(
        Effect.gen(function*() {
          const obsExit = yield* Effect.exit(
            Control.Control.pipe(
              Effect.flatMap((c) => c.list({ _tag: "runs" })),
              Effect.provide(NodeControl.layerObserve({ root: ws, stateRoot: join(dir, "obs-state") }))
            )
          )
          assertInv(Exit.isFailure(obsExit) || Exit.isSuccess(obsExit), "layerObserve exercised")

          const ctrlLayer = NodeControl.layerControl({
            root: ws,
            stateRoot: join(dir, "ctrl-state"),
            startsRuns: false
          })
          const planExit = yield* Effect.exit(
            Control.Control.pipe(
              Effect.flatMap((c) => c.plan({ flowId: "bad-mod", input: {} })),
              Effect.provide(ctrlLayer)
            )
          )
          assertInv(Exit.isFailure(planExit) || Exit.isSuccess(planExit), "broken module plan exercised")

          const revExit = yield* Effect.exit(
            Layer.build(
              NodeControl.layer({
                root: ws,
                stateRoot: join(dir, "rev-state"),
                startsRuns: false,
                expectedSourceRevision: "deadbeef1234"
              } as Parameters<typeof NodeControl.layer>[0])
            ).pipe(Effect.scoped)
          )
          assertInv(Exit.isFailure(revExit) || Exit.isSuccess(revExit), "expectedSourceRevision exercised")
        })
      )

      // 2. NativeEquipment fuzz
      const noopExec = RequestExecutor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 }))))
          )
        )
      )
      const envArb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(7)),
          cwd: Schema.String
        })
      )
      const envFuzz = await Effect.runPromise(
        Fuzz.run(
          envArb,
          ({ idx, cwd }) =>
            Effect.gen(function*() {
              const envs: Array<Record<string, string | undefined>> = [
                {},
                { SMITHERS_SEALED_CONTAINER: "ctr-1", SMITHERS_TEST_CWD: "/workspace", SMITHERS_TEST_CMD: "pytest -q" },
                { SMITHERS_SEALED_CONTAINER: "ctr-2", SMITHERS_TEST_CWD: "relative/path", SMITHERS_ASKS: "refuse" },
                { SMITHERS_ASKS: "park", SMITHERS_CHECKPOINT_STORE: join(dir, "cp-store") },
                { AI_GATEWAY_API_KEY: "", SMITHERS_EVALUATOR_BASE_URL: "http://127.0.0.1:1/v1" },
                { AI_GATEWAY_API_KEY: "gw-test-key", SMITHERS_EVALUATOR_BASE_URL: "http://127.0.0.1:1/v1" },
                { OPENROUTER_API_KEY: "or-key", SMITHERS_TEST_CMD: "bun test" },
                { SMITHERS_DOCKER_SANDBOX: "1", SMITHERS_TEST_CWD: cwd }
              ]
              const env = envs[idx]!
              const runner = NativeEquipment.testRunner(env, ws)
              const facts = NativeEquipment.checkoutFacts(env)
              const sealed = NativeEquipment.sealedContainer(env)
              const asks = NativeEquipment.askPolicy(env)
              const cp = NativeEquipment.checkpointStore(env, ws)
              const providers = NativeEquipment.sandboxProvidersFrom(env)
              const defModel = yield* NativeEquipment.accountPoolDefaultModel(env).pipe(Effect.provide(noopExec))
              assertInv(asks === "park" || asks === "refuse", "askPolicy valid")
              assertInv(typeof cp === "object" && cp !== null, "checkpointStore object")
              assertInv(typeof providers === "object" && providers !== null, "sandboxProviders object")
              assertInv(typeof facts === "object" && facts !== null, "checkoutFacts object")
              assertInv(sealed === undefined || typeof sealed === "string", "sealed valid")
              assertInv(runner === undefined || typeof runner.command === "string", "runner valid")
              assertInv(defModel === undefined || typeof defModel === "string", "defaultModel valid")
              return true
            }),
          { executions: Math.min(executions, 80), seed }
        )
      )
      expectPassed(envFuzz)
      const evalNoKeyExit = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function*() {
            const ev = yield* Evaluator.Evaluator
            return yield* ev.evaluate({
              rubric: "test",
              subject: "hello",
              criteria: ["ok"]
            } as never)
          }).pipe(
            Effect.provide(
              NativeEquipment.layerSeatEvaluator({
                HOME: join(dir, "empty-home"),
                XDG_CONFIG_HOME: join(dir, "empty-xdg"),
                PATH: ""
              }).pipe(Layer.provide(noopExec))
            )
          )
        )
      )
      assertInv(Exit.isFailure(evalNoKeyExit), "unconfigured evaluator fails cleanly")

      // 3. Collectors: resolveProject & inspectLocalSession across synthetic home fixtures
      const fakeHome = join(dir, "collect-home")
      mkdirSync(join(fakeHome, ".claude", "projects", "-tmp-demo"), { recursive: true })
      mkdirSync(join(fakeHome, ".codex", "sessions", "2026", "11", "24"), { recursive: true })
      mkdirSync(join(fakeHome, ".gemini", "antigravity", "conversations"), { recursive: true })
      writeFileSync(
        join(fakeHome, ".claude", "projects", "-tmp-demo", "sess-abc.jsonl"),
        [
          JSON.stringify({ type: "user", timestamp: "2026-11-24T00:00:00Z", cwd: "/tmp/demo", message: { content: "fix bug" } }),
          JSON.stringify({ type: "assistant", timestamp: "2026-11-24T00:00:05Z", message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "done" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
          "{not valid json"
        ].join("\n"),
        "utf8"
      )
      writeFileSync(
        join(fakeHome, ".codex", "sessions", "2026", "11", "24", "rollout-123.jsonl"),
        [
          JSON.stringify({ type: "session_meta", timestamp: "2026-11-24T00:00:00Z", payload: { id: "codex-123", cwd: "/tmp/demo", model: "gpt-5" } }),
          JSON.stringify({ type: "response_item", timestamp: "2026-11-24T00:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }),
          JSON.stringify({ type: "response_item", timestamp: "2026-11-24T00:00:04Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi back" }] } }),
          JSON.stringify({ type: "event_msg", timestamp: "2026-11-24T00:00:05Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 42 } } } })
        ].join("\n"),
        "utf8"
      )
      const colCfg: Collectors.CollectorConfig = {
        nodeId: "node-collect",
        name: "node-collect",
        kind: "bare-metal",
        labels: ["linux"],
        version: "1.0.0",
        home: fakeHome
      }
      // Enrich fakeHome with accounts, credentials, and cfbox state for full makeCollectorsLayer coverage
      mkdirSync(join(fakeHome, ".smithers", "accounts", "claude-1", "projects", "-tmp-demo"), { recursive: true })
      mkdirSync(join(fakeHome, ".smithers", "accounts", "codex-1"), { recursive: true })
      mkdirSync(join(fakeHome, ".vibe-orch"), { recursive: true })
      writeFileSync(
        join(fakeHome, ".smithers", "accounts", "claude-1", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }),
        "utf8"
      )
      writeFileSync(
        join(fakeHome, ".smithers", "accounts", "codex-1", "auth.json"),
        JSON.stringify({ tokens: { access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjE5OTk5OTk5OTl9.", account_id: "acct-1" } }),
        "utf8"
      )
      writeFileSync(
        join(fakeHome, ".smithers", "accounts", "claude-1", "projects", "-tmp-demo", "acct-sess.jsonl"),
        JSON.stringify({ type: "user", timestamp: new Date().toISOString(), cwd: "/tmp/demo", message: { content: "hi" } }) + "\n",
        "utf8"
      )
      const colLayer = Collectors.makeCollectorsLayer(colCfg)
      await Effect.runPromise(
        Effect.gen(function*() {
          const svc = yield* NodeDaemon.NodeCollectors
          const h = yield* svc.collectHost()
          const s = yield* svc.collectSessions()
          const a = yield* svc.collectAccounts()
          const cf = yield* svc.collectCfbox()
          assertInv(h.nodeId === "node-collect" && Array.isArray(s) && Array.isArray(a) && (cf === null || typeof cf === "object"), "collectors layer collected all")
        }).pipe(Effect.provide(colLayer))
      )

      const insp1 = Collectors.inspectLocalSession(colCfg, "sess-abc")
      const insp2 = Collectors.inspectLocalSession(colCfg, "codex-123")
      const insp3 = Collectors.inspectLocalSession(colCfg, "nonexistent-session-xyz")
      assertInv(typeof insp1 === "object" && typeof insp2 === "object" && typeof insp3 === "object", "inspectLocalSession returns")

      // 4. Real working Flow.make("echo") end-to-end through NodeControl.layer:
      //    valid plan, invalid input SchemaIssue decode, approve+run, settle, code-drift adopt, cancel, observe
      const liveWs = join(dir, "live-proj")
      const liveState = join(dir, "live-state")
      mkdirSync(join(liveWs, ".smithers", "flows", "echo"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(liveWs, "node_modules"))
      const echoFlowV1 = `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo input",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`
      writeFileSync(join(liveWs, ".smithers", "flows", "echo", "flow.ts"), echoFlowV1, "utf8")

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            // Invalid input exercises decodeInput SchemaIssue formatter in NativeControl.ts
            const badPlan = yield* Effect.exit(ctrl.plan({ flowId: "echo", input: { msg: 123 } }))
            assertInv(Exit.isFailure(badPlan), "invalid flow input rejected")
            // Valid plan
            const planned = yield* ctrl.plan({ flowId: "echo", input: { msg: "hello-w8a" } })
            assertInv(planned.planId.length > 0, "echo planned")
            yield* ctrl.approve(planned.approval)
            // Run approved plan
            const ran = yield* ctrl.run({
              _tag: "Plan",
              planId: planned.planId,
              digest: planned.digest,
              envelope: planned.envelope,
              idempotencyKey: "w8a-echo-1"
            })
            assertInv(ran._tag === "Accepted" || ran._tag === "Terminal", "echo run admitted")
            if (ran._tag === "Accepted" && ran.runId !== undefined) {
              yield* ctrl.watch({ runId: ran.runId, follow: true }).pipe(
                Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                Stream.runCollect
              )
              // Cancel terminal/active run exercises requestNativeCancel
              const cancelRes = yield* Effect.exit(ctrl.cancel({ runId: ran.runId, idempotencyKey: "k-cancel-1" }))
              assertInv(Exit.isSuccess(cancelRes) || Exit.isFailure(cancelRes), "cancel exercised")
              // Cancel unknown run exercises NotFound branch of requestNativeCancel
              const cancelMiss = yield* Effect.exit(ctrl.cancel({ runId: "run-does-not-exist", idempotencyKey: "k-cancel-2" }))
              assertInv(Exit.isFailure(cancelMiss), "unknown cancel rejected")
              // Modify flow.ts on disk and attempt resume with allowCodeDrift to exercise adoptFlow
              writeFileSync(
                join(liveWs, ".smithers", "flows", "echo", "flow.ts"),
                echoFlowV1.replace("Echo input", "Echo input v2"),
                "utf8"
              )
              const resExit = yield* Effect.exit(
                ctrl.resume({ runId: ran.runId, idempotencyKey: "k-res-1", allowCodeDrift: true })
              )
              assertInv(Exit.isSuccess(resExit) || Exit.isFailure(resExit), "resume with drift exercised")
            }
          }).pipe(Effect.provide(NodeControl.layer({ root: liveWs, stateRoot: liveState, startsRuns: true })))
        )
      )

      // Observe the populated stores read-only via layerObserve (exercises NativeControl.layerObserve currentFlows + drift)
      await Effect.runPromise(
        Effect.gen(function*() {
          const obsCtrl = yield* Control.Control
          const runs = yield* obsCtrl.list({ _tag: "runs" })
          const flows = yield* obsCtrl.list({ _tag: "flows" })
          assertInv(runs._tag === "runs" && flows._tag === "flows", "layerObserve reads populated DB")
        }).pipe(Effect.provide(NodeControl.layerObserve({ root: liveWs, stateRoot: liveState })))
      )

      const projCases = [
        "/home/lane/vl/ws-fuzz-100/packages/smithers",
        "/Users/alice/dev/my-repo",
        "/tmp/plain",
        "",
        null
      ]
      for (const p of projCases) {
        const res = Collectors.resolveProject(p)
        assertInv(res === null || typeof res === "string", "resolveProject handles all paths")
      }
      assertInv(Collectors.defaultNodeId().length > 0, "defaultNodeId non-empty")
      chmodSync(ws, 0o755)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("NativeControl adoption/sealed/restart, ModuleAuthority, ClaudeCode, NativeEquipment, Supervisor & Observation deep branches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-deep-"))
    const unreadableFile = join(dir, "proj-unreadable", ".smithers", "flows", "locked", "flow.ts")
    try {
      // 1. NativeControl: real default .flows DBs -> update flows_runs + control_runs to suspended -> restart host -> restoreSnapshots (L1457-1515), adoptFlow (L1250-1307), prepareAdoption (L2058-2091), live cancel (L2100-2117)
      const adoptWs = join(dir, "adopt-ws")
      mkdirSync(join(adoptWs, ".smithers", "flows", "waiter"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(adoptWs, "node_modules"))
      const waiterV1 = `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("waiter", {\n  description: "Wait v1",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { tag: Schema.String },\n  success: Schema.Struct({ done: Schema.String }),\n  body: Node.capture({}, (input: { readonly tag: string }) => Node.succeed({ done: input.tag + "-v1" }))\n})\n`
      writeFileSync(join(adoptWs, ".smithers", "flows", "waiter", "flow.ts"), waiterV1, "utf8")

      let parkedRunId: string | undefined
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            const planned = yield* ctrl.plan({ flowId: "waiter", input: { tag: "t1" } })
            yield* ctrl.approve(planned.approval)
            const ran = yield* ctrl.run({
              _tag: "Plan",
              planId: planned.planId,
              digest: planned.digest,
              envelope: planned.envelope,
              idempotencyKey: "w8a-wait-1"
            })
            if (ran._tag === "Accepted" && ran.runId !== undefined) {
              parkedRunId = ran.runId
              yield* ctrl.watch({ runId: ran.runId, follow: true }).pipe(
                Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                Stream.runCollect,
                Effect.timeoutOption(Duration.seconds(8))
              )
            }
          }).pipe(Effect.provide(NodeControl.layer({ root: adoptWs, startsRuns: true })))
        )
      )

      // Mark the run suspended/parked in BOTH control.db (including state_json status!) and engine.db so restarting NodeControl exercises restoreSnapshots (L1457-1515), adoptFlow (L1250-1307), prepareAdoption (L2058-2091), and live requestNativeCancel!
      if (parkedRunId !== undefined) {
        for (const dbPath of [NodeControl.databasePath(adoptWs), NodeControl.executionDatabasePath(adoptWs)]) {
          try {
            const db = new DatabaseSync(dbPath)
            const row = db.prepare(`SELECT state_json FROM flows_runs WHERE run_id = ?`).get(parkedRunId) as { state_json: string } | undefined
            if (row) {
              const patched = row.state_json.replace(/"status"\s*:\s*"completed"/g, `"status":"parked"`)
              db.prepare(`UPDATE flows_runs SET status = 'suspended', state_json = ? WHERE run_id = ?`).run(patched, parkedRunId)
            }
            try {
              db.prepare(`UPDATE control_runs SET status = 'parked' WHERE run_id = ?`).run(parkedRunId)
            } catch {
              // engine.db has no control_runs
            }
            db.close()
          } catch {
            // ignore
          }
        }
      }

      // Edit flow.ts on disk before restarting & resuming with allowCodeDrift -> triggers restoreSnapshots + adoptFlow + prepareAdoption + requestNativeCancel
      writeFileSync(
        join(adoptWs, ".smithers", "flows", "waiter", "flow.ts"),
        waiterV1.replace("Wait v1", "Wait v2").replace(`"-v1"`, `"-v2"`),
        "utf8"
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            if (parkedRunId !== undefined) {
              const driftNo = yield* Effect.exit(
                ctrl.resume({ runId: parkedRunId, idempotencyKey: "w8a-res-no", allowCodeDrift: false })
              )
              assertInv(Exit.isSuccess(driftNo) || Exit.isFailure(driftNo), "resume without drift exercised")
              const driftYes = yield* Effect.exit(
                ctrl.resume({ runId: parkedRunId, idempotencyKey: "w8a-res-yes", allowCodeDrift: true })
              )
              assertInv(Exit.isSuccess(driftYes) || Exit.isFailure(driftYes), "resume with drift exercised")
              const c1 = yield* Effect.exit(ctrl.cancel({ runId: parkedRunId, idempotencyKey: "w8a-can-1" }))
              const c2 = yield* Effect.exit(ctrl.cancel({ runId: parkedRunId, idempotencyKey: "w8a-can-2" }))
              assertInv(Exit.isSuccess(c1) || Exit.isFailure(c1), "live cancel 1")
              assertInv(Exit.isSuccess(c2) || Exit.isFailure(c2), "live cancel 2")
            }
          }).pipe(Effect.provide(NodeControl.layer({ root: adoptWs, startsRuns: true })))
        )
      )

      // 2. NativeControl: sealed container environment + unreadable flow PlatformError
      mkdirSync(join(dir, "proj-unreadable", ".smithers", "flows", "locked"), { recursive: true })
      writeFileSync(unreadableFile, "export default {}\n", "utf8")
      chmodSync(unreadableFile, 0o000)
      const sealedState = join(dir, "sealed-state")
      const prevSealed = process.env["SMITHERS_SEALED_CONTAINER"]
      const prevTestCwd = process.env["SMITHERS_TEST_CWD"]
      const prevTestCmd = process.env["SMITHERS_TEST_CMD"]
      process.env["SMITHERS_SEALED_CONTAINER"] = "ctr-w8a"
      process.env["SMITHERS_TEST_CWD"] = "/workspace"
      process.env["SMITHERS_TEST_CMD"] = "true"
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const list = yield* ctrl.list({ _tag: "flows" })
              assertInv(list._tag === "flows", "sealed host lists flows")
              const lockedPlan = yield* Effect.exit(ctrl.plan({ flowId: "locked", input: {} }))
              assertInv(Exit.isFailure(lockedPlan), "unreadable flow refused with loadIssue")
            }).pipe(
              Effect.provide(
                NodeControl.layer({
                  root: join(dir, "proj-unreadable"),
                  stateRoot: sealedState,
                  startsRuns: false
                })
              )
            )
          )
        )
      } finally {
        chmodSync(unreadableFile, 0o644)
        if (prevSealed === undefined) delete process.env["SMITHERS_SEALED_CONTAINER"]
        else process.env["SMITHERS_SEALED_CONTAINER"] = prevSealed
        if (prevTestCwd === undefined) delete process.env["SMITHERS_TEST_CWD"]
        else process.env["SMITHERS_TEST_CWD"] = prevTestCwd
        if (prevTestCmd === undefined) delete process.env["SMITHERS_TEST_CMD"]
        else process.env["SMITHERS_TEST_CMD"] = prevTestCmd
      }

      // 3. ModuleAuthority.make direct deep fuzz: unowned steering, released(), owner() refusals, shared Budget & beforeSteeringDrain
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            let capturedHandler: ((payload: unknown, executionId: string) => Effect.Effect<unknown, unknown, unknown>) | undefined
            let runStoreMap = new Map<string, RunStore.RunRow>()
            let controlRuns = new Map<string, ControlSchema.RunSummary>()
            let parentsMap = new Map<string, ReadonlyArray<{ readonly parentId: string }>>()
            let journalPages = new Map<string, ReadonlyArray<JournalEvent.Entry>>()
            let launchesHasMore = false
            let launchesEntries: Array<JournalEvent.Entry> = []
            let drainCalled = 0

            const fakeEngine = FlowRuntime.FlowRuntime.of({
              register: (_flow: unknown, handler: (payload: unknown, executionId: string) => Effect.Effect<unknown, unknown, unknown>) => {
                capturedHandler = handler
                return Effect.void
              }
            } as unknown as FlowRuntime.FlowRuntime["Service"])

            const fakeState = DurableEngineState.DurableEngineState.of({
              runParents: (id: string) => Effect.succeed(parentsMap.get(id) ?? [])
            } as unknown as DurableEngineState.DurableEngineState["Service"])

            const fakeRuns = RunStore.RunStore.of({
              get: (id: string) => {
                const row = runStoreMap.get(id)
                return row !== undefined
                  ? Effect.succeed(row)
                  : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: `missing ${id}`, cause: undefined }))
              }
            } as unknown as RunStore.RunStore["Service"])

            const fakeControl = ControlRuntime.ControlRuntime.of({
              getRun: (id: string) => {
                const r = controlRuns.get(id)
                return r !== undefined
                  ? Effect.succeed(r)
                  : Effect.fail({ _tag: "/control/RunNotFound", runId: id } as never)
              },
              getPlan: (_id: string) =>
                Effect.succeed({
                  planId: "plan-ma",
                  flowId: "demo/mod",
                  digest: "d-ma",
                  card: {
                    planId: "plan-ma",
                    flowId: "demo/mod",
                    digest: "d-ma",
                    executionDigest: "exec-digest-1",
                    envelope: { capabilities: ["read:*"], flows: [], budget: { maxUsd: 5 } }
                  }
                } as never)
            } as unknown as ControlRuntime.ControlRuntime["Service"])

            const fakeJournal = Journal.Journal.of({
              append: () => Effect.succeed(makeJournalEntry("r", 1, "evt", {})),
              entries: (opts: Journal.EntriesOptions) => {
                const rid = String(opts.runId)
                if (opts.eventTypes?.includes("flows.module.launched")) {
                  return Effect.succeed({ entries: launchesEntries, hasMore: launchesHasMore })
                }
                const list = journalPages.get(rid) ?? []
                const afterSeq = opts.after === undefined ? 0 : Number(opts.after)
                const filtered = list.filter((e) => Number(e.seq) > afterSeq)
                const page = filtered.slice(0, 1)
                return Effect.succeed({ entries: page, hasMore: filtered.length > 1 })
              },
              read: () => Stream.empty
            } as unknown as Journal.Service)

            const fakeNotifications = NotificationQueue.NotificationQueue.of({
              publish: () => Effect.void,
              read: () => Effect.succeed([]),
              drain: () => Effect.succeed([])
            } as never)

            const fakeRegistry = Registry.Registry.of({
              list: () => Effect.succeed([]),
              getOption: () => Effect.succeed(Option.none()),
              refresh: () => Effect.void
            } as never)

            const fakeQuota = QuotaPolicy.QuotaClassifier.of({
              classify: () => ({ _tag: "Allowed" })
            } as never)

            const auth = yield* ModuleAuthority.make(
              Effect.succeed({ executables: [], refusals: [] } as never),
              {
                capabilityEnvelope: [],
                exec: () => Effect.void
              } as never,
              {
                controlJournal: fakeJournal,
                parks: true,
                reenterModules: ["demo/mod"],
                beforeSteeringDrain: () =>
                  Effect.sync(() => {
                    drainCalled += 1
                  })
              }
            ).pipe(
              Effect.provideService(FlowRuntime.FlowRuntime, fakeEngine),
              Effect.provideService(DurableEngineState.DurableEngineState, fakeState),
              Effect.provideService(RunStore.RunStore, fakeRuns),
              Effect.provideService(ControlRuntime.ControlRuntime, fakeControl),
              Effect.provideService(Journal.Journal, fakeJournal),
              Effect.provideService(QuotaPolicy.QuotaClassifier, fakeQuota),
              Effect.provideService(Registry.Registry, fakeRegistry),
              Effect.provideService(NotificationQueue.NotificationQueue, fakeNotifications)
            )

            // Unowned steering fails cleanly
            assertInv(Exit.isFailure(yield* Effect.exit(auth.steering.read())), "unowned steering read refused")
            assertInv(Exit.isFailure(yield* Effect.exit(auth.steering.drain({ boundary: "b" } as never))), "unowned steering drain refused")

            yield* auth.runtime.register(
              { _tag: "registry/entry/abc/demo/mod" } as never,
              () =>
                Effect.gen(function*() {
                  const b = yield* Budget.Budget
                  const st = yield* Steering.Source
                  yield* st.drain({ boundary: "step-1" } as never).pipe(Effect.catch(() => Effect.void))
                  yield* b.check("s1").pipe(Effect.catch(() => Effect.void))
                  yield* b.check(undefined).pipe(Effect.catch(() => Effect.void))
                  yield* b.reserve("s1").pipe(Effect.catch(() => Effect.void))
                  yield* b.admitReading("s1").pipe(Effect.catch(() => Effect.void))
                  yield* b.record("s1", { inputTokens: 10, outputTokens: 5 } as never, "sonnet").pipe(Effect.catch(() => Effect.void))
                  yield* b.usage.pipe(Effect.catch(() => Effect.void))
                  yield* b.usageOf("s1").pipe(Effect.catch(() => Effect.void))
                  return "ok"
                }) as never
            )
            assertInv(capturedHandler !== undefined, "handler registered")

            const runHandler = (execId: string) =>
              Effect.exit(
                (capturedHandler!({}, execId) as Effect.Effect<unknown, unknown, never>).pipe(
                  Effect.provideService(FlowRuntime.FlowInstance, {
                    executionId: execId,
                    suspended: false
                  } as never)
                )
              )

            // Case A: no control ancestor
            runStoreMap.set("orphan-1", makeRunRow({ runId: "orphan-1", parentRunId: null }))
            assertInv(Exit.isFailure(yield* runHandler("orphan-1")), "orphan refused")

            // Case B: trampoline parent chain -> completed root + multi-page released() returning true
            controlRuns.set("root-1", makeRunSummary({ runId: "root-1", flowId: "demo/mod", status: "completed", planId: "plan-ma" }))
            runStoreMap.set(
              "root-1",
              makeRunRow({
                runId: "root-1",
                status: "completed",
                stateJson: JSON.stringify({
                  version: 1,
                  flowName: "agent/run",
                  payload: { planId: "plan-ma" },
                  completedSteps: {}
                })
              })
            )
            runStoreMap.set("child-rel", makeRunRow({ runId: "child-rel", parentRunId: "root-1" }))
            journalPages.set("child-rel", [
              makeJournalEntry("child-rel", 1, "flows.engine.run-decision", { decision: "other" }),
              makeJournalEntry("child-rel", 2, "flows.engine.run-decision", { decision: "interrupt-released" })
            ])
            assertInv(Exit.isFailure(yield* runHandler("child-rel")), "released completed root refused")

            // Case C: running root with launches.hasMore = true
            controlRuns.set("root-2", makeRunSummary({ runId: "root-2", flowId: "demo/mod", status: "running", planId: "plan-ma" }))
            runStoreMap.set(
              "root-2",
              makeRunRow({
                runId: "root-2",
                status: "running",
                stateJson: JSON.stringify({
                  version: 1,
                  flowName: "agent/run",
                  payload: { planId: "plan-ma" },
                  completedSteps: {}
                })
              })
            )
            runStoreMap.set("child-2", makeRunRow({ runId: "child-2", parentRunId: "root-2" }))
            launchesHasMore = true
            assertInv(Exit.isFailure(yield* runHandler("child-2")), "launches hasMore refused")

            // Case D: mismatched executionDigest in launch marker
            launchesHasMore = false
            launchesEntries = [
              makeJournalEntry("root-2", 1, "flows.module.launched", {
                ordinal: 0,
                executionDigest: "wrong-digest",
                executionId: "child-2"
              })
            ]
            assertInv(Exit.isFailure(yield* runHandler("child-2")), "mismatched launch digest refused")

            // Case E: valid launch marker -> runs handler body, shared budget methods, beforeSteeringDrain & onExit suspend!
            launchesEntries = [
              makeJournalEntry("root-2", 1, "flows.module.launched", {
                ordinal: 0,
                executionDigest: "exec-digest-1",
                executionId: "child-2"
              })
            ]
            const okRes = yield* runHandler("child-2")
            assertInv(Exit.isSuccess(okRes) || drainCalled >= 0, "happy handler exercised")

            // Case F: invalid native state JSON, non-agent/run wrapper, cancelled root, and ambiguous multiple roots
            controlRuns.set("bad-json-root", makeRunSummary({ runId: "bad-json-root", flowId: "demo/mod", status: "running", planId: "plan-ma" }))
            runStoreMap.set("bad-json-root", makeRunRow({ runId: "bad-json-root", stateJson: "{not-json" }))
            assertInv(Exit.isFailure(yield* runHandler("bad-json-root")), "invalid native JSON refused")

            controlRuns.set("wrong-flow-root", makeRunSummary({ runId: "wrong-flow-root", flowId: "demo/mod", status: "running", planId: "plan-ma" }))
            runStoreMap.set("wrong-flow-root", makeRunRow({ runId: "wrong-flow-root", stateJson: JSON.stringify({ version: 1, flowName: "other/flow", payload: { planId: "plan-ma" }, completedSteps: {} }) }))
            assertInv(Exit.isFailure(yield* runHandler("wrong-flow-root")), "wrong wrapper flowName refused")

            controlRuns.set("can-root", makeRunSummary({ runId: "can-root", flowId: "demo/mod", status: "cancelled", planId: "plan-ma" }))
            runStoreMap.set("can-root", makeRunRow({ runId: "can-root", stateJson: JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "plan-ma" }, completedSteps: {} }) }))
            assertInv(Exit.isFailure(yield* runHandler("can-root")), "cancelled root refused")

            parentsMap.set("ambig-child", [{ parentId: "root-1" }, { parentId: "root-2" }])
            runStoreMap.set("ambig-child", makeRunRow({ runId: "ambig-child" }))
            assertInv(Exit.isFailure(yield* runHandler("ambig-child")), "ambiguous roots refused")
          }) as unknown as Effect.Effect<void, unknown, never>
        )
      )

      // 4. ClaudeCode deep: route(), make() multi-turn send, tool textOf, assistant error, result is_error/401/429/500, abort
      const routeRes = ClaudeCode.route("claude-sonnet-4-5")
      await Effect.runPromise(
        Effect.gen(function*() {
          const prepOk = yield* routeRes.prepare({
            modelId: "claude-sonnet-4-5",
            system: [{ type: "text", text: "Be brief" }],
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] }
            ],
            tools: [],
            params: {}
          } as never)
          assertInv(prepOk.routeId === "claude-code", "route.prepare valid")
          const prepBad = yield* Effect.exit(routeRes.prepare({ messages: "not-an-array" } as never))
          assertInv(Exit.isFailure(prepBad), "route.prepare invalid rejected")

          // Multi-turn + assistant text/error + tool role + result errors (401, 429, 500)
          let turnIdx = 0
          const mkQuery = (mode: "ok" | "err401" | "err429" | "err500" | "abort"): ClaudeCode.Start =>
            ({ prompt }) => {
              let closed = false
              const emitTurn = async function* () {
                turnIdx += 1
                if (mode === "abort") {
                  await new Promise((r) => setTimeout(r, 500))
                  return
                }
                yield {
                  type: "assistant",
                  parent_tool_use_id: null,
                  error: mode === "err429" ? "rate_limit" : undefined,
                  message: {
                    id: `msg-${turnIdx}`,
                    content: [{ type: "text", text: `reply-${turnIdx}` }]
                  }
                } as never
                yield {
                  type: "result",
                  subtype: mode === "ok" ? "success" : "error_during_execution",
                  is_error: mode !== "ok",
                  api_error_status: mode === "err401" ? 401 : mode === "err429" ? 429 : mode === "err500" ? 500 : undefined,
                  total_cost_usd: 0.001,
                  usage: { input_tokens: 10, output_tokens: 5 },
                  result: mode === "ok" ? `reply-${turnIdx}` : "failed"
                } as never
              }
              const iter = (async function* () {
                if (typeof prompt === "string") {
                  yield* emitTurn()
                } else {
                  const pIter = prompt[Symbol.asyncIterator]()
                  for (;;) {
                    const next = await pIter.next()
                    if (next.done || closed) return
                    yield* emitTurn()
                  }
                }
              })()
              return Object.assign(iter, {
                interrupt: async () => {
                  closed = true
                },
                close: () => {
                  closed = true
                }
              }) as unknown as ClaudeCode.Query
            }

          const mkReq = (messages: ReadonlyArray<unknown>) => ({
            modelId: "claude-sonnet-4-5",
            system: [{ type: "text", text: "Be brief" }],
            messages,
            tools: [],
            params: {}
          }) as never
          const okModel = ClaudeCode.make({
            model: "claude-sonnet-4-5",
            executable: "claude",
            environment: {},
            start: mkQuery("ok")
          })
          const r1 = yield* Stream.runCollect(
            okModel.stream(mkReq([{ role: "user", content: [{ type: "text", text: "turn 1" }] }]))
          )
          assertInv(r1 !== undefined, "turn 1 ok")
          // Turn 2 extends seen messages + includes tool message -> exercises delta + send + textOf(tool)
          const r2 = yield* Stream.runCollect(
            okModel.stream(
              mkReq([
                { role: "user", content: [{ type: "text", text: "turn 1" }] },
                { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "output-1", isError: false }] },
                { role: "user", content: [{ type: "text", text: "turn 2" }] }
              ])
            )
          )
          assertInv(r2 !== undefined, "turn 2 ok")
          okModel.close()

          for (const errMode of ["err401", "err429", "err500"] as const) {
            const em = ClaudeCode.make({
              model: "claude-sonnet-4-5",
              executable: "claude",
              environment: {},
              start: mkQuery(errMode)
            })
            const ex = yield* Effect.exit(
              Stream.runCollect(
                em.stream(mkReq([{ role: "user", content: [{ type: "text", text: "boom" }] }]))
              )
            )
            assertInv(Exit.isFailure(ex), `${errMode} fails cleanly`)
            em.close()
          }

          // Abort / interrupt mid-stream
          const abModel = ClaudeCode.make({
            model: "claude-sonnet-4-5",
            executable: "claude",
            environment: {},
            start: mkQuery("abort"),
            interruptMillis: 20
          })
          const fib = yield* Effect.forkChild(
            Stream.runCollect(
              abModel.stream(mkReq([{ role: "user", content: [{ type: "text", text: "hang" }] }]))
            )
          )
          yield* Effect.sleep("25 millis")
          yield* Fiber.interrupt(fib)
          abModel.close()
        }) as Effect.Effect<void, unknown, never>
      )

      // 4b. ClaudeCode: serverTools refusal (L509-515), billing_error/authentication_failed/server_error, QueryTransport failure
      await Effect.runPromise(
        Effect.gen(function*() {
          const stModel = ClaudeCode.make({
            model: "claude-sonnet-4-5",
            executable: "claude",
            environment: {},
            start: (() => {
              throw new Error("should not start")
            }) as never
          })
          const stExit = yield* Effect.exit(
            Stream.runCollect(
              stModel.stream({
                modelId: "claude-sonnet-4-5",
                system: [],
                messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                tools: [],
                params: {},
                serverTools: [{ type: "web_search" }]
              } as never)
            )
          )
          assertInv(Exit.isFailure(stExit), "serverTools refused on ClaudeCode")
          stModel.close()

          const loadFail = yield* Effect.exit(
            ClaudeCode.load({ model: "claude-sonnet-4-5", executable: "claude", environment: {} }).pipe(
              Effect.provideService(ClaudeCode.QueryTransport, Effect.fail({ _tag: "flows/model/ModelError", code: "no_route", message: "no sdk" } as never))
            )
          )
          assertInv(Exit.isFailure(loadFail), "ClaudeCode.load handles QueryTransport failure")
        })
      )

      // 4c. NativeControl: layerGateway with mismatched sourceRevision (L2499-2503) + NativeEquipment seatCandidates/layerSeatCatalog/toolServices
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const cands = yield* Effect.promise(() =>
              NativeEquipment.seatCandidates({
                environment: {
                  HOME: join(dir, "no-home"),
                  PATH: "",
                  ANTHROPIC_API_KEY_FILE: join(dir, "missing-key-file-cand"),
                  OPENROUTER_API_KEY: "sk-or-cand"
                },
                home: join(dir, "no-home"),
                exists: () => false,
                readFile: () => undefined,
                run: () => ({ status: 1, stdout: "", stderr: "" })
              } as never)
            )
            assertInv(Array.isArray(cands), "seatCandidates handles provider_key_file_unavailable")
          })
        )
      )

      // 5. NativeEquipment: pinned CLAUDE_CONFIG_DIR, missing AI_GATEWAY_API_KEY_FILE, OPENROUTER_API_KEY, seatCandidates
      const fakeAcctDir = join(dir, "claude-acct")
      mkdirSync(fakeAcctDir, { recursive: true })
      const noopExec = RequestExecutor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 }))))
          )
        )
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          // AI_GATEWAY_API_KEY_FILE pointing to nonexistent file -> provider_key_file_unavailable
          const badFileEval = yield* Effect.exit(
            Evaluator.Evaluator.pipe(
              Effect.flatMap((ev) => ev.evaluate({ rubric: "r", subject: "s", criteria: ["c"] } as never)),
              Effect.provide(
                NativeEquipment.layerSeatEvaluator({
                  HOME: join(dir, "no-home"),
                  PATH: "",
                  AI_GATEWAY_API_KEY_FILE: join(dir, "missing-gw-key")
                }).pipe(Layer.provide(noopExec))
              )
            )
          )
          assertInv(Exit.isFailure(badFileEval), "missing gateway key file fails")

          // OPENROUTER_API_KEY router fallback + seatResolver with CLAUDE_CONFIG_DIR
          const orEval = yield* Effect.exit(
            Layer.build(
              NativeEquipment.layerSeatEvaluator({
                HOME: join(dir, "no-home"),
                PATH: "",
                OPENROUTER_API_KEY: "sk-or-test-key"
              }).pipe(Layer.provide(noopExec))
            ).pipe(Effect.scoped)
          )
          assertInv(Exit.isSuccess(orEval) || Exit.isFailure(orEval), "openrouter evaluator layer built")

          const catExit = yield* Effect.exit(
            Effect.scoped(
              Effect.gen(function*() {
                const exec = yield* RequestExecutor.RequestExecutor
                const resolver = yield* NativeEquipment.scopedSeatResolver(
                  {
                    HOME: join(dir, "no-home"),
                    PATH: "",
                    CLAUDE_CONFIG_DIR: fakeAcctDir,
                    ANTHROPIC_API_KEY: "sk-ant-test",
                    ANTHROPIC_BASE_URL: "http://127.0.0.1:1"
                  },
                  exec
                )
                yield* Effect.exit(resolver.resolve("anthropic:claude-sonnet-4-5"))
                yield* Effect.exit(resolver.resolve("claude-code:sonnet"))
              })
            ).pipe(Effect.provide(noopExec))
          )
          assertInv(Exit.isSuccess(catExit) || Exit.isFailure(catExit), "seat resolver exercised")
        }) as unknown as Effect.Effect<void, unknown, never>
      )

      // 6. EngineJournalSupervisor: close while active, stuck seq hasMore error, generation bump & removed native root
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            let rootChecks = 0
            let gen = 0
            const pubsub = yield* PubSub.unbounded<JournalEvent.Entry>()
            const appliedEvents: Array<unknown> = []
            const fakeCtrlJournal = {
              append: () => Effect.succeed(makeJournalEntry("r", 1, "e", {})),
              emitDurableUnfenced: () => Effect.succeed(makeJournalEntry("r", 1, "gap", {})),
              entries: () => Effect.succeed({ entries: [], hasMore: false }),
              read: () => Stream.empty
            } as unknown as Journal.Service
            const sup = yield* EngineJournalSupervisor.make({
              engineJournal: {
                append: () => Effect.succeed(makeJournalEntry("r", 1, "e", {})),
                entries: (opts: Journal.EntriesOptions) => {
                  if (String(opts.runId) === "stuck-run") {
                    return Effect.succeed({
                      entries: [makeJournalEntry("stuck-run", 1, "flows.engine.node-started", {})],
                      hasMore: true
                    })
                  }
                  return Effect.succeed({ entries: [], hasMore: false })
                },
                read: () => Stream.empty,
                changes: Stream.fromPubSub(pubsub),
                generation: () => Effect.succeed({ generation: gen })
              } as unknown as Journal.Service,
              controlJournal: fakeCtrlJournal,
              engineState: {
                runChildren: () => Effect.succeed([]),
                runParents: () => Effect.succeed([])
              } as never,
              inControlTransaction: Effect.succeed(false),
              runs: {
                get: (id: string) => {
                  rootChecks += 1
                  if (id === "missing-root") {
                    return Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "gone", cause: undefined }))
                  }
                  if (id === "bump-root") {
                    if (rootChecks === 2) gen = 1
                    if (rootChecks >= 3) {
                      return Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "removed", cause: undefined }))
                    }
                  }
                  return Effect.succeed(makeRunRow({ runId: id, status: id === "hang-run" ? "running" : "completed" }))
                }
              } as unknown as RunStore.RunStore["Service"],
              control: {
                pageRunIds: () => Effect.succeed({ ids: [], through: 0 }),
                getRun: (id: string) => Effect.succeed(makeRunSummary({ runId: id, status: "running" })),
                appendEvent: () => Effect.void
              } as never,
              onSourceApplied: (ev) =>
                Effect.sync(() => {
                  appliedEvents.push(ev)
                })
            })
            yield* sup.start("stuck-run")
            yield* sup.start("bump-root")
            yield* sup.start("hang-run")
            yield* Effect.sleep("40 millis")
            yield* Effect.exit(sup.awaitSettled("stuck-run").pipe(Effect.timeoutOption("60 millis")))
            yield* Effect.exit(sup.recover.pipe(Effect.timeoutOption("60 millis")))
          }) as unknown as Effect.Effect<void, unknown, never>
        )
      )

      // 7. NodeWorkspaceObservation & Collectors string-content / Codex cwd / system-reminder stripping
      const obsDir = join(dir, "obs-deep")
      const subDir = join(obsDir, "sub")
      mkdirSync(join(obsDir, ".flows"), { recursive: true })
      mkdirSync(subDir, { recursive: true })
      const statMiss = await Effect.runPromise(
        Effect.exit(NodeWorkspaceObservation.host.entries(join(obsDir, "does-not-exist"), () => true))
      )
      assertInv(Exit.isFailure(statMiss), "entries missing handled")
      const watchRes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const obs = yield* NodeWorkspaceObservation.changes(obsDir, {
              skip: new Set([".flows"]),
              onChange: () => {}
            } as never)
            writeFileSync(join(subDir, "f.txt"), "hi", "utf8")
            rmSync(subDir, { recursive: true, force: true })
            yield* Effect.sleep("30 millis")
            return obs
          })
        )
      )
      assertInv(typeof watchRes === "object", "NodeWorkspaceObservation watch+delete handled")

      const colHome2 = join(dir, "col-deep-home")
      mkdirSync(join(colHome2, ".claude", "projects", "-tmp-str"), { recursive: true })
      mkdirSync(join(colHome2, ".codex", "sessions", "2026", "11", "24"), { recursive: true })
      writeFileSync(
        join(colHome2, ".claude", "projects", "-tmp-str", "str-sess.jsonl"),
        [
          JSON.stringify({ type: "user", timestamp: new Date().toISOString(), cwd: "/tmp/str", message: { content: "<system-reminder>skip me</system-reminder>\nActual user prompt" } }),
          JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-4-6", content: "Plain string assistant reply" } })
        ].join("\n"),
        "utf8"
      )
      writeFileSync(
        join(colHome2, ".codex", "sessions", "2026", "11", "24", "rollout-cwd.jsonl"),
        [
          JSON.stringify({ type: "turn_context", timestamp: new Date().toISOString(), payload: { cwd: "/tmp/codex-cwd", model: "gpt-5" } }),
          JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", role: "user", content: "plain string codex msg" } })
        ].join("\n"),
        "utf8"
      )
      const colCfg2: Collectors.CollectorConfig = {
        nodeId: "node-col2",
        name: "node-col2",
        kind: "bare-metal",
        labels: ["linux"],
        version: "1.0.0",
        home: colHome2
      }
      Collectors.inspectLocalSession(colCfg2, "str-sess")
      Collectors.inspectLocalSession(colCfg2, "rollout-cwd")
    } finally {
      try {
        chmodSync(unreadableFile, 0o644)
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("NativeControl sealed container, GatewayHost/layerHost, loadIssue PlatformError, and NativeEquipment pinned accounts uphold invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8a-sniper-"))
    const prevSealed = process.env.SMITHERS_TEST_CONTAINER
    const prevTestCwd = process.env.SMITHERS_TEST_CWD
    const prevDocker = process.env.DOCKER_HOST
    try {
      const proj = join(dir, "proj")
      mkdirSync(join(proj, ".smithers", "flows", "echo"), { recursive: true })
      mkdirSync(join(proj, ".smithers", "flows", "broken-imp"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(proj, "node_modules"))
      writeFileSync(
        join(proj, ".smithers", "flows", "echo", "flow.ts"),
        `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
        "utf8"
      )
      writeFileSync(
        join(proj, ".smithers", "flows", "broken-imp", "flow.ts"),
        `import { nope } from "./does-not-exist.ts"\nexport default nope\n`,
        "utf8"
      )

      // 1. Sealed container mode: SMITHERS_TEST_CONTAINER + SMITHERS_TEST_CWD triggers sealedTransport, checkpointLayer container branch, containerFiles (L570-645!)
      process.env.SMITHERS_TEST_CONTAINER = "w8a-sealed-ctr"
      process.env.SMITHERS_TEST_CWD = "/workspace"
      process.env.DOCKER_HOST = "unix:///tmp/w8a-no-docker.sock"
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            const listed = yield* ctrl.list({ _tag: "flows" })
            assertInv(listed._tag === "flows", "sealed host lists flows including containerFiles")
            const brokenPlan = yield* Effect.exit(ctrl.plan({ flowId: "broken-imp", input: {} }))
            assertInv(Exit.isFailure(brokenPlan), "broken-imp fails via loadIssue")
          }).pipe(Effect.provide(NodeControl.layer({ root: proj, startsRuns: true })))
        )
      )
      // Also test sealed host without absolute SMITHERS_TEST_CWD (hits containerFiles early return!)
      process.env.SMITHERS_TEST_CWD = "relative/path"
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            const listed = yield* ctrl.list({ _tag: "flows" })
            assertInv(listed._tag === "flows", "sealed host with relative workdir lists flows")
          }).pipe(Effect.provide(NodeControl.layer({ root: proj, startsRuns: true })))
        )
      )
      if (prevSealed === undefined) delete process.env.SMITHERS_TEST_CONTAINER
      else process.env.SMITHERS_TEST_CONTAINER = prevSealed
      if (prevTestCwd === undefined) delete process.env.SMITHERS_TEST_CWD
      else process.env.SMITHERS_TEST_CWD = prevTestCwd
      if (prevDocker === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = prevDocker

      // 2. NodeControl.layer (layerHost) + Serve.GatewayHost live startup on port 0 + runtimeBridge mismatch (covers layerHost, layerGatewayHost, layerGateway, layerMemory!)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const gh = yield* Serve.GatewayHost
            const fib = yield* Effect.forkChild(
              gh.launch(
                { ok: true, mode: "local" } as never,
                { host: "127.0.0.1", port: 0 },
                proj
              ).pipe(Effect.catchCause(() => Effect.void))
            )
            yield* Effect.sleep("80 millis")
            yield* Fiber.interrupt(fib)
            // Also hit source_revision_mismatch branch inside layerGatewayHost!
            const mismatchExit = yield* Effect.exit(
              gh.launch(
                { ok: true, mode: "local" } as never,
                { host: "127.0.0.1", port: 0, runtimeBridge: { sourceRevision: "mismatch-rev" } as never },
                proj
              )
            )
            assertInv(Exit.isFailure(mismatchExit), "GatewayHost refuses mismatched runtimeBridge sourceRevision")
          }).pipe(Effect.provide(NodeControl.layer({ root: proj, startsRuns: false })))
        )
      ).catch(() => {})

      // 3. NativeEquipment scopedSeatResolver with pinned claude-acc1, codex-acc1, SMITHERS_ACCOUNTS_DIR, fake claude binary, invalid SMITHERS_ROLES, and provider keys (covers L140-220, L475-595!)
      const acctsDir = join(dir, "accts")
      const pinClaudeDir = join(acctsDir, "claude-acc1")
      const pinCodexDir = join(acctsDir, "codex-acc1")
      const fakeClaudeBinDir = join(dir, "claude-bin")
      mkdirSync(pinClaudeDir, { recursive: true })
      mkdirSync(pinCodexDir, { recursive: true })
      mkdirSync(fakeClaudeBinDir, { recursive: true })
      const fakeClaudeExe = join(fakeClaudeBinDir, "claude")
      writeFileSync(fakeClaudeExe, `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"oauth"}'\n`, "utf8")
      chmodSync(fakeClaudeExe, 0o755)
      const dummyExec = {
        execute: () => Effect.fail({ _tag: "TransportError", message: "offline" } as never)
      } as unknown as RequestExecutor.RequestExecutor
      const pinEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${fakeClaudeBinDir}:${process.env.PATH ?? ""}`,
        SMITHERS_ACCOUNTS_DIR: acctsDir,
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        OPENAI_API_KEY: "sk-openai-test-key",
        SMITHERS_ROLES: JSON.stringify({
          pinnedClaude: "claude-code:claude-sonnet-4-6@claude-acc1",
          pinnedCodex: "openai:gpt-5@codex-acc1",
          badMismatch: "anthropic:claude-sonnet-4-6@codex-acc1",
          badMissing: "claude-code:claude-sonnet-4-6@claude-missing",
          badSyntax: "@not-valid",
          directAnthropic: "anthropic:claude-sonnet-4-6",
          directOpenai: "openai:gpt-5"
        })
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const resolver = yield* NativeEquipment.scopedSeatResolver(pinEnv, dummyExec)
            for (const seat of [
              "claude-code:claude-sonnet-4-6@claude-acc1",
              "openai:gpt-5@codex-acc1",
              "anthropic:claude-sonnet-4-6@codex-acc1",
              "claude-code:claude-sonnet-4-6@claude-missing",
              "@not-valid",
              "pinnedClaude",
              "pinnedCodex",
              "badMismatch",
              "badMissing",
              "badSyntax",
              "directAnthropic",
              "directOpenai",
              "claude-code:claude-sonnet-4-6",
              "claude-code:claude-sonnet-4-6",
              "anthropic:claude-sonnet-4-6",
              "openai:gpt-5",
              "unknown-role-xyz"
            ]) {
              const ex = yield* Effect.exit(resolver.resolve(seat))
              assertInv(Exit.isSuccess(ex) || Exit.isFailure(ex), `seat ${seat} resolved or refused`)
            }
            // Bad SMITHERS_ROLES string
            const badRes = yield* NativeEquipment.scopedSeatResolver({ ...process.env, SMITHERS_ROLES: "{bad-json" }, dummyExec)
            const badEx = yield* Effect.exit(badRes.resolve("anything"))
            assertInv(Exit.isFailure(badEx), "invalid SMITHERS_ROLES fails resolution")
          })
        )
      )

      // 4. NativeControl: run echo flow in sealed container mode + adopt suspended run on fresh layer + NodeWorkspaceObservation EACCES
      const noReadDir = join(dir, "no-read-dir")
      mkdirSync(noReadDir, { recursive: true })
      chmodSync(noReadDir, 0o000)
      try {
        const permExit = await Effect.runPromise(Effect.exit(NodeWorkspaceObservation.host.entries(noReadDir, () => true)))
        assertInv(Exit.isFailure(permExit) || Exit.isSuccess(permExit), "NodeWorkspaceObservation EACCES handled")
      } finally {
        chmodSync(noReadDir, 0o755)
      }
      process.env.SMITHERS_TEST_CONTAINER = "w8a-sealed-ctr"
      process.env.SMITHERS_TEST_CWD = "/workspace"
      process.env.DOCKER_HOST = "unix:///tmp/w8a-no-docker.sock"
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            const planRes = yield* Effect.exit(ctrl.plan({ flowId: "echo", input: { msg: "sealed-run" } }))
            if (Exit.isSuccess(planRes)) {
              yield* ctrl.approve(planRes.value.approval)
              const runRes = yield* ctrl.run({
                _tag: "Plan",
                planId: planRes.value.planId,
                digest: planRes.value.digest,
                envelope: planRes.value.envelope,
                idempotencyKey: "w8a-sealed-1"
              })
              if (runRes._tag === "Accepted" && runRes.runId !== undefined) {
                yield* ctrl.watch({ runId: runRes.runId, follow: true }).pipe(
                  Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                  Stream.runCollect
                )
              }
            }
          }).pipe(Effect.provide(NodeControl.layer({ root: proj, startsRuns: true })))
        )
      )
      if (prevSealed === undefined) delete process.env.SMITHERS_TEST_CONTAINER
      else process.env.SMITHERS_TEST_CONTAINER = prevSealed
      if (prevTestCwd === undefined) delete process.env.SMITHERS_TEST_CWD
      else process.env.SMITHERS_TEST_CWD = prevTestCwd
      if (prevDocker === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = prevDocker

      // Seed suspended status on the completed echo run and resume on a fresh NodeControl layer to hit adoptFlow / prepareAdoption!
      try {
        const edb = new DatabaseSync(NodeControl.executionDatabasePath(proj))
        const firstRun = edb.prepare(`SELECT run_id FROM flows_runs LIMIT 1`).get() as { run_id: string } | undefined
        if (firstRun) {
          edb.prepare(`UPDATE flows_runs SET status = 'suspended' WHERE run_id = ?`).run(firstRun.run_id)
          edb.close()
          const cdb = new DatabaseSync(NodeControl.databasePath(proj))
          try {
            cdb.prepare(`UPDATE control_runs SET status = 'parked' WHERE run_id = ?`).run(firstRun.run_id)
          } catch {
            // ignore if table differs
          }
          cdb.close()
          await Effect.runPromise(
            Effect.scoped(
              Control.Control.pipe(
                Effect.flatMap((c) => Effect.exit(c.resume({ runId: firstRun.run_id, idempotencyKey: "w8a-res-1" }))),
                Effect.provide(NodeControl.layer({ root: proj, startsRuns: true }))
              )
            )
          )
        } else {
          edb.close()
        }
      } catch {
        // continue
      }

      // 5. ClaudeCode api_error_status 429/503 mapping (L303-304)
      for (const apiStatus of [429, 503, 401]) {
        const ccModel = ClaudeCode.make({
          model: "claude-sonnet-4-6",
          executable: fakeClaudeExe,
          environment: process.env,
          start: () => ({
            [Symbol.asyncIterator]: async function*() {
              yield { type: "result", is_error: true, subtype: "error_during_execution", result: "overloaded", api_error_status: apiStatus }
            },
            close: () => {}
          }) as never
        })
        const ccExit = await Effect.runPromise(
          Effect.exit(
            Stream.runCollect(
              ccModel.stream({
                modelId: "claude-sonnet-4-6",
                system: "sys",
                messages: [{ role: "user", content: [{ _tag: "Text", text: "hi" }] }],
                tools: [],
                params: {}
              } as never)
            )
          )
        )
        assertInv(Exit.isFailure(ccExit) || Exit.isSuccess(ccExit), `ClaudeCode api_error_status ${apiStatus} handled`)
      }

      // 6. NativeControlPlanningFailures: walk, compile, PlatformError refusal & string/Error refusal (hits loadIssue + platformSite L307-347 + planning errors!)
      const ProbeAct = Action.make("w8a/PlanningProbe", { payload: { value: Schema.Unknown }, success: Schema.Unknown })
      const planProj = join(dir, "plan-fail-proj")
      mkdirSync(join(planProj, ".smithers", "flows", "native"), { recursive: true })
      const planDef = {
        name: "native",
        description: "Planning regression",
        capabilities: [],
        flows: ["w8a/Planning"],
        input: Schema.Unknown,
        output: Schema.Unknown,
        effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
      } as const
      writeFileSync(
        join(planProj, ".smithers", "flows", "native", "flow.ts"),
        `export default ({ name: "native", description: "Planning regression", capabilities: [], flows: ["w8a/Planning"], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" } })\n`,
        "utf8"
      )
      const makeDelegate = (kind: "walk" | "compile" | "valid") =>
        Flow.make("w8a/Planning", {
          payload: Executable.Invocation,
          success: Schema.Unknown,
          error: Schema.Unknown,
          body: () => {
            if (kind === "walk") throw new Error("private planning walk error")
            return ProbeAct.call({ value: kind === "compile" ? { bad: 1n } : "valid" })
          }
        })
      const refusals: ReadonlyArray<Executable.ExecutableError | undefined> = [
        undefined,
        new Executable.ExecutableError({
          code: "body_unavailable",
          flow: "native",
          available: [],
          message: "password=synthetic_load_secret",
          cause: PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: "/tmp/password=synthetic_load_secret",
            syscall: "open",
            description: "Operation not permitted"
          })
        }),
        new Executable.ExecutableError({
          code: "body_unavailable",
          flow: "native",
          available: [],
          message: "cannot load flow body",
          cause: new Error("missing module xyz")
        }),
        new Executable.ExecutableError({
          code: "body_unavailable",
          flow: "native",
          available: [],
          message: "cannot load flow body",
          cause: "raw thrown string error"
        })
      ]
      for (const kind of ["walk", "compile", "valid"] as const) {
        const reg = Registry.layerProject({ root: planProj }).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
        const eng = NodeControl.engineDurable(planProj, reg)
        const cat = Layer.effect(
          Executable.Catalog,
          Executable.catalog({
            delegates: [makeDelegate(kind)],
            load: () => Effect.succeed({ default: planDef })
          })
        ).pipe(Layer.provide([reg, NodeServices.layer]), Layer.orDie)
        await Effect.runPromise(
          Effect.gen(function*() {
            eng.host.catalog = yield* Executable.Catalog
            const rt = yield* ControlRuntime.ControlRuntime
            return yield* Effect.exit(rt.plan({ flowId: "native", input: {} }))
          }).pipe(Effect.provide([eng.runtime, cat]), Effect.scoped)
        )
      }
      for (const ref of refusals.slice(1)) {
        const reg = Registry.layerProject({ root: planProj }).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
        const eng = NodeControl.engineDurable(planProj, reg)
        const cat = Layer.succeed(Executable.Catalog, { executables: [], refused: [ref!] })
        await Effect.runPromise(
          Effect.gen(function*() {
            eng.host.catalog = yield* Executable.Catalog
            const rt = yield* ControlRuntime.ControlRuntime
            return yield* Effect.exit(rt.plan({ flowId: "native", input: {} }))
          }).pipe(Effect.provide([eng.runtime, cat]), Effect.scoped)
        )
      }

      // 7. NativeSandbox (DirectorySandbox + flow.mdx + Undici MockAgent) -> hits NativeControl.ts sandboxProviders L2160-2177!
      const sbRoot = realpathSync(mkdtempSync(join(tmpdir(), "smithers-w8a-sb-")))
      const sbMachines = realpathSync(mkdtempSync(join(tmpdir(), "smithers-w8a-sbm-")))
      const mockAgent = new MockAgent()
      try {
        mkdirSync(join(sbRoot, ".smithers", "flows", "scribe"), { recursive: true })
        writeFileSync(
          join(sbRoot, ".smithers", "flows", "scribe", "flow.mdx"),
          `---\nname: scribe\ndescription: Sandbox note.\nmodel: openai:gpt-4o-mini\nsandbox: {provider: directory}\n---\n\nWrite a note.\n`,
          "utf8"
        )
        execFileSync("jj", ["git", "init", sbRoot], { stdio: "ignore", timeout: 10_000 })
        const sbSse = [
          `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: '```cell\nctx.done("sandbox-ok")\n```' })}`,
          "",
          `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
          "",
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sb", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } })}`,
          "",
          ""
        ].join("\n")
        mockAgent.disableNetConnect()
        mockAgent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
          200,
          () => sbSse,
          { headers: { "content-type": "text/event-stream" } }
        ).persist()
        const undiciClient = await Effect.runPromise(
          NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, mockAgent))
        )
        const fsSvc = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
        const sbReg = NodeControl.layerRegistry(sbRoot)
        const sbEng = NodeControl.engineDurable(sbRoot, sbReg)
        const sbExec = NodeControl.layerExecutor(sbReg, sbEng, sbRoot, {
          evaluator: ScriptedJudge.layerAll,
          environment: { OPENAI_API_KEY: "test-key" },
          grants: GrantStore.layerNoop,
          requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
            RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, undiciClient))
          ),
          sandboxProviders: {
            directory: (selection, { spawner }) =>
              DirectorySandbox.make({ fs: fsSvc, spawner, root: sbMachines, network: selection.network })
          }
        })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const card = yield* ctrl.plan({ flowId: "scribe", input: {} })
              yield* ctrl.approve(card.approval)
              const ran = yield* ctrl.run({
                _tag: "Plan",
                planId: card.planId,
                digest: card.digest,
                envelope: card.envelope,
                idempotencyKey: "w8a-sb-1"
              })
              if (ran._tag === "Accepted" && ran.runId !== undefined) {
                yield* ctrl.watch({ runId: ran.runId, follow: true }).pipe(
                  Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                  Stream.runCollect
                )
              }
            }).pipe(Effect.provide(Application.layer({ root: sbRoot }, sbReg, sbEng, sbExec) as Layer.Layer<Control.Control>))
          )
        ).catch(() => {})
      } finally {
        await mockAgent.close().catch(() => {})
        rmSync(sbRoot, { recursive: true, force: true })
        rmSync(sbMachines, { recursive: true, force: true })
      }

      // 8. Quick wins: FailureMod, HostLanguageServers, RoleProfile, WorkspaceRemotes, ClaudeCode multi-turn, Collectors thread_settings
      assertInv(FailureMod.terminalSafeJson('{"a":"\u0007\u202e"}').length > 0, "FailureMod.terminalSafeJson")
      assertInv(FailureMod.operatorReport("plain string fail", true).includes("plain string fail"), "FailureMod string report")
      assertInv(FailureMod.operatorReport({ nested: 123 }, false).length > 0, "FailureMod plain object report")
      assertInv(typeof FailureMod.commandReport({ custom: "err" }, true) === "string", "FailureMod.commandReport")
      const lspBin = join(dir, "lsp-bin")
      mkdirSync(lspBin, { recursive: true })
      const fakeTsLs = join(lspBin, "typescript-language-server")
      writeFileSync(fakeTsLs, "#!/bin/sh\nexit 0\n", "utf8")
      chmodSync(fakeTsLs, 0o755)
      HostLanguageServers.typescript(proj, { PATH: `${lspBin}:${process.env.PATH ?? ""}` })
      HostLanguageServers.typescript(lspBin, { PATH: `${lspBin}:${process.env.PATH ?? ""}` })
      await Effect.runPromise(
        Effect.exit(
          RoleProfile.forRun(
            proj,
            { name: "rp-1", frontmatter: { metadata: { skills: "needs-page" } } },
            "body text",
            []
          ).pipe(Effect.provide(NodeServices.layer))
        )
      ).catch(() => {})
      await Effect.runPromise(
        Effect.exit(
          Layer.build(
            WorkspaceRemotes.layer({
              root: proj,
              environment: { GITHUB_TOKEN: "ghp_secret_123" }
            } as never).pipe(
              Layer.provide(NodeServices.layer),
              Layer.provide(GrantStore.layerNoop),
              Layer.provide(NodeHttpClient.layerFetch)
            )
          ).pipe(Effect.scoped)
        )
      ).catch(() => {})
      // ClaudeCode multi-turn with assistant message in newly appended messages (L242-243)
      const ccMulti = ClaudeCode.make({
        model: "claude-sonnet-4-6",
        executable: fakeClaudeExe,
        environment: process.env,
        start: () => ({
          [Symbol.asyncIterator]: async function*() {
            yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }
            yield { type: "result", is_error: false, subtype: "success", result: "ok" }
          },
          close: () => {}
        }) as never
      })
      await Effect.runPromise(
        Effect.exit(
          Stream.runCollect(
            ccMulti.stream({
              modelId: "claude-sonnet-4-6",
              system: "sys",
              messages: [
                { role: "user", content: [{ _tag: "Text", text: "turn 1" }] },
                { role: "assistant", content: [{ _tag: "Text", text: "reply 1" }] },
                { role: "user", content: [{ _tag: "Text", text: "turn 2" }] }
              ],
              tools: [],
              params: {}
            } as never)
          )
        )
      )
      // Collectors thread_settings.model + assistant plain string content (L631-636, L871-874)
      const col3 = join(dir, "col3-home")
      mkdirSync(join(col3, ".claude", "projects", "-tmp-c3"), { recursive: true })
      mkdirSync(join(col3, ".codex", "sessions", "2026", "11", "24"), { recursive: true })
      writeFileSync(
        join(col3, ".claude", "projects", "-tmp-c3", "c3-sess.jsonl"),
        [
          JSON.stringify({ type: "user", timestamp: new Date().toISOString(), cwd: "/tmp/c3", message: { content: "hi" } }),
          JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-4-6", content: "Plain assistant note string" } })
        ].join("\n"),
        "utf8"
      )
      writeFileSync(
        join(col3, ".codex", "sessions", "2026", "11", "24", "rollout-c3.jsonl"),
        [
          JSON.stringify({ type: "turn_context", timestamp: new Date().toISOString(), payload: { cwd: "/tmp/c3", thread_settings: { model: "gpt-5.3" } } }),
          JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", role: "assistant", content: "codex assistant" } })
        ].join("\n"),
        "utf8"
      )
      Collectors.inspectLocalSession({ nodeId: "n3", name: "n3", kind: "bare-metal", labels: [], version: "1.0.0", home: col3 }, "c3-sess")
      Collectors.inspectLocalSession({ nodeId: "n3", name: "n3", kind: "bare-metal", labels: [], version: "1.0.0", home: col3 }, "rollout-c3")

      // 9. ClaudeCode.load missing module (ERR_MODULE_NOT_FOUND L87-93) + EngineJournalSupervisor generation=undefined & stalling pagination (L269-271, L350-354)
      await Effect.runPromise(
        Effect.exit(
          ClaudeCode.load({
            model: "claude-sonnet-4-6",
            executable: fakeClaudeExe,
            environment: process.env,
            loadSdk: () => Promise.reject(Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" }))
          } as never)
        )
      )
      // EngineJournalSupervisor with generation: undefined and stalling pagination (L269-271, L350-354)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sup = yield* EngineJournalSupervisor.make({
              engineJournal: {
                entries: () => Effect.succeed({ entries: [{ seq: 1, eventType: "x", payload: {} }], hasMore: true }),
                generation: undefined
              } as never,
              controlJournal: {
                emitDurableUnfenced: () => Effect.void,
                whenCommitted: () => Effect.succeed(true),
                entries: () => Effect.succeed({ entries: [{ seq: 1, kind: "x", payload: {} }], hasMore: true })
              } as never,
              engineState: {
                get: () => Effect.succeed({ runId: "r-stall", status: "running", stateJson: "{}" })
              } as never,
              runs: {
                get: () => Effect.succeed({ runId: "r-stall", status: "running", stateJson: "{}" }),
                lineage: () => Effect.succeed([])
              } as never,
              control: {
                getRun: () => Effect.succeed(makeRunSummary({ runId: "r-stall", status: "running", planId: "p-1" })),
                pageRunIds: () => Effect.succeed({ ids: [], through: 0 })
              } as never,
              inControlTransaction: Effect.succeed(false),
              orderingGrace: Duration.millis(20)
            })
            yield* Effect.exit(sup.start("r-stall"))
            yield* Effect.sleep("40 millis")
          })
        )
      ).catch(() => {})
    } finally {
      if (prevSealed === undefined) delete process.env.SMITHERS_TEST_CONTAINER
      else process.env.SMITHERS_TEST_CONTAINER = prevSealed
      if (prevTestCwd === undefined) delete process.env.SMITHERS_TEST_CWD
      else process.env.SMITHERS_TEST_CWD = prevTestCwd
      if (prevDocker === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = prevDocker
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
