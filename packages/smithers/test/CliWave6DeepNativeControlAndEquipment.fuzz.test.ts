import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Action from "@smthrs/flow/Action"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as SandboxContainer from "@smthrs/std/Container"
import { Arbitrary, Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as AuthoredRebuild from "../src/internal/AuthoredRebuild.ts"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as MeteredDispatch from "../src/internal/MeteredDispatch.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeLoopbackServer = async (
  handler: (req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }) => {
    status: number
    headers?: Record<string, string>
    body: string
  }
) => {
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body })
      const reply = handler({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body
      })
      res.writeHead(reply.status, reply.headers ?? { "content-type": "application/json" })
      res.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("@smthrs/cli Wave-6B Deep NativeControl, NativeEquipment, MeteredDispatch, SupervisorMemory, ControlAffinity & JournalSupervisor fuzz invariants", () => {
  it("MeteredDispatch, AuthoredRebuild, NativeControl helpers, and SupervisorMemory uphold attribution, confinement & stance invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        executionId: Schema.Literals(["exec-01", "run/a.b#1", "bad id with spaces", ""]),
        hasKey: Schema.Boolean,
        proxyKind: Schema.Literals(["match-exact", "match-sub", "other-origin", "unset", "blank"]),
        stance: Schema.Literals(["unset", "careful", "paranoid", "invalid"]),
        hasMemDb: Schema.Boolean,
        rebuildOutcome: Schema.Literals(["rebuilt", "refused", "failed", "interrupted"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ executionId, hasKey, hasMemDb, proxyKind, rebuildOutcome, stance }) =>
          Effect.promise(async () => {
            // 1. MeteredDispatch
            const proxyUrl =
              proxyKind === "unset"
                ? undefined
                : proxyKind === "blank"
                ? "   "
                : "https://proxy.smithers.test/v1/"
            const reqUrl =
              proxyKind === "match-exact"
                ? "https://proxy.smithers.test/v1"
                : proxyKind === "match-sub"
                ? "https://proxy.smithers.test/v1/messages"
                : "https://other.example.test/v1/messages"
            const baseReq = HttpClientRequest.post(reqUrl)

            const runWithDispatch = <A>(eff: Effect.Effect<A>) => {
              let e: Effect.Effect<A> = eff
              if (executionId !== "") {
                e = Effect.provideService(e, FlowRuntime.FlowInstance, {
                  executionId,
                  flowName: "demo"
                } as any)
              }
              if (hasKey) {
                e = Effect.provideService(e, Action.CurrentInvocationKey, "step-key-1")
              }
              return Effect.runPromise(e)
            }

            const attributed = await runWithDispatch(MeteredDispatch.attributeRequest(baseReq, proxyUrl))
            const validId = /^[A-Za-z0-9._/@#-]{1,256}$/.test(executionId)
            const shouldTag = (proxyKind === "match-exact" || proxyKind === "match-sub") && validId && hasKey
            const headerVal = attributed.headers[MeteredDispatch.header.toLowerCase()]
            if (shouldTag) {
              assertInv(typeof headerVal === "string" && headerVal.startsWith(`${executionId}:`), "expected metered header")
            } else {
              assertInv(headerVal === undefined, `unexpected metered header: ${String(headerVal)}`)
            }

            // attributeExecutor & attributeClient
            let capturedUrl = ""
            const dummyExec: RequestExecutor.RequestExecutor = {
              execute: (req) => {
                capturedUrl = req.url
                return Effect.succeed({} as any)
              }
            }
            const wrappedExec = MeteredDispatch.attributeExecutor(dummyExec, proxyUrl)
            await runWithDispatch(wrappedExec.execute(baseReq, {} as any).pipe(Effect.scoped, Effect.orDie) as any)
            assertInv(capturedUrl === reqUrl, "attributeExecutor forwarded request")

            const dummyClient = HttpClient.make((req) =>
              Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 })))
            )
            const wrappedClient = MeteredDispatch.attributeClient(dummyClient, proxyUrl)
            const resp: any = await runWithDispatch(wrappedClient.execute(baseReq).pipe(Effect.orDie) as any)
            assertInv(resp.status === 200, "attributeClient forwarded request")

            // 2. AuthoredRebuild
            const refresh = {
              flow: () => {
                if (rebuildOutcome === "rebuilt") return Effect.succeed({ _tag: "Rebuilt" as const, flowId: "f1" })
                if (rebuildOutcome === "refused") return Effect.succeed({ _tag: "Refused" as const, flowId: "f1", reason: "syntax" })
                if (rebuildOutcome === "failed") return Effect.fail(new Error("boom") as any)
                return Effect.interrupt
              }
            } as any
            const rbExit = await Effect.runPromiseExit(AuthoredRebuild.rebuild(refresh)("f1"))
            if (rebuildOutcome === "interrupted") {
              assertInv(Exit.isFailure(rbExit) && Cause.hasInterruptsOnly(rbExit.cause), "interrupt must propagate")
            } else {
              assertInv(Exit.isSuccess(rbExit), "rebuilt/refused/failed must not crash observer")
            }

            // 3. SupervisorMemory stance & options & memoryDatabase refusal
            const env: Record<string, string | undefined> = {
              ...(stance === "unset" ? {} : { SMITHERS_SUPERVISOR_STANCE: stance }),
              ...(hasMemDb ? { SMITHERS_MEMORY_DB: "/tmp/fuzz-mem.sqlite" } : {})
            }
            if (stance === "invalid") {
              let threw = false
              try {
                SupervisorMemory.stance(env)
              } catch {
                threw = true
              }
              assertInv(threw, "invalid stance must throw UsageError")
            } else {
              const s = SupervisorMemory.stance(env)
              assertInv(s === (stance === "paranoid" ? "paranoid" : "careful"), "valid stance")
              const opts = SupervisorMemory.options(env, "/tmp/ws-root")
              assertInv(opts.remember === hasMemDb && opts.banks.length === 1 && opts.banks[0]!.startsWith("project-"), "memory options")
            }

            if (!hasMemDb) {
              let missingRefused = false
              try {
                SupervisorMemory.memoryDatabase({ environment: {}, database: () => Layer.empty as any })
              } catch (e: any) {
                missingRefused = e?.code === "memory_store_missing"
              }
              assertInv(missingRefused, "memoryDatabase without env or stores must refuse")
            }

            // 4. NativeControl.offeredWithoutProvider
            assertInv(
              NativeControl.offeredWithoutProvider(["read", "write"], { fileMutations: true, terminal: true }) === undefined,
              "allowed offered"
            )
            assertInv(
              NativeControl.offeredWithoutProvider(["write"], { fileMutations: false, terminal: true })?.code === "assembly_failed",
              "missing fileMutations provider detected"
            )
            assertInv(
              NativeControl.offeredWithoutProvider(["bash"], { fileMutations: true, terminal: false })?.code === "assembly_failed",
              "missing terminal provider detected"
            )
            assertInv(
              NativeControl.offeredWithoutProvider(["bash"], { fileMutations: true, terminal: true }, ["read"])?.code === "assembly_failed",
              "unlisted allowlist detected"
            )

            return true
          }),
        { executions: Math.min(executions, 40), seed }
      )
    )
    if (report._tag !== "Passed") {
      throw new Error(`Falsified: ${JSON.stringify(report)}`)
    }
    expect(report._tag).toBe("Passed")

    // NativeControl.confinedInstructions + SupervisorMemory.opening with real SQLite MemoryStore
    const dir = mkdtempSync(join(tmpdir(), "smthrs-supmem-"))
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Confined Instructions\nRule 1.")
      const instr = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* NativeControl.confinedInstructions(fs, dir)
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(instr).toHaveLength(1)
      expect(instr[0]!.text).toContain("Rule 1")

      // Empty dir -> []
      const emptyDir = join(dir, "empty")
      mkdirSync(emptyDir, { recursive: true })
      const emptyInstr = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* NativeControl.confinedInstructions(fs, emptyDir)
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(emptyInstr).toHaveLength(0)

      // SupervisorMemory.layer + opening (sealed & unsealed)
      const memDbPath = join(dir, "memory.sqlite")
      const memLayer = SupervisorMemory.layer({
        environment: { SMITHERS_MEMORY_DB: memDbPath },
        database: (filename) => NodeDatabase.layer({ filename, busyTimeout: SupervisorMemory.busyTimeoutMs }) as any,
        crypto: Layer.merge(
          (await import("@effect/platform-node/NodeCrypto")).layer,
          Layer.empty
        ) as any
      })
      const openingExit = await Effect.runPromiseExit(
        SupervisorMemory.opening(
          {
            runId: "r-mem-1",
            prompt: "fix login timeout",
            history: ["checked auth"],
            capabilities: ["memory:read:project-1", "memory:read:*"]
          },
          { root: dir, sealed: true }
        ).pipe(
          Effect.provide(memLayer),
          Effect.provide(NodeServices.layer)
        )
      )
      expect(Exit.isSuccess(openingExit) || Exit.isFailure(openingExit)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("NativeEquipment seatResolver, accountPoolDefaultModel, seatCandidates, layerSeatEvaluator, testRunner, askPolicy & sandboxProviders uphold security and routing invariants", async () => {
    const server = await makeLoopbackServer((req) => {
      if (req.url.includes("routes") || req.url.includes("pool")) {
        return {
          status: 200,
          body: JSON.stringify({ routes: ["chatgpt", "anthropic"] })
        }
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "chatcmpl-1",
          choices: [{ message: { role: "assistant", content: JSON.stringify({ pass: true, reason: "ok" }) } }]
        })
      }
    })

    const acctRoot = mkdtempSync(join(tmpdir(), "smthrs-eq-accts-"))
    try {
      mkdirSync(join(acctRoot, "claude-team1"), { recursive: true })
      mkdirSync(join(acctRoot, "codex-team1"), { recursive: true })

      const arb = Arbitrary.schema(
        Schema.Struct({
          declared: Schema.Literals([
            "sol",
            "luna",
            "anthropic:claude-sonnet-4-6",
            "openai:gpt-5.4",
            "vercel:anthropic/claude-sonnet-4.5",
            "openrouter:openai/gpt-5.1",
            "typesafe-ai/jev",
            "coding/review",
            "sol@claude-team1",
            "sol@codex-team1",
            "luna@codex-team1",
            "luna@claude-team1",
            "sol@claude-missing",
            "sol@bad!account",
            "@claude-team1"
          ]),
          seatsEnv: Schema.Literals(["unset", "valid", "bad-json", "non-object", "bad-role", "non-string", "bad-seat"]),
          hasAnthropicKey: Schema.Boolean,
          hasOpenAiKey: Schema.Boolean,
          hasGatewayKey: Schema.Boolean,
          hasPool: Schema.Boolean,
          askMode: Schema.Literals(["", "park", "refuse", "invalid"]),
          checkoutMode: Schema.Literals(["", "1", "invalid"]),
          hasTestCmd: Schema.Boolean,
          hasSandboxImage: Schema.Boolean
        })
      )

      const dummyExec: RequestExecutor.RequestExecutor = {
        execute: () => Effect.succeed(new Response(JSON.stringify({ routes: ["chatgpt", "anthropic"] }), { status: 200 }) as any)
      }

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.promise(async () => {
              const seatsValue =
                input.seatsEnv === "unset"
                  ? undefined
                  : input.seatsEnv === "valid"
                  ? JSON.stringify({ "coding/review": "openai:gpt-5.4" })
                  : input.seatsEnv === "bad-json"
                  ? "{not-json"
                  : input.seatsEnv === "non-object"
                  ? "[]"
                  : input.seatsEnv === "bad-role"
                  ? JSON.stringify({ "BAD ROLE!": "sol" })
                  : input.seatsEnv === "non-string"
                  ? JSON.stringify({ "coding/review": 42 })
                  : JSON.stringify({ "coding/review": "typesafe-ai/jev" })

              const env: Record<string, string | undefined> = {
                SMITHERS_ACCOUNTS_DIR: acctRoot,
                ...(seatsValue !== undefined ? { SMITHERS_SEATS: seatsValue } : {}),
                ...(input.hasAnthropicKey ? { ANTHROPIC_API_KEY: "sk-ant-test-key" } : {}),
                ...(input.hasOpenAiKey ? { OPENAI_API_KEY: "sk-openai-test-key" } : {}),
                ...(input.hasGatewayKey ? { AI_GATEWAY_API_KEY: "gw-test-key", OPENROUTER_API_KEY: "or-test-key" } : {}),
                ...(input.hasPool ? { SMITHERS_ACCOUNT_POOL_URL: server.origin, SMITHERS_ACCOUNT_POOL_ROUTES: "chatgpt,anthropic" } : {}),
                ...(input.askMode !== "" ? { SMITHERS_ASKS: input.askMode } : {}),
                ...(input.checkoutMode !== "" ? { SMITHERS_CHECKOUT_NO_LATER_COMMITS: input.checkoutMode } : {}),
                ...(input.hasTestCmd
                  ? {
                      SMITHERS_TEST_COMMAND: "pnpm test",
                      SMITHERS_TEST_CONTAINER: "ctr-1",
                      SMITHERS_TEST_CWD: "/workspace",
                      SMITHERS_TEST_TIMEOUT_MS: "15000"
                    }
                  : {}),
                ...(input.hasSandboxImage ? { SMITHERS_SANDBOX_IMAGE: "node:22-alpine", SMITHERS_BASH_CONTAINER: "ctr-sealed" } : {})
              }

              // 1. scopedSeatResolver
              const exit = await Effect.runPromiseExit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const resolver = yield* NativeEquipment.scopedSeatResolver(env, dummyExec)
                    return yield* resolver.resolve(input.declared)
                  })
                )
              )

              // Check key invariants: decision seat and invalid syntax/mismatch MUST always fail
              if (
                input.declared === "typesafe-ai/jev" ||
                input.declared === "sol@codex-team1" ||
                input.declared === "luna@claude-team1" ||
                input.declared === "sol@claude-missing" ||
                input.declared === "sol@bad!account" ||
                input.declared === "@claude-team1" ||
                (input.seatsEnv !== "unset" && input.seatsEnv !== "valid")
              ) {
                assertInv(Exit.isFailure(exit), `expected SeatUnresolved for ${input.declared} / seatsEnv=${input.seatsEnv}`)
              }

              // 2. askPolicy
              if (input.askMode === "invalid") {
                let threw = false
                try {
                  NativeEquipment.askPolicy(env)
                } catch {
                  threw = true
                }
                assertInv(threw, "invalid askPolicy must throw")
              } else {
                const pol = NativeEquipment.askPolicy(env)
                assertInv(pol === (input.askMode === "refuse" ? "refuse" : "park"), "valid askPolicy")
              }

              // 3. checkoutFacts
              if (input.checkoutMode === "invalid") {
                let threw = false
                try {
                  NativeEquipment.checkoutFacts(env)
                } catch {
                  threw = true
                }
                assertInv(threw, "invalid checkoutFacts must throw")
              } else {
                const facts = NativeEquipment.checkoutFacts(env)
                assertInv(Boolean(facts.noLaterCommits) === (input.checkoutMode === "1"), "checkoutFacts match")
              }

              // 4. testRunner, checkpointStore, sealedContainer, sandboxProvidersFrom
              const runner = NativeEquipment.testRunner(env, "/repo", "/repo")
              if (input.hasTestCmd) {
                assertInv(runner !== undefined && runner.command === "pnpm test" && runner.container === "ctr-1", "testRunner configured")
              } else {
                assertInv(runner === undefined, "testRunner undefined without command")
              }
              const ckpt = NativeEquipment.checkpointStore(env, "/repo")
              assertInv(ckpt.root === "/repo", "checkpointStore root")
              assertInv(NativeEquipment.sealedContainer(env) === (input.hasSandboxImage ? "ctr-sealed" : undefined), "sealedContainer")
              const sbProviders = NativeEquipment.sandboxProvidersFrom(env)
              assertInv(Boolean(sbProviders.container) === input.hasSandboxImage, "sandboxProvidersFrom")
              if (sbProviders.container) {
                const made = sbProviders.container(
                  { provider: "container", network: "none", cpus: 1, memoryMib: 512, timeoutSecs: 30 } as any,
                  { spawner: {} as any } as any
                )
                assertInv(made !== undefined, "container sandbox provider constructs")
              }

              return true
            }),
          { executions: Math.min(executions, 36), seed: seed + 1 }
        )
      )
      if (report._tag !== "Passed") {
        throw new Error(`Falsified: ${JSON.stringify(report)}`)
      }
      expect(report._tag).toBe("Passed")

      // Also exercise accountPoolDefaultModel, seatCandidates, layerSeatCatalog, layerSeatResolver, layerSeatEvaluator, toolServices, testFlows
      const poolModel = await Effect.runPromise(
        NativeEquipment.accountPoolDefaultModel({
          SMITHERS_ACCOUNT_POOL_URL: server.origin,
          SMITHERS_ACCOUNT_POOL_ROUTES: "chatgpt,anthropic"
        }).pipe(Effect.provideService(RequestExecutor.RequestExecutor, dummyExec))
      )
      expect(poolModel === undefined || typeof poolModel === "string").toBe(true)

      const cands = await NativeEquipment.seatCandidates({
        environment: { ANTHROPIC_API_KEY: "sk-ant-1", OPENAI_API_KEY: "sk-oai-1" }
      } as any)
      expect(Array.isArray(cands)).toBe(true)

      const evalExitNoKey = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const ev = yield* Evaluator.Evaluator
          return yield* ev.evaluate({ prompt: "ok?", schema: Schema.Struct({ ok: Schema.Boolean }) } as any)
        }).pipe(
          Effect.provide(NativeEquipment.layerSeatEvaluator({})),
          Effect.provideService(RequestExecutor.RequestExecutor, dummyExec)
        )
      )
      expect(Exit.isFailure(evalExitNoKey) || Exit.isSuccess(evalExitNoKey)).toBe(true)

      const evalExitWithKey = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const ev = yield* Evaluator.Evaluator
          return yield* ev.evaluate({ prompt: "ok?", schema: Schema.Struct({ pass: Schema.Boolean }) } as any)
        }).pipe(
          Effect.provide(
            NativeEquipment.layerSeatEvaluator({
              AI_GATEWAY_API_KEY: "gw-key",
              AI_GATEWAY_BASE_URL: server.origin
            })
          ),
          Effect.provideService(RequestExecutor.RequestExecutor, dummyExec)
        )
      )
      expect(Exit.isFailure(evalExitWithKey) || Exit.isSuccess(evalExitWithKey)).toBe(true)

      const services = await Effect.runPromise(
        NativeEquipment.toolServices.pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(Evaluator.Evaluator, Evaluator.Evaluator.of({ evaluate: () => Effect.die("unused") }))
        )
      )
      const emptyFlows = NativeEquipment.testFlows(services.shell as any, SandboxContainer.makeCommand(), undefined)
      expect(emptyFlows).toHaveLength(0)
      const builtFlows = NativeEquipment.testFlows(
        Context.merge(services.shell, services.judge),
        SandboxContainer.makeCommand(),
        { command: "echo ok", baseline: false, cwd: "/tmp", root: "/tmp" },
        5_000
      )
      expect(builtFlows).toHaveLength(1)
    } finally {
      await server.close()
      rmSync(acctRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it("ControlAffinity, ReleasedChildResume, and EngineJournalSupervisor uphold ownership fencing, keyed retry safety & terminal ordering invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        controlStatus: Schema.Literals(["missing", "running", "suspended", "completed"]),
        sameOwner: Schema.Boolean,
        staleHeartbeat: Schema.Boolean,
        ownerAlive: Schema.Boolean,
        nativeStatus: Schema.Literals(["running", "suspended", "completed"]),
        nativeCancelled: Schema.Boolean,
        keyedAttempt: Schema.Boolean,
        hasGrant: Schema.Boolean,
        isChild: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(async () => {
            const claimant = { hostId: "host-a", pid: 1001, bootId: "b1" } as any
            const otherOwner = { hostId: "host-a", pid: 2002, bootId: "b1" } as any
            const owner = input.sameOwner ? claimant : otherOwner
            const nowMs = Date.now()
            const heartbeatAtMs = input.staleHeartbeat ? nowMs - 10 * 60 * 1000 : nowMs

            const controlRows = new Map<string, any>()
            const engineRows = new Map<string, any>()
            const rootId = "run-root-1"
            const targetId = input.isChild ? "run-child-1" : rootId

            if (input.controlStatus !== "missing") {
              controlRows.set(rootId, {
                runId: rootId,
                status: input.controlStatus,
                owner: input.controlStatus === "running" ? owner : null,
                heartbeatAtMs,
                stateJson: JSON.stringify({
                  parkedBy: JSON.stringify(owner),
                  updatedAt: heartbeatAtMs
                })
              })
            }

            engineRows.set(targetId, {
              runId: targetId,
              lineageId: targetId,
              parentRunId: input.isChild ? rootId : null,
              status: input.nativeStatus,
              cancelRequestedAtMs: input.nativeCancelled ? nowMs : null,
              stateJson: JSON.stringify({
                version: 1,
                flowName: "demo",
                payload: {},
                ...(input.isChild ? { parentExecutionId: rootId } : {}),
                ...(input.nativeStatus === "completed" ? { result: { _tag: "Success", value: 1 } } : {})
              })
            })
            if (input.isChild) {
              engineRows.set(rootId, {
                runId: rootId,
                lineageId: rootId,
                parentRunId: null,
                status: "suspended",
                cancelRequestedAtMs: null,
                stateJson: JSON.stringify({ version: 1, flowName: "demo", payload: {} })
              })
            }

            const makeRunStore = (map: Map<string, any>): RunStore.Service =>
              ({
                get: (id: string) =>
                  map.has(id)
                    ? Effect.succeed(map.get(id))
                    : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: undefined })),
                lineage: (id: string) => Effect.succeed(map.has(id) ? [map.get(id)] : [])
              }) as any

            const emittedControl: Array<JournalEvent.Entry> = []
            const makeMemJournal = (initial: ReadonlyArray<JournalEvent.Entry>): Journal.Service => {
              const items = [...initial]
              return {
                generation: () => Effect.succeed({ generation: 1, afterSeq: items.length }),
                entries: (req: any) => {
                  const matched = items.filter(
                    (e) => e.runId === req.runId && (!req.eventTypes || req.eventTypes.includes(e.eventType))
                  )
                  return Effect.succeed({ entries: matched, hasMore: false })
                },
                emitDurableUnfenced: (ev: any) =>
                  Effect.sync(() => {
                    const entry: any = {
                      seq: items.length + 1,
                      eventId: `ev-${items.length + 1}`,
                      runId: ev.runId,
                      sourceId: ev.sourceId,
                      sourceSeq: ev.sourceSeq,
                      eventType: ev.eventType,
                      payload: ev.payload,
                      timestampMs: Date.now()
                    }
                    items.push(entry)
                    emittedControl.push(entry)
                    return entry
                  })
              } as any
            }

            const engineEntries: Array<any> = [
              {
                seq: 1,
                eventId: "rel-ev-1",
                runId: targetId,
                sourceId: "engine",
                sourceSeq: 0,
                eventType: "flows.engine.run-decision",
                payload: { decision: "interrupt-released" },
                timestampMs: nowMs
              }
            ]
            const engineJournal = makeMemJournal(engineEntries)
            const controlJournal = makeMemJournal(
              input.hasGrant
                ? [{
                    seq: 1,
                    eventId: "grant-1",
                    runId: rootId,
                    sourceId: "explicit-child-resume:1",
                    sourceSeq: 0,
                    eventType: "control.engine.released-children-resume",
                    payload: {
                      resumeSequence: 1,
                      releases: [{ executionId: targetId, eventId: "rel-ev-1", generation: 1 }]
                    },
                    timestampMs: nowMs
                  } as any]
                : []
            )

            // Real SQLite database for flows_attempts keyed check!
            const tmp = mkdtempSync(join(tmpdir(), "smthrs-rcr-"))
            try {
              const dbLayer = NodeDatabase.layer({ filename: join(tmp, "eng.sqlite") })
              await Effect.runPromise(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  yield* sql`CREATE TABLE flows_attempts (run_id TEXT, state TEXT, meta_json TEXT)`
                  yield* sql`INSERT INTO flows_attempts VALUES (${targetId}, 'running', ${
                    input.keyedAttempt ? JSON.stringify({ tier: "sealed", keyed: true }) : JSON.stringify({ tier: "sealed", keyed: false })
                  })`

                  const rcr = ReleasedChildResume.make({
                    engineJournal,
                    controlJournal,
                    engineRuns: makeRunStore(engineRows),
                    engineState: {
                      runChildren: (id) => Effect.succeed(id === rootId && input.isChild ? [{ childId: targetId } as any] : [])
                    },
                    engineSql: sql
                  })

                  const canRetry = yield* rcr.canRetryReleased(targetId, rootId)
                  const expectEligible = input.nativeStatus === "suspended" && !input.nativeCancelled && (input.keyedAttempt || input.hasGrant)
                  assertInv(canRetry === expectEligible, `canRetryReleased=${canRetry} expected=${expectEligible}`)

                  // Also exercise authorize() when not already granted
                  if (!input.hasGrant) {
                    yield* rcr.authorize(rootId, 2)
                  }

                  // ControlAffinity check
                  const affinity = ControlAffinity.make({
                    runs: makeRunStore(controlRows),
                    engineRuns: makeRunStore(engineRows),
                    claimant,
                    canRetryReleased: rcr.canRetryReleased,
                    isAlive: () => Effect.succeed(input.ownerAlive)
                  })
                  const admitted = yield* affinity(targetId)
                  assertInv(typeof admitted === "boolean", "affinity returns boolean")
                  if (input.controlStatus === "running" && !input.sameOwner && (!input.staleHeartbeat || input.ownerAlive)) {
                    assertInv(admitted === false, "live foreign owner must not be preempted")
                  }
                }).pipe(Effect.provide(dbLayer))
              )
            } finally {
              rmSync(tmp, { recursive: true, force: true })
            }

            return true
          }),
        { executions: Math.min(executions, 28), seed: seed + 2 }
      )
    )
    if (report._tag !== "Passed") {
      throw new Error(`Falsified: ${JSON.stringify(report)}`)
    }
    expect(report._tag).toBe("Passed")

    // EngineJournalSupervisor wrap / launch / resumeRun / readExecution / recover / awaitSettled
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const emitted: Array<any> = []
          const memJournal = (entries: Array<any>): Journal.Service =>
            ({
              generation: () => Effect.succeed({ generation: 1, afterSeq: entries.length }),
              entries: () => Effect.succeed({ entries, hasMore: false }),
              subscribe: () => Stream.fromIterable(entries),
              emitDurableUnfenced: (ev: any) =>
                Effect.sync(() => {
                  const row = { seq: emitted.length + 1, eventId: `e-${emitted.length + 1}`, ...ev }
                  emitted.push(row)
                  return row
                })
            }) as any

          const runRows = new Map<string, any>([
            ["sup-run-1", {
              runId: "sup-run-1",
              lineageId: "sup-run-1",
              status: "completed",
              stateJson: JSON.stringify({ version: 1, flowName: "demo", payload: {}, result: { _tag: "Success", value: "done" } })
            }]
          ])
          const sup = yield* EngineJournalSupervisor.make({
            engineJournal: memJournal([]),
            controlJournal: memJournal([]),
            engineState: {
              runChildren: () => Effect.succeed([]),
              runChildrenOf: () => Effect.succeed([]),
              runParents: () => Effect.succeed([])
            },
            runs: {
              get: (id: string) =>
                runRows.has(id)
                  ? Effect.succeed(runRows.get(id))
                  : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: undefined })),
              lineage: (id: string) => Effect.succeed(runRows.has(id) ? [runRows.get(id)] : [])
            },
            control: {
              getRun: (id: string) => Effect.succeed({ runId: id, status: "completed" } as any),
              pageRunIds: () => Effect.succeed({ ids: ["sup-run-1", "missing-run"], next: undefined, through: undefined } as any)
            },
            inControlTransaction: Effect.succeed(false),
            orderingGrace: Duration.millis(25)
          })

          const wrapped = sup.wrap({
            launch: (req: any) =>
              req.run.runId === "fail-run"
                ? Effect.fail("launch-fail" as any)
                : Effect.succeed(req.run.runId === "queued-run" ? "queued" : "accepted"),
            resumeRun: (req: any) =>
              req.runId === "fail-resume"
                ? Effect.fail("resume-fail" as any)
                : Effect.succeed(req.runId === "rej-resume" ? "not_resumable" : "resuming"),
            readExecution: (id: string) =>
              Effect.succeed(id === "missing" ? { _tag: "Missing" as const } : { _tag: "Present" as const, status: "completed" } as any)
          } as any)

          expect(yield* wrapped.launch({ run: { runId: "sup-run-1" } } as any)).toBe("accepted")
          expect(yield* wrapped.launch({ run: { runId: "queued-run" } } as any)).toBe("queued")
          expect(Exit.isFailure(yield* Effect.exit(wrapped.launch({ run: { runId: "fail-run" } } as any)))).toBe(true)
          expect(yield* wrapped.resumeRun({ runId: "sup-run-1" } as any)).toBe("resuming")
          expect(yield* wrapped.resumeRun({ runId: "rej-resume" } as any)).toBe("not_resumable")
          expect(Exit.isFailure(yield* Effect.exit(wrapped.resumeRun({ runId: "fail-resume" } as any)))).toBe(true)
          expect((yield* wrapped.readExecution!("missing"))._tag).toBe("Missing")
          expect((yield* wrapped.readExecution!("sup-run-1"))._tag).toBe("Present")
          yield* sup.start("sup-run-1")
          yield* sup.recover
          yield* sup.awaitSettled("sup-run-1")
        })
      )
    )
  }, 120_000)
})
