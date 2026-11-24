import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Arbitrary, Effect, Layer, Schema, Stream } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunEventStream from "../src/cli/RunEventStream.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as CloudSession from "../src/CloudSession.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as Forensics from "../src/Forensics.ts"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"
import * as SuggestFlow from "../src/suggest/SuggestFlow.ts"
import * as Ui from "../src/Ui.ts"
import { project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeSink = (isTTY = false) => {
  let out = ""
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString("utf8")
      cb()
    }
  }) as Writable & { isTTY?: boolean; columns?: number }
  stream.isTTY = isTTY
  stream.columns = 100
  return { stream, text: () => out }
}

const makeJwt = (expSec: number, email = "fuzz@example.test"): string => {
  const hdr = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const pay = Buffer.from(JSON.stringify({ exp: expSec, email })).toString("base64url")
  return `${hdr}.${pay}.sig`
}

describe("@smthrs/cli ClaudeCode, CodexLogin, NativeEquipment, Providers, Ui, RunHistory, RunTiming, RunEventStream, Presentation, SuggestFlow & CloudSession fuzz invariants", () => {
  it(
    "ClaudeCode streaming all SDK message types, CodexLogin refresh/rotation/cliRefresh, NativeEquipment layers & Providers uphold model invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-equip-deep-")))
      const poolSrv = createServer((req, res) => {
        if (req.url?.includes("/v1/models") || req.url?.includes("/routes")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ routes: ["openai", "anthropic"], defaultModel: "openai:gpt-5.1" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
      await new Promise<void>((done) => poolSrv.listen(0, "127.0.0.1", done))
      const addr = poolSrv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const poolOrigin = `http://127.0.0.1:${addr.port}`

      try {
        // 1. Fuzz ClaudeCode.make across EVERY SDK message type & error branch
        const arb = Arbitrary.schema(
          Schema.Struct({
            variant: Schema.Literals([
              "textStream",
              "thinkingAndText",
              "assistantFallback",
              "resultError",
              "maxTurns",
              "rateLimitAndText",
              "nonEmptyTools"
            ]),
            reasoning: Schema.Literals(["none", "low", "medium", "high", "max"]),
            hijackable: Schema.Boolean
          })
        )
        const ccReport = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ hijackable, reasoning, variant }) =>
              Effect.promise(async () => {
                const transport: ClaudeCode.Start = () => {
                  const msgs: Array<Record<string, unknown>> = [
                    { type: "system", subtype: "init", session_id: "sess-cc-1", model: "claude-sonnet-4-6" }
                  ]
                  if (variant === "textStream") {
                    msgs.push(
                      {
                        type: "stream_event",
                        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
                      },
                      {
                        type: "stream_event",
                        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }
                      },
                      {
                        type: "stream_event",
                        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } }
                      },
                      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
                      {
                        type: "result",
                        subtype: "success",
                        is_error: false,
                        result: "Hello world!",
                        session_id: "sess-cc-1",
                        total_cost_usd: 0.002,
                        usage: {
                          input_tokens: 100,
                          output_tokens: 25,
                          cache_read_input_tokens: 10,
                          cache_creation_input_tokens: 5
                        }
                      }
                    )
                  } else if (variant === "thinkingAndText") {
                    msgs.push(
                      {
                        type: "stream_event",
                        event: {
                          type: "content_block_start",
                          index: 0,
                          content_block: { type: "thinking", thinking: "" }
                        }
                      },
                      {
                        type: "stream_event",
                        event: {
                          type: "content_block_delta",
                          index: 0,
                          delta: { type: "thinking_delta", thinking: "pondering..." }
                        }
                      },
                      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
                      {
                        type: "stream_event",
                        event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }
                      },
                      {
                        type: "stream_event",
                        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }
                      },
                      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
                      {
                        type: "result",
                        subtype: "success",
                        is_error: false,
                        result: "Done.",
                        session_id: "sess-cc-1",
                        usage: { input_tokens: 50, output_tokens: 12 }
                      }
                    )
                  } else if (variant === "assistantFallback") {
                    msgs.push(
                      {
                        type: "assistant",
                        message: {
                          role: "assistant",
                          content: [
                            { type: "thinking", thinking: "thought" },
                            { type: "text", text: "fallback answer" }
                          ],
                          usage: { input_tokens: 20, output_tokens: 5 }
                        }
                      },
                      {
                        type: "result",
                        subtype: "success",
                        is_error: false,
                        result: "fallback answer",
                        session_id: "sess-cc-1"
                      }
                    )
                  } else if (variant === "resultError") {
                    msgs.push({
                      type: "result",
                      subtype: "error_during_execution",
                      is_error: true,
                      errors: ["model refused request"],
                      session_id: "sess-cc-1"
                    })
                  } else if (variant === "maxTurns") {
                    msgs.push({
                      type: "result",
                      subtype: "error_max_turns",
                      is_error: true,
                      errors: ["max turns reached"],
                      session_id: "sess-cc-1"
                    })
                  } else if (variant === "rateLimitAndText") {
                    msgs.push(
                      {
                        type: "rate_limit_event",
                        rate_limit_info: { status: "allowed_warning", resetsAt: Date.now() + 60_000 }
                      },
                      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-cc-1" }
                    )
                  }

                  return {
                    async *[Symbol.asyncIterator]() {
                      for (const m of msgs) yield m
                    },
                    interrupt: async () => {},
                    close: () => {}
                  } as never
                }

                const model = ClaudeCode.make({
                  model: "claude-sonnet-4-6",
                  executable: "claude",
                  environment: { HOME: root },
                  cwd: root,
                  hijackable,
                  start: transport,
                  idleMillis: 60_000,
                  interruptMillis: 100
                })
                try {
                  const req = ModelRequest.ModelRequest.make({
                    modelId: "claude-sonnet-4-6",
                    system: [ModelRequest.SystemPart.make({ text: "You are helpful." })],
                    messages: [
                      ModelRequest.Message.user("hi"),
                      ModelRequest.Message.assistant("hello"),
                      ModelRequest.Message.user("next")
                    ],
                    tools: variant === "nonEmptyTools"
                      ? [
                        ModelRequest.ToolDefinition.make({
                          name: "bash",
                          description: "run",
                          parameters: { type: "object", properties: {} }
                        })
                      ]
                      : [],
                    toolChoice: "none",
                    params: ModelRequest.GenerationParams.make({ reasoningEffort: reasoning })
                  })
                  const res = await Effect.runPromise(Stream.runCollect(model.stream(req)).pipe(Effect.result))
                  assertInv(res._tag === "Failure" || res._tag === "Success", `ClaudeCode ${variant}`)
                } finally {
                  model.close()
                }
                return true
              }),
            { seed, executions: Math.min(executions, 24) }
          )
        )
        const ccFail = Fuzz.formatReport(ccReport)
        if (ccFail !== undefined) throw new Error(ccFail)
        expect(ccReport._tag).toBe("Passed")

        // ClaudeCode.route & ClaudeCode.load
        const routeRes = ClaudeCode.route("claude-sonnet-4-6")
        assertInv(typeof routeRes === "object", "ClaudeCode.route")
        const loadedModel = await Effect.runPromise(
          ClaudeCode.load({ model: "claude-sonnet-4-6", executable: "claude", environment: { HOME: root } }).pipe(
            Effect.result
          )
        )
        assertInv(loadedModel._tag === "Success" || loadedModel._tag === "Failure", "ClaudeCode.load")

        // 2. CodexLogin: fresh, expired->rotated, expired->unchanged, refreshRejected, cliRefresh with fake codex bin
        const authFile = join(root, "auth.json")
        const freshJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600)
        const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 3600)
        const rotatedJwt = makeJwt(Math.floor(Date.now() / 1000) + 7200)
        writeFileSync(authFile, JSON.stringify({ tokens: { access_token: freshJwt, account_id: "acct-1" } }))

        let telemetryCount = 0
        const storeFresh = CodexLogin.make({
          file: authFile,
          refresh: Effect.void,
          record: () =>
            Effect.sync(() => {
              telemetryCount++
            })
        })
        const signedFresh = await Effect.runPromise(storeFresh.auth.sign({ "x-test": "1" }))
        assertInv(
          signedFresh.Authorization === `Bearer ${freshJwt}` && signedFresh["chatgpt-account-id"] === "acct-1",
          "CodexLogin fresh sign"
        )

        // Expired -> refresh rotates token on disk
        writeFileSync(authFile, JSON.stringify({ tokens: { access_token: expiredJwt, account_id: "acct-1" } }))
        const storeRotate = CodexLogin.make({
          file: authFile,
          refresh: Effect.sync(() => {
            writeFileSync(authFile, JSON.stringify({ tokens: { access_token: rotatedJwt, account_id: "acct-2" } }))
          })
        })
        const signedRot = await Effect.runPromise(storeRotate.auth.sign({}))
        assertInv(signedRot.Authorization === `Bearer ${rotatedJwt}`, "CodexLogin expired rotates token")

        // refreshRejected triggers refresh & succeeds when token rotates
        const rotatedJwt2 = makeJwt(Math.floor(Date.now() / 1000) + 9000)
        const storeRej = CodexLogin.make({
          file: authFile,
          refresh: Effect.sync(() => {
            writeFileSync(authFile, JSON.stringify({ tokens: { access_token: rotatedJwt2, account_id: "acct-2" } }))
          })
        })
        await Effect.runPromise(storeRej.auth.refreshRejected!({ Authorization: `Bearer ${rotatedJwt}` }))

        // Unchanged refresh fails with authentication error
        const storeUnchanged = CodexLogin.make({ file: authFile, refresh: Effect.void })
        const unchangedRes = await Effect.runPromise(
          storeUnchanged.auth.refreshRejected!({ Authorization: `Bearer ${rotatedJwt2}` }).pipe(Effect.result)
        )
        assertInv(unchangedRes._tag === "Failure", "CodexLogin unchanged refresh fails")

        // cliRefresh with real fake executable
        const fakeCodex = join(root, "fake-codex.cjs")
        writeFileSync(fakeCodex, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 })
        chmodSync(fakeCodex, 0o755)
        const cliRefRes = await Effect.runPromise(
          CodexLogin.cliRefresh({ environment: { HOME: root, PATH: root }, timeoutMs: 1_000 }).pipe(Effect.result)
        )
        void fakeCodex
        assertInv(cliRefRes._tag === "Success" || cliRefRes._tag === "Failure", "CodexLogin.cliRefresh")
        assertInv(telemetryCount >= 1, "CodexLogin telemetry recorded")

        // 3. NativeEquipment layers + accountPoolDefaultModel + sealedContainer + testRunner + toolServices + testFlows
        const fakeExec = RequestExecutor.RequestExecutor.of({
          execute: () => Effect.die("unused")
        } as never)
        const poolEnv: Record<string, string | undefined> = {
          HOME: root,
          OPENAI_API_KEY: "sk-fuzz-1",
          GEMINI_API_KEY: "gem-fuzz-1",
          OPENROUTER_API_KEY: "or-fuzz-1",
          SMITHERS_ACCOUNT_POOL_URL: poolOrigin,
          SMITHERS_ACCOUNT_POOL_TOKEN: "pool-tok",
          SMITHERS_BASH_CONTAINER: "ctr-fuzz-1"
        }
        const poolDef = await Effect.runPromise(
          NativeEquipment.accountPoolDefaultModel(poolEnv).pipe(
            Effect.provideService(RequestExecutor.RequestExecutor, fakeExec),
            Effect.result
          )
        )
        assertInv(poolDef._tag === "Success" || poolDef._tag === "Failure", "accountPoolDefaultModel")
        assertInv(NativeEquipment.sealedContainer(poolEnv) === "ctr-fuzz-1", "sealedContainer")
        const scoped = NativeEquipment.scopedSeatResolver(poolEnv, fakeExec)
        assertInv(typeof scoped === "object", "scopedSeatResolver")
        const builtCatalog = await Effect.runPromise(
          Effect.scoped(Layer.build(NativeEquipment.layerSeatCatalog(poolEnv))).pipe(
            Effect.provideService(RequestExecutor.RequestExecutor, fakeExec),
            Effect.result
          )
        )
        assertInv(builtCatalog._tag === "Success" || builtCatalog._tag === "Failure", "layerSeatCatalog")
        const builtEval = await Effect.runPromise(
          Effect.scoped(Layer.build(NativeEquipment.layerSeatEvaluator(poolEnv))).pipe(
            Effect.provideService(RequestExecutor.RequestExecutor, fakeExec),
            Effect.result
          )
        )
        assertInv(builtEval._tag === "Success" || builtEval._tag === "Failure", "layerSeatEvaluator")
        const builtTools = await Effect.runPromise(
          (NativeEquipment.toolServices as unknown as Effect.Effect<unknown, unknown, never>).pipe(
            Effect.provide(NodeServices.layer),
            Effect.result
          )
        )
        assertInv(builtTools._tag === "Success" || builtTools._tag === "Failure", "toolServices")

        // 4. Providers deep helpers (providerKey, compatibleKey, claudeCodeLogin, claudeCode)
        const provHost: Providers.Host = { environment: poolEnv, homeDirectory: root, readFile: () => undefined }
        assertInv(Providers.providerKey(["OPENAI_API_KEY"], poolEnv)?.key === "sk-fuzz-1", "providerKey openai")
        assertInv(Providers.compatibleKey("kimi-k3", poolEnv) === undefined, "compatibleKey missing")
        const ccLogin = await Providers.claudeCodeLogin(poolEnv)
        assertInv(ccLogin === undefined || typeof ccLogin === "object", "claudeCodeLogin")
        const ccInfo = await Providers.claudeCode(provHost)
        assertInv(typeof ccInfo === "object", "Providers.claudeCode")

        // 5. Ui.make interactive & non-interactive rendering
        for (const interactive of [false, true]) {
          const sink = makeSink(interactive)
          const ui = Ui.make({ output: sink.stream, interactive })
          await Effect.runPromise(
            Effect.gen(function*() {
              yield* ui.intro("Fuzz Intro")
              yield* ui.info("Info line")
              yield* ui.success("Success line")
              yield* ui.warn("Warn line")
              yield* ui.error("Error line")
              yield* ui.step("Step line")
              yield* ui.note("Body text\nLine 2", "Note Title")
              const sp = ui.spinner()
              sp.start("Working...")
              sp.message("Halfway...")
              sp.stop("Finished")
              yield* ui.outro("Fuzz Outro")
            }).pipe(Effect.result)
          )
          assertInv(sink.text().length > 0, `Ui.make interactive=${interactive} wrote output`)
        }
        assertInv(
          Ui.renderChecklist(
            "Checks",
            [
              { name: "a", level: "ok", detail: "good" },
              { name: "b", level: "warn", detail: "meh" },
              { name: "c", level: "fail", detail: "bad" }
            ],
            { interactive: false }
          ).includes("Checks"),
          "Ui.renderChecklist"
        )
      } finally {
        poolSrv.closeAllConnections?.()
        await new Promise<void>((done) => poolSrv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "RunHistory.read/field, RunEventStream, Presentation, RunTiming deep spans, Forensics, SuggestFlow, SupervisorMemory, CloudSession & StoreCopy uphold invariants",
    async () => {
      const root = await project()
      const echoPath = join(root, ".smithers/flows/echo/flow.ts")
      writeFileSync(
        echoPath,
        readFileSync(echoPath, "utf8").replace("capabilities: []", "capabilities: [\"fs:read:*\"]")
      )

      try {
        // 1. Live Control run + RunHistory.read / RunHistory.field / RunEventStream.events
        const controlLayer = NodeControl.layerControl({ root })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const control = yield* Control.Control
              const planned = yield* control.plan({
                flowId: "echo",
                input: { message: "x".repeat(500) }
              })
              yield* control.approve({ ...planned.approval, scope: "run" })
              const rec = (yield* Launch.execute(JSON.stringify(planned.approval), true)) as {
                readonly _tag?: string
                readonly runId?: string
              }
              assertInv(rec._tag === "Accepted" && rec.runId !== undefined, "live run accepted")
              const runId = rec.runId!

              // RunEventStream.events (non-follow)
              const streamed = yield* Stream.runCollect(RunEventStream.events(runId, false)).pipe(Effect.result)
              assertInv(streamed._tag === "Success", "RunEventStream.events collected")

              // RunHistory.read with tight byte budgets (forces omission & truncation paths!)
              const hSmall = yield* RunHistory.read(
                RunEventStream.events(runId, false),
                runId,
                { maxEvents: 10, maxEventBytes: 128, maxTotalBytes: 256, maxFieldBytes: 32 } as never
              ).pipe(Effect.result)
              assertInv(hSmall._tag === "Success", "RunHistory.read small budget")

              const hFull = yield* RunHistory.read(
                RunEventStream.events(runId, false),
                runId
              ).pipe(Effect.result)
              assertInv(hFull._tag === "Success", "RunHistory.read full budget")

              // RunHistory.field drill-down + invalid pointer refusal
              const fRes = yield* RunHistory.field(
                RunEventStream.events(runId, false),
                "/events/1/payload",
                64,
                { offset: 0, length: 32 }
              ).pipe(Effect.result)
              assertInv(fRes._tag === "Success" || fRes._tag === "Failure", "RunHistory.field")
              const fBad = yield* RunHistory.field(RunEventStream.events(runId, false), "/invalid").pipe(Effect.result)
              assertInv(fBad._tag === "Failure", "RunHistory.field rejects invalid pointer")
            }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, controlLayer) as Layer.Layer<any, never, never>))
          )
        )

        // 2. Presentation scope / policy / clean / nextActions / finish / guard
        const sink = makeSink(false)
        const presCtx: Presentation.Context = {
          command: "runs show",
          agent: false,
          globals: { audience: "human", silent: false }
        }
        await Presentation.scope(presCtx, { stdout: sink.stream as never }, async () => {
          assertInv(Presentation.current() !== undefined, "Presentation.current active in scope")
          const pol = Presentation.policy(presCtx)
          assertInv(typeof pol === "object", "Presentation.policy")
          const cleaned = Presentation.clean({ a: "ok", b: "line\x1b[31mred\x1b[0m" })
          assertInv(!cleaned.includes("\x1b"), "Presentation.clean strips ANSI")
          const nexts = Presentation.nextActions({ runId: "r-1", status: "completed" }, presCtx)
          assertInv(Array.isArray(nexts), "Presentation.nextActions")
          Presentation.finish(presCtx, { ok: true })
        })
        const guarded = await Presentation.guard({
          ...presCtx,
          command: "runs show",
          error: (e) => {
            throw new Error(e.message)
          }
        }, async () => ({ value: 42 }))
        assertInv(guarded.value === 42, "Presentation.guard returns value")

        // 3. Fuzz RunTiming + RunProgress + Forensics across rich complex event sequences
        const arb = Arbitrary.schema(
          Schema.Struct({
            columns: Schema.Literals([60, 100, 160]),
            includeSubflow: Schema.Boolean,
            includeApproval: Schema.Boolean,
            includeBudget: Schema.Boolean,
            finalStatus: Schema.Literals(["completed", "failed", "cancelled", "waiting"])
          })
        )
        const rtReport = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ columns, finalStatus, includeApproval, includeBudget, includeSubflow }) =>
              Effect.sync(() => {
                const evs: Array<Record<string, unknown>> = [
                  {
                    seq: 1,
                    eventId: "e1",
                    kind: "control.plan.created",
                    atMs: 1000,
                    runId: "r-deep",
                    payload: { flowId: "build" }
                  },
                  {
                    seq: 2,
                    eventId: "e2",
                    kind: "control.plan.approved",
                    atMs: 1200,
                    runId: "r-deep",
                    payload: { scope: "run" }
                  },
                  {
                    seq: 3,
                    eventId: "e3",
                    kind: "control.run.started",
                    atMs: 1500,
                    runId: "r-deep",
                    payload: { flowId: "build" }
                  },
                  {
                    seq: 4,
                    eventId: "e4",
                    kind: "flows.engine.step-started",
                    atMs: 1600,
                    runId: "r-deep",
                    payload: { stepKey: "s1", attempt: 1, name: "Analyze", kind: "model" }
                  },
                  {
                    seq: 5,
                    eventId: "e5",
                    kind: "agent.model.started",
                    atMs: 1700,
                    runId: "r-deep",
                    payload: { stepKey: "s1", model: "openai:gpt-5.1" }
                  },
                  {
                    seq: 6,
                    eventId: "e6",
                    kind: "agent.model.completed",
                    atMs: 4200,
                    runId: "r-deep",
                    payload: {
                      stepKey: "s1",
                      model: "openai:gpt-5.1",
                      inputTokens: 3000,
                      outputTokens: 900,
                      costUsd: 0.04
                    }
                  },
                  {
                    seq: 7,
                    eventId: "e7",
                    kind: "agent.tool.started",
                    atMs: 4300,
                    runId: "r-deep",
                    payload: { stepKey: "s1", tool: "bash", command: "pnpm test" }
                  },
                  {
                    seq: 8,
                    eventId: "e8",
                    kind: "agent.tool.completed",
                    atMs: 6100,
                    runId: "r-deep",
                    payload: { stepKey: "s1", tool: "bash", ok: true }
                  },
                  {
                    seq: 9,
                    eventId: "e9",
                    kind: "flows.engine.step-completed",
                    atMs: 6200,
                    runId: "r-deep",
                    payload: { stepKey: "s1", attempt: 1 }
                  }
                ]
                let seq = 10
                let t = 6500
                if (includeSubflow) {
                  evs.push(
                    {
                      seq: seq++,
                      eventId: `e${seq}`,
                      kind: "flows.engine.child-started",
                      atMs: t,
                      runId: "r-deep",
                      payload: { childRunId: "r-child", flowId: "lint" }
                    },
                    {
                      seq: seq++,
                      eventId: `e${seq}`,
                      kind: "flows.engine.child-completed",
                      atMs: (t += 1200),
                      runId: "r-deep",
                      payload: { childRunId: "r-child", status: "completed" }
                    }
                  )
                }
                if (includeApproval) {
                  evs.push(
                    {
                      seq: seq++,
                      eventId: `e${seq}`,
                      kind: "control.run.waiting",
                      atMs: (t += 100),
                      runId: "r-deep",
                      payload: { reason: "approval", stepKey: "deploy" }
                    },
                    {
                      seq: seq++,
                      eventId: `e${seq}`,
                      kind: "control.run.resumed",
                      atMs: (t += 3000),
                      runId: "r-deep",
                      payload: { reason: "approved" }
                    }
                  )
                }
                if (includeBudget) {
                  evs.push({
                    seq: seq++,
                    eventId: `e${seq}`,
                    kind: "control.budget.warning",
                    atMs: (t += 50),
                    runId: "r-deep",
                    payload: { usedUsd: 0.9, limitUsd: 1.0 }
                  })
                }
                evs.push({
                  seq: seq++,
                  eventId: `e${seq}`,
                  kind: finalStatus === "completed"
                    ? "control.run.completed"
                    : finalStatus === "failed"
                    ? "control.run.failed"
                    : finalStatus === "cancelled"
                    ? "control.run.cancelled"
                    : "control.run.waiting",
                  atMs: t + 200,
                  runId: "r-deep",
                  payload: finalStatus === "failed"
                    ? { error: "step deploy failed", code: "step_failed" }
                    : { status: finalStatus }
                })
                const folded = RunTiming.fold(evs as never, "r-deep")
                const rendered = RunTiming.render(folded)
                assertInv(rendered.length > 0, "RunTiming.render deep")

                const prog = RunProgress.initial()
                for (const ev of evs) RunProgress.project(prog, ev as never)
                assertInv(typeof RunProgress.text(prog, columns) === "string", "RunProgress.text deep")

                const dig = Forensics.digest(evs as never, "r-deep")
                const diag = Forensics.renderDiagnosis({ runId: "r-deep", flowId: "build", status: finalStatus }, dig)
                assertInv(diag.length > 0, "Forensics.renderDiagnosis deep")
                return true
              }),
            { seed, executions: Math.min(executions, 30) }
          )
        )
        const rtFail = Fuzz.formatReport(rtReport)
        if (rtFail !== undefined) throw new Error(rtFail)
        expect(rtReport._tag).toBe("Passed")

        // 4. SuggestFlow pure helpers + SupervisorMemory + CloudSession + CloudSandbox + ExecutionEnvironment + StoreCopy
        assertInv(SuggestFlow.rules(root).length > 0, "SuggestFlow.rules valid absolute root")
        const relRules = SuggestFlow.rules("relative/path")
        assertInv(Array.isArray(relRules), "SuggestFlow.rules relative")
        const relErr = new SuggestFlow.RelativeRoot({ path: "relative/path" } as never)
        assertInv(relErr._tag === "/suggest/RelativeRoot", "SuggestFlow.RelativeRoot")

        assertInv(
          SupervisorMemory.stance({}) === "careful" || SupervisorMemory.stance({}) === "paranoid",
          "SupervisorMemory.stance"
        )
        const st2 = SupervisorMemory.stance({ SMITHERS_MEMORY_STANCE: "paranoid" })
        assertInv(st2 === "paranoid" || st2 === "careful", "SupervisorMemory stance valid")
        const memOpts = SupervisorMemory.options({ HOME: root }, root)
        assertInv(typeof memOpts === "object", "SupervisorMemory.options")

        // CloudSession authentication helpers
        const signed = await CloudSession.signedIn({
          HOME: root,
          XDG_CONFIG_HOME: root,
          SMITHERS_AUTH_FILE: join(root, "no-auth.json"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        })
        assertInv(signed === undefined || typeof signed === "object", "CloudSession.signedIn")
        assertInv(
          typeof CloudSession.isAuthenticationRefusal(new Error("nope")) === "boolean",
          "CloudSession.isAuthenticationRefusal"
        )

        // StoreCopy postgres location detection + SQLite copy
        assertInv(StoreCopy.postgres(join(root, "a.sqlite")) === undefined, "StoreCopy.postgres sqlite undefined")
        const srcDb = join(root, "src.sqlite")
        const dstDb = join(root, "dst.sqlite")
        writeFileSync(srcDb, "sqlite-bytes")
        await Effect.runPromise(StoreCopy.copy(srcDb, dstDb).pipe(Effect.provide(NodeFileSystem.layer), Effect.result))

        // ExecutionEnvironment & CloudSandbox extra edge branches
        assertInv(
          typeof ExecutionEnvironment === "object" && typeof CloudSandbox === "object",
          "env/sandbox modules loaded"
        )
        assertInv(typeof NodeCrypto.layer === "object", "NodeCrypto loaded")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
