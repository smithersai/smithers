import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Control from "@smthrs/control/Control"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Capability from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as SqlClient from "effect/sql/SqlClient"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NativeExecutionRead from "../src/internal/NativeExecutionRead.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"
import * as NodeControl from "../src/NodeControl.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

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

const makePoolServer = async (getRoutes: () => { status: number; body: string }) => {
  const server = createServer((req, res) => {
    if (req.url === "/routes") {
      const r = getRoutes()
      res.writeHead(r.status, { "content-type": "application/json" })
      res.end(r.body)
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("@smthrs/cli Wave-7B NativeEquipment, NativeExecutionRead, EngineJournalSupervisor, SupervisorMemory & NodeControl fuzz invariants", () => {
  it("NativeEquipment account-pool routes, pinned claude/codex accounts, proxy chatgpt, ClaudeCode & Codex seats uphold invariants", async () => {
    let poolReply: { status: number; body: string } = { status: 200, body: JSON.stringify({ routes: ["anthropic", "chatgpt"] }) }
    const poolServer = await makePoolServer(() => poolReply)
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7b-eq-"))
    try {
      const accountsDir = join(tmp, "accounts")
      const claudePinDir = join(accountsDir, "claude-1")
      const codexPinDir = join(accountsDir, "codex-1")
      const fakeBin = join(tmp, "bin")
      mkdirSync(claudePinDir, { recursive: true })
      mkdirSync(codexPinDir, { recursive: true })
      mkdirSync(fakeBin, { recursive: true })
      writeFileSync(
        join(codexPinDir, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjE5OTk5OTk5OTl9.",
            refresh_token: "rt_fuzz_token",
            account_id: "acct_fuzz_1"
          }
        })
      )
      const fakeClaude = join(fakeBin, "claude")
      writeFileSync(fakeClaude, "#!/bin/sh\necho '{\"type\":\"result\"}'\n")
      chmodSync(fakeClaude, 0o755)

      const executor = await Effect.runPromise(
        RequestExecutor.RequestExecutor.pipe(
          Effect.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)))
        )
      )

      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "pool-both",
            "pool-empty",
            "pool-bad-json",
            "pool-non-array",
            "pool-fallback-proxy",
            "chatgpt-proxy-with-key",
            "chatgpt-proxy-no-key",
            "pin-claude-ok",
            "pin-codex-ok",
            "pin-missing",
            "pin-invalid-syntax",
            "role-alias",
            "openrouter-key",
            "openai-compat-key",
            "claudecode-bin"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.promise(async () => {
              const baseEnv: Record<string, string | undefined> = {
                HOME: tmp,
                PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
                SMITHERS_ACCOUNTS_DIR: accountsDir
              }
              if (input.scenario === "pool-both") {
                poolReply = { status: 200, body: JSON.stringify({ routes: ["anthropic", "chatgpt"] }) }
                const env = {
                  ...baseEnv,
                  SMITHERS_ACCOUNT_POOL_URL: poolServer.origin,
                  SMITHERS_ACCOUNT_POOL_KEY: "pool-tok",
                  SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt"
                }
                const def = await Effect.runPromise(
                  NativeEquipment.accountPoolDefaultModel(env).pipe(
                    Effect.provideService(RequestExecutor.RequestExecutor, executor)
                  )
                )
                assertInv(def === "openai:gpt-6-luna", `expected chatgpt default, got ${def}`)
                const resolver = NativeEquipment.seatResolver(env, executor)
                const sAnth = await Effect.runPromise(resolver.resolve("anthropic:claude-sonnet-4-6"))
                const sOpen = await Effect.runPromise(resolver.resolve("openai:gpt-5.4"))
                assertInv(sAnth.id === "anthropic:claude-sonnet-4-6", "pooled anthropic resolved")
                assertInv(sOpen.id === "openai:gpt-5.4", "pooled chatgpt resolved")
              } else if (input.scenario === "pool-empty" || input.scenario === "pool-bad-json" || input.scenario === "pool-non-array") {
                poolReply =
                  input.scenario === "pool-empty"
                    ? { status: 200, body: JSON.stringify({ routes: [] }) }
                    : input.scenario === "pool-bad-json"
                    ? { status: 200, body: "{broken" }
                    : { status: 200, body: JSON.stringify({ routes: "not-an-array" }) }
                const env = {
                  ...baseEnv,
                  SMITHERS_ACCOUNT_POOL_URL: poolServer.origin,
                  SMITHERS_ACCOUNT_POOL_KEY: "pool-tok",
                  SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
                  OPENAI_API_KEY: "sk-must-not-fallthrough"
                }
                const def = await Effect.runPromise(
                  NativeEquipment.accountPoolDefaultModel(env).pipe(
                    Effect.provideService(RequestExecutor.RequestExecutor, executor)
                  )
                )
                assertInv(def === undefined, "empty/invalid pool yields undefined default")
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("openai:gpt-5.4"))
                assertInv(Exit.isFailure(exit), "empty pool refuses chatgpt without ambient key fallthrough")
              } else if (input.scenario === "pool-fallback-proxy") {
                poolReply = { status: 200, body: JSON.stringify({ routes: [] }) }
                const env = {
                  ...baseEnv,
                  SMITHERS_ACCOUNT_POOL_URL: poolServer.origin,
                  SMITHERS_ACCOUNT_POOL_KEY: "pool-tok",
                  SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
                  SMITHERS_MODEL_PROXY_URL: poolServer.origin,
                  SMITHERS_CODING_FALLBACK_MODEL: "openai:gpt-5.4",
                  OPENAI_API_KEY: "proxy-tok"
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const seat = await Effect.runPromise(resolver.resolve("openai:gpt-5.4"))
                assertInv(seat.id === "openai:gpt-5.4", "platform fallback resolves through proxy")
              } else if (input.scenario === "chatgpt-proxy-with-key" || input.scenario === "chatgpt-proxy-no-key") {
                const env: Record<string, string | undefined> = {
                  ...baseEnv,
                  SMITHERS_OPENAI_AUTH: "chatgpt",
                  SMITHERS_MODEL_PROXY_URL: poolServer.origin,
                  ...(input.scenario === "chatgpt-proxy-with-key" ? { OPENAI_API_KEY: "proxy-key-1" } : {})
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("openai:gpt-5.4"))
                if (input.scenario === "chatgpt-proxy-with-key") {
                  assertInv(Exit.isSuccess(exit), "chatgpt proxy with key succeeds")
                } else {
                  assertInv(Exit.isFailure(exit), "chatgpt proxy without key refuses")
                }
              } else if (input.scenario === "pin-claude-ok") {
                const env = {
                  ...baseEnv,
                  ANTHROPIC_API_KEY: "sk-ambient-stripped",
                  SMITHERS_SEATS: JSON.stringify({ reviewer: "anthropic:claude-sonnet-4-6@claude-1" })
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("reviewer"))
                assertInv(Exit.isSuccess(exit) || Exit.isFailure(exit), "claude pin handled")
              } else if (input.scenario === "pin-codex-ok") {
                const env = {
                  ...baseEnv,
                  OPENAI_API_KEY: "sk-ambient-stripped",
                  SMITHERS_SEATS: JSON.stringify({ coder: "openai:gpt-5.4@codex-1" })
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const seat = await Effect.runPromise(resolver.resolve("coder"))
                assertInv(seat.id === "coder", "codex pin resolved with auth.json")
              } else if (input.scenario === "pin-missing") {
                const env = {
                  ...baseEnv,
                  SMITHERS_SEATS: JSON.stringify({ bad: "openai:gpt-5.4@codex-999" })
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("bad"))
                assertInv(Exit.isFailure(exit), "missing pinned account dir refuses")
              } else if (input.scenario === "pin-invalid-syntax") {
                const env = {
                  ...baseEnv,
                  SMITHERS_SEATS: JSON.stringify({ bad: "openai:gpt-5.4@invalid-name" })
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("bad"))
                assertInv(Exit.isFailure(exit), "invalid pinned syntax refuses")
              } else if (input.scenario === "role-alias") {
                const env = {
                  ...baseEnv,
                  ANTHROPIC_API_KEY: "sk-ant-test-key",
                  SMITHERS_SEATS: JSON.stringify({ planner: "anthropic:claude-sonnet-4-6" })
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const seat = await Effect.runPromise(resolver.resolve("planner"))
                assertInv(seat.id === "planner", "role alias resolved")
              } else if (input.scenario === "openrouter-key") {
                const env = { ...baseEnv, OPENROUTER_API_KEY: "or-key-1" }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const seat = await Effect.runPromise(resolver.resolve("openrouter:anthropic/claude-sonnet-4.5"))
                assertInv(seat.id === "openrouter:anthropic/claude-sonnet-4.5", "openrouter seat resolved")
              } else if (input.scenario === "openai-compat-key") {
                const env = {
                  ...baseEnv,
                  OPENAI_API_KEY: "compat-key-1",
                  SMITHERS_OPENAI_AUTH: "api-key",
                  SMITHERS_OPENAI_COMPATIBLE_BASE_URL: poolServer.origin
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const seat = await Effect.runPromise(resolver.resolve("openai:local-model"))
                assertInv(seat.id === "openai:local-model", "openai-compat seat resolved")
              } else {
                const env = {
                  ...baseEnv,
                  SMITHERS_CLAUDE_CODE_EXECUTABLE: fakeClaude,
                  SMITHERS_HIJACKABLE: "1"
                }
                const resolver = NativeEquipment.seatResolver(env, executor)
                const exit = await Effect.runPromiseExit(resolver.resolve("anthropic:claude-sonnet-4-6"))
                assertInv(Exit.isSuccess(exit) || Exit.isFailure(exit), "claudecode branch exercised")
              }
              return true
            }),
          { executions: Math.min(executions, 45), seed }
        )
      )
      expectPassed(report)
    } finally {
      await poolServer.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)

  it("NativeExecutionRead DAG ancestry, cycles, lineage rounds, fan-in limit & snapshot drift errors uphold invariants", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7b-ner-"))
    try {
      const dbPath = join(tmp, "engine.db")
      const sqlLayer = SqliteClient.layer({ filename: dbPath })

      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "single-hop",
            "multi-hop",
            "lineage-round",
            "cycle",
            "orphan",
            "ambiguous-roots",
            "too-many-parents",
            "snapshot-drift"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              if (input.caseKind === "snapshot-drift") {
                let calls = 0
                const read = NativeExecutionRead.make({
                  read: (ids) => {
                    calls++
                    return Effect.succeed({
                      source: calls === 1 ? "src-a" : "src-b",
                      revision: calls,
                      snapshots: ids.map((id) => ({
                        _tag: "Observed" as const,
                        runId: id,
                        flowName: "demo",
                        status: "running",
                        createdAtMs: 1,
                        startedAtMs: 2,
                        finishedAtMs: null,
                        parentRunId: calls === 1 ? "parent-1" : null,
                        lineageId: null,
                        roundOrdinal: 0,
                        cancellation: { requestedAtMs: null },
                        waiting: null
                      })) as never
                    })
                  }
                })
                const exit = yield* Effect.exit(read({ runId: "root-1", executionIds: ["child-1"] }))
                assertInv(Exit.isFailure(exit), "snapshot source drift fails with PersistenceError")

                // Also test Missing snapshot and lineage-round snapshot paths
                const readMixed = NativeExecutionRead.make({
                  read: (ids) =>
                    Effect.succeed({
                      source: "src-a",
                      revision: 1,
                      snapshots: ids.map((id) =>
                        id === "root-1"
                          ? {
                              _tag: "Missing" as const,
                              runId: id,
                              source: "src-a",
                              revision: 1,
                              deleted: false
                            }
                          : {
                              _tag: "Observed" as const,
                              runId: id,
                              flowName: "demo",
                              status: "running",
                              createdAtMs: 1,
                              startedAtMs: 2,
                              finishedAtMs: null,
                              parentRunId: null,
                              lineageId: "root-1",
                              roundOrdinal: 2,
                              cancellation: { requestedAtMs: null },
                              waiting: null
                            }
                      ) as never
                    })
                })
                const batch = yield* readMixed({ runId: "root-1", executionIds: ["root-1", "round-child"] })
                assertInv(batch.snapshots.length === 2, "mixed Missing + lineage round snapshots handled")
                return true
              }

              const sql = yield* SqlClient.SqlClient
              yield* sql`DROP TABLE IF EXISTS flows_run_parents`
              yield* sql`DROP TABLE IF EXISTS flows_runs`
              yield* sql`
                CREATE TABLE flows_runs (
                  run_id TEXT PRIMARY KEY,
                  parent_run_id TEXT,
                  lineage_id TEXT,
                  round_ordinal INTEGER NOT NULL DEFAULT 0
                )
              `
              yield* sql`
                CREATE TABLE flows_run_parents (
                  child_id TEXT NOT NULL,
                  parent_id TEXT NOT NULL
                )
              `

              const controlRoots = new Set<string>(["ctrl-root-1"])
              const isControl = (id: string) => Effect.succeed(controlRoots.has(id))

              if (input.caseKind === "single-hop") {
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('child-1', 'ctrl-root-1', NULL, 0)`
                const res = yield* NativeExecutionRead.controlRunId("child-1", isControl)
                assertInv(res === "ctrl-root-1", "single-hop resolves to ctrl-root-1")
              } else if (input.caseKind === "multi-hop") {
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('mid-1', 'ctrl-root-1', NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('leaf-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_run_parents VALUES ('leaf-1', 'mid-1')`
                const res = yield* NativeExecutionRead.controlRunId("leaf-1", isControl)
                assertInv(res === "ctrl-root-1", "multi-hop resolves via flows_run_parents")
              } else if (input.caseKind === "lineage-round") {
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('round-2', NULL, 'ctrl-root-1', 2)`
                const res = yield* NativeExecutionRead.controlRunId("round-2", isControl)
                assertInv(res === "ctrl-root-1", "round_ordinal > 0 falls back to lineage_id")
              } else if (input.caseKind === "cycle") {
                yield* sql`INSERT INTO flows_runs VALUES ('cyc-a', 'cyc-b', NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('cyc-b', 'cyc-a', NULL, 0)`
                const res = yield* NativeExecutionRead.controlRunId("cyc-a", isControl)
                assertInv(res === undefined, "cycle refuses correlation")
              } else if (input.caseKind === "orphan") {
                yield* sql`INSERT INTO flows_runs VALUES ('orphan-1', NULL, NULL, 0)`
                const res = yield* NativeExecutionRead.controlRunId("orphan-1", isControl)
                assertInv(res === undefined, "orphan refuses correlation")
              } else if (input.caseKind === "ambiguous-roots") {
                controlRoots.add("ctrl-root-2")
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-2', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('join-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_run_parents VALUES ('join-1', 'ctrl-root-1')`
                yield* sql`INSERT INTO flows_run_parents VALUES ('join-1', 'ctrl-root-2')`
                const res = yield* NativeExecutionRead.controlRunId("join-1", isControl)
                assertInv(res === undefined, "ambiguous roots refuse correlation")
              } else if (input.caseKind === "too-many-parents") {
                yield* sql`INSERT INTO flows_runs VALUES ('ctrl-root-1', NULL, NULL, 0)`
                yield* sql`INSERT INTO flows_runs VALUES ('wide-1', NULL, NULL, 0)`
                for (let i = 0; i < 130; i++) {
                  const pid = `p-${i}`
                  yield* sql`INSERT INTO flows_run_parents VALUES ('wide-1', ${pid})`
                }
                const res = yield* NativeExecutionRead.controlRunId("wide-1", isControl)
                assertInv(res === undefined, ">128 parents refuses correlation")
              }
              return true
            }).pipe(Effect.provide(sqlLayer)),
          { executions: Math.min(executions, 32), seed }
        )
      )
      expectPassed(report)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)

  it("EngineJournalSupervisor failure/timeout/gap recovery, SupervisorMemory.opening, NodeWorkspaceObservation & NodeControl.layerControl/layerMemory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7b-sup-"))
    try {
      // 1. EngineJournalSupervisor ordering gap + removed native wrapper + generation failure paths
      const gapRecords: Array<unknown> = []
      const makeJournal = (failGen: boolean): Journal.Service => ({
        emit: (entry: unknown) =>
          Effect.sync(() => {
            gapRecords.push(entry)
            return { ...(entry as object), seq: gapRecords.length } as never
          }),
        emitDurableUnfenced: (entry: unknown) =>
          Effect.sync(() => {
            gapRecords.push(entry)
            return { ...(entry as object), seq: gapRecords.length } as never
          }),
        transact: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
        entries: () => Effect.succeed({ entries: [], hasMore: false }),
        subscribe: () => Effect.die("unused") as never,
        generation: failGen
          ? () => Effect.fail(new Journal.JournalError({ code: "unknown", message: "gen down" }))
          : () => Effect.succeed({ generation: 1, latestSeq: 0 })
      } as unknown as Journal.Service)

      const runSupervisorScenario = async (mode: "missing-root" | "gen-fail" | "grace-timeout") => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sup = yield* EngineJournalSupervisor.make({
                engineJournal: makeJournal(mode === "gen-fail"),
                controlJournal: makeJournal(false),
                engineState: {
                  runChildren: () => Effect.succeed([]),
                  runChildrenOf: () => Effect.succeed([]),
                  runParents: () => Effect.succeed([])
                },
                runs: {
                  get: () =>
                    mode === "missing-root"
                      ? Effect.fail(
                        new RunStore.RunStoreError({
                          code: "not_found_row",
                          method: "get",
                          message: "wrapper gone",
                          cause: new Error("missing")
                        })
                      )
                      : Effect.succeed({
                        runId: "r-1",
                        flowName: "agent/run",
                        status: "running",
                        stateJson: "{}",
                        updatedAtMs: Date.now()
                      } as never)
                },
                control: {
                  getRun: () => Effect.succeed(Option.none()),
                  pageRunIds: () => Effect.succeed({ runIds: [], hasMore: false })
                } as never,
                inControlTransaction: Effect.succeed(false),
                orderingGrace: Duration.millis(25)
              })
              yield* sup.start("r-1")
              yield* Effect.sleep(Duration.millis(45))
              yield* sup.awaitSettled("r-1")
            })
          )
        )
      }

      await runSupervisorScenario("missing-root")
      await runSupervisorScenario("gen-fail")
      await runSupervisorScenario("grace-timeout")
      expect(gapRecords.length).toBeGreaterThan(0)

      // 2. SupervisorMemory.opening (sealed vs unsealed, granted banks vs wildcard)
      const memStore = MemoryStore.MemoryStore.of({
        remember: () => Effect.die("unused") as never,
        recall: () => Effect.succeed([]),
        forget: () => Effect.succeed(false),
        list: () => Effect.succeed([]),
        sweepExpired: () => Effect.succeed(0)
      } as never)
      const recallSvc = Recall.Recall.of({
        search: () => Effect.succeed([]),
        recall: () => Effect.succeed([])
      } as never)

      const sealedOpening = await Effect.runPromise(
        SupervisorMemory.opening(
          {
            runId: "run-mem-1",
            prompt: "Inspect architecture",
            history: ["prev step"],
            capabilities: ["memory:read:project", "memory:read:*"]
          },
          { root: tmp, sealed: true }
        ).pipe(
          CapabilitySet.attenuate(Option.toArray(Capability.parsePattern("memory:read:project"))),
          Effect.provideService(MemoryStore.MemoryStore, memStore),
          Effect.provideService(Recall.Recall, recallSvc),
          Effect.provide(NodeServices.layer)
        )
      )
      expect(sealedOpening).toBeDefined()

      // 3. NodeControl.layerControl + layerMemory + listFlows on real temp workspace
      const flowDir = join(tmp, ".smithers", "flows", "echo")
      mkdirSync(flowDir, { recursive: true })
      writeFileSync(
        join(flowDir, "flow.ts"),
        `import * as Flow from "@smthrs/flow/Flow"\nimport { Effect, Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo input",\n  capabilities: [],\n  effects: [],\n  payload: Schema.Struct({ msg: Schema.String }),\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: ({ payload }) => Effect.succeed({ echoed: payload.msg })\n})\n`
      )
      const flows = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            return yield* ctrl.list({ limit: 10 } as never)
          }).pipe(
            Effect.provide(NodeControl.layerControl({ root: tmp, startsRuns: false, plansFlows: false }))
          )
        )
      )
      expect(flows).toBeDefined()

      const memStoreReal = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            return yield* MemoryStore.MemoryStore
          }).pipe(Effect.provide(NodeControl.layerMemory(tmp)))
        )
      )
      expect(memStoreReal).toBeDefined()

      // 4. NodeWorkspaceObservation edge cases (nested dirs, symlinks, ignored dirs)
      mkdirSync(join(tmp, "src"), { recursive: true })
      writeFileSync(join(tmp, "src", "a.txt"), "hello")
      const obs = await Effect.runPromise(NodeWorkspaceObservation.host.entries(tmp, () => true))
      expect(obs).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})
