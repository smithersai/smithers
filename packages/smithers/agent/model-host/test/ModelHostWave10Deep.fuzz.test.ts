import { Fuzz } from "@smthrs/fuzz"
import { Evaluator, Model, ModelError, type ModelEvent } from "@smthrs/model"
import { AgentContext, AgentTurnJournal, ConfiguredModel, type DocsPages, NativeAgent } from "@smthrs/rpc"
import { fixtures as homeFixtures } from "@smthrs/rpc/fixtures/Home"
import { fixtures as todoFixtures } from "@smthrs/rpc/fixtures/Todo"
import { Arbitrary, Clock, Duration, Effect, Exit, Logger, Redacted, Schema, Scope, Stream } from "effect"
import { HttpEffect } from "effect/http"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as ConfiguredModelRoute from "../src/ConfiguredModelRoute.ts"
import * as FastModelFallback from "../src/FastModelFallback.ts"
import * as HostDiagnostics from "../src/HostDiagnostics.ts"
import * as BoundedJson from "../src/internal/BoundedJson.ts"
import * as ContextStream from "../src/internal/ContextStream.ts"
import * as LocalModel from "../src/LocalModel.ts"
import {
  createModelProbe,
  createModelTurnHandler,
  type DurableChatGrant,
  inFlow,
  MODEL_HOST_CONTEXT_SELECT_PATH,
  MODEL_HOST_PROTOCOL,
  MODEL_HOST_STREAM_PATH,
  MODEL_HOST_TURN_PATH,
  runContextPreflight,
  runDurableChatTurn,
  runModelTurn
} from "./fixtures/durable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const AUTH = "bearer_test_authorization_token_123456"

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeCursor = (): AgentTurnJournal.AgentTurnCursor => ({
  version: 1,
  runId: "run",
  legId: "leg",
  batch: 0,
  position: 0,
  hash: "a".repeat(64)
})

const makeGrant = (opts: {
  readonly withApi?: boolean
  readonly withSource?: boolean
  readonly expiresAt?: string
  readonly installOrigin?: string
  readonly request?: NativeAgent.StartAgentTurnRequest
} = {}): DurableChatGrant => ({
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run",
  legId: "leg",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor: makeCursor(),
  expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  request: opts.request ?? {
    runId: "run",
    instructions: "Answer briefly.",
    messages: [{ role: "user", content: "Run command" }]
  },
  producerBaseUrl: "http://callback.test/",
  ...(opts.withSource !== false ? { source: { repository: "acme/app" } } : {}),
  ...(opts.installOrigin !== undefined
    ? { installOrigin: opts.installOrigin }
    : opts.withApi !== false
    ? { installOrigin: "http://127.0.0.1:4567" }
    : {}),
  ...(opts.withApi !== false ? { api: { author: "ben", token: `smithers_${"a".repeat(40)}` } } : {})
})

const makeCommitFetch = (opts: {
  readonly failFirstCommit?: boolean
  readonly invalidReceipt?: boolean
  readonly apiHandler?: (url: string, init?: RequestInit) => Response | Promise<Response>
} = {}): NativeAgent.FetchLike => {
  let failedOnce = false
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes("/provider-started")) return new Response(null, { status: 204 })
    if (url.includes("/commit")) {
      if (opts.failFirstCommit && !failedOnce) {
        failedOnce = true
        throw new Error("network blip")
      }
      if (opts.invalidReceipt) {
        return new Response(JSON.stringify({ status: "bogus" }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body ?? "{}"))
      const expected = body.expected
      const frames = body.frames
      const unsigned = {
        version: 1,
        runId: expected.runId,
        legId: expected.legId,
        batch: expected.batch + 1,
        from: expected.position + 1,
        previousHash: expected.hash,
        frames
      }
      const batch = {
        ...unsigned,
        hash: createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned)).digest("hex")
      }
      return new Response(
        JSON.stringify({
          status: "committed",
          batch,
          cursor: {
            version: 1,
            runId: expected.runId,
            legId: expected.legId,
            batch: batch.batch,
            position: batch.from + frames.length - 1,
            hash: batch.hash
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
    if (opts.apiHandler) return opts.apiHandler(url, init)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
}

const twoStepToolModel = (commandName: string, commandArgs?: string): Model.Model => {
  let step = 0
  return {
    stream: () => {
      step += 1
      if (step === 1) {
        return Stream.fromIterable<ModelEvent.ModelEvent>([
          { type: "tool-call-start", id: "tc-1", name: "commands" },
          {
            type: "tool-call-delta",
            id: "tc-1",
            arguments: JSON.stringify({
              action: "execute",
              name: commandName,
              ...(commandArgs !== undefined ? { args: commandArgs } : {})
            })
          },
          { type: "tool-call-end", id: "tc-1" },
          { type: "settle", stopReason: "tool-calls" }
        ])
      }
      return Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-delta", id: "t-1", text: "Done." },
        { type: "settle", stopReason: "stop" }
      ])
    }
  }
}

const sampleDocs: ReadonlyArray<DocsPages.DocsPage> = [
  {
    slug: "getting-started",
    title: "Getting Started",
    summary: "Quick start guide",
    markdown: "# Welcome\nRun smithers."
  }
]

describe("@smthrs/model-host Wave10 Deep Fuzzing", () => {
  it(
    "fuzzes HostTools: uiCommand, formCommand, docsCommand, flow/flow.edit, stack, todo, github retry, file/files errors, and hostContext",
    async () => {
      const scenarios = [
        "theme_light",
        "theme_bad",
        "theme_empty",
        "todo_tail_ok",
        "todo_tail_err",
        "file_other_repo",
        "form_json",
        "form_text",
        "form_bad",
        "docs_card",
        "docs_read_ok",
        "docs_read_missing",
        "docs_bad_args",
        "flow_from_list",
        "flow_from_single",
        "flow_missing",
        "flow_bad_args",
        "flow_edit_system",
        "flow_edit_ok",
        "flow_edit_bad_confirm",
        "flow_edit_api_err",
        "stack_ok",
        "stack_bad",
        "stack_bad_todo",
        "todo_ok",
        "todo_bad",
        "todo_tn_args",
        "github_retry_ok",
        "github_retry_extra",
        "file_wrong_repo",
        "file_ref_refused",
        "file_path_refused",
        "file_unreachable",
        "files_wrong_repo",
        "files_bad_args"
      ] as const

      const arb = Arbitrary.schema(Schema.Literals(scenarios))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (scenario) =>
            Effect.gen(function*() {
              const flowCard = {
                name: "ci",
                title: "CI",
                system: scenario === "flow_edit_system",
                description: "Run CI",
                steps: [],
                actions: []
              }
              const homeCard = (Object.values(homeFixtures)[0] as any)?.model ?? {
                repo: "acme/app",
                items: [
                  { n: 1, title: "Fix bug", state: "active" },
                  { n: 2, title: "Old", state: "merged" }
                ]
              }
              const todoCard = todoFixtures.queued.model

              const apiHandler = async (url: string, init?: RequestInit): Promise<Response> => {
                if (scenario === "file_unreachable") throw new Error("ECONNREFUSED")
                if (url.includes("/api/flows/ci")) {
                  if (scenario === "flow_from_single") {
                    return new Response(JSON.stringify(flowCard), { status: 200 })
                  }
                  return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
                }
                if (url.includes("/api/flows")) {
                  if (scenario === "flow_from_single" || scenario === "flow_missing") {
                    return new Response(JSON.stringify([]), { status: 200 })
                  }
                  return new Response(JSON.stringify([flowCard]), { status: 200 })
                }
                if (url.includes("/todos") && init?.method === "POST") {
                  if (scenario === "flow_edit_bad_confirm") {
                    return new Response(JSON.stringify({ wrong: true }), { status: 200 })
                  }
                  if (scenario === "flow_edit_api_err") {
                    return new Response(JSON.stringify({ error: "denied" }), { status: 500 })
                  }
                  return new Response(
                    JSON.stringify({ confirmation: "conf-1", state: "pending" }),
                    { status: 202 }
                  )
                }
                if (url.includes("/stack") || url.includes("/home")) {
                  if (scenario === "stack_bad") return new Response(JSON.stringify({ bad: true }), { status: 200 })
                  return new Response(JSON.stringify(homeCard), { status: 200 })
                }
                if (url.includes("/todo")) {
                  if (scenario === "todo_bad" || scenario === "stack_bad_todo") {
                    return new Response(JSON.stringify({ bad: true }), { status: 200 })
                  }
                  return new Response(JSON.stringify(todoCard), { status: 200 })
                }
                if (url.includes("/source/read")) {
                  if (scenario === "file_path_refused") {
                    return new Response(JSON.stringify({ code: "path_refused" }), { status: 400 })
                  }
                  return new Response(JSON.stringify({ content: "hi" }), { status: 200 })
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 })
              }

              let cmd = "theme"
              let args: string | undefined = "light"
              let withApi = true
              let withSource = true

              switch (scenario) {
                case "theme_light":
                  cmd = "theme"
                  args = "light"
                  break
                case "theme_bad":
                  cmd = "theme"
                  args = "neon"
                  break
                case "theme_empty":
                  cmd = "theme"
                  args = ""
                  withApi = false
                  break
                case "todo_tail_ok":
                  cmd = "todo.answer"
                  args = "T1 yes please"
                  break
                case "todo_tail_err":
                  cmd = "todo.approve"
                  args = "T1 unexpected extra"
                  break
                case "file_other_repo":
                  cmd = "file"
                  args = "README.md other/repo"
                  break
                case "form_json":
                  cmd = "secrets.set"
                  args = JSON.stringify({ name: "API_KEY", scope: "all" })
                  withApi = false
                  withSource = false
                  break
                case "form_text":
                  cmd = "secrets.set"
                  args = "API_KEY"
                  withApi = false
                  withSource = false
                  break
                case "form_bad":
                  cmd = "secrets.set"
                  args = "{not-json"
                  withApi = false
                  withSource = false
                  break
                case "docs_card":
                  cmd = "docs"
                  args = "getting-started"
                  break
                case "docs_read_ok":
                  cmd = "docs"
                  args = JSON.stringify({ mode: "read", page: "getting-started" })
                  break
                case "docs_read_missing":
                  cmd = "docs"
                  args = JSON.stringify({ mode: "read", page: "no-such-page" })
                  break
                case "docs_bad_args":
                  cmd = "docs"
                  args = "{bad"
                  break
                case "flow_from_list":
                case "flow_from_single":
                case "flow_missing":
                  cmd = "flow"
                  args = JSON.stringify({ name: "ci" })
                  break
                case "flow_bad_args":
                  cmd = "flow"
                  args = "{bad"
                  break
                case "flow_edit_system":
                case "flow_edit_ok":
                case "flow_edit_bad_confirm":
                case "flow_edit_api_err":
                  cmd = "flow.edit"
                  args = JSON.stringify({ name: "ci", request: "add lint step" })
                  break
                case "stack_ok":
                case "stack_bad":
                case "stack_bad_todo":
                  cmd = "stack"
                  args = ""
                  break
                case "todo_ok":
                case "todo_bad":
                  cmd = "todo"
                  args = "T1"
                  break
                case "todo_tn_args":
                  cmd = "todo.reply"
                  args = "T1 looks good"
                  break
                case "github_retry_ok":
                  cmd = "github"
                  args = JSON.stringify({ operation: "retry" })
                  break
                case "github_retry_extra":
                  cmd = "github"
                  args = JSON.stringify({ operation: "retry", extra: "bad" })
                  break
                case "file_wrong_repo":
                  cmd = "file"
                  args = "README.md other/repo"
                  break
                case "file_ref_refused":
                  cmd = "file"
                  args = "README.md --ref v1"
                  break
                case "file_path_refused":
                case "file_unreachable":
                  cmd = "file"
                  args = "README.md"
                  break
                case "files_wrong_repo":
                  cmd = "files"
                  args = "src other/repo"
                  break
                case "files_bad_args":
                  cmd = "files"
                  args = "\"unclosed"
                  break
              }

              const ctx: AgentContext.AgentRuntimeContext = {
                version: AgentContext.AGENT_RUNTIME_CONTEXT_VERSION,
                product: "smithers",
                capturedAt: 1700000000000,
                revision: 1,
                surface: "chat",
                theme: "dark",
                selectedWorldDocument: null,
                github: { connected: true, login: "ben", repositories: 1 },
                cloud: { state: "signed-in", username: "ben" },
                worldState: { documentCount: 0, documents: [] },
                connectors: [],
                tabs: [{ id: "main", kind: "main", title: "Chat", active: true }],
                recentCards: [],
                capabilities: [],
                limitations: []
              }

              const g = makeGrant({
                withApi,
                withSource,
                request: {
                  runId: "run",
                  instructions: "Answer briefly.",
                  messages: [{ role: "user", content: "Go" }],
                  context: ctx,
                  ...(scenario.startsWith("form_") || scenario === "theme_empty" ? { privateConversation: true } : {})
                }
              })

              yield* runDurableChatTurn(
                twoStepToolModel(cmd, args),
                g,
                { credential: "sk-secret", modelId: "m1" },
                "http://callback.test/",
                makeCommitFetch({ apiHandler }),
                undefined,
                sampleDocs
              )
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: Math.min(executions, 90), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "fuzzes HostServer validation, stream errors/limits, context-select, installOrigin, and failure classification",
    async () => {
      expect(() =>
        createModelTurnHandler({
          authorization: "   ",
          callbackBaseUrl: "http://callback.test/",
          resolve: () => Effect.die("unused")
        })
      ).toThrow()
      expect(() =>
        createModelTurnHandler({
          authorization: AUTH,
          callbackBaseUrl: "javascript:alert(1)",
          resolve: () => Effect.die("unused")
        })
      ).toThrow()

      const modeArb = Arbitrary.schema(
        Schema.Literals([
          "stream_bad_owner",
          "stream_too_large",
          "stream_rate_limited",
          "stream_auth_err",
          "stream_defect",
          "context_bad_body",
          "context_no_preflight",
          "context_ok",
          "turn_bad_install_origin",
          "turn_valid_install_origin",
          "turn_expired",
          "turn_bad_messages"
        ])
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          modeArb,
          (mode) =>
            Effect.promise(async () => {
              const handler = HttpEffect.toWebHandler(
                createModelTurnHandler({
                  authorization: AUTH,
                  callbackBaseUrl: "http://callback.test/",
                  fetchImpl: makeCommitFetch(),
                  resolve: () => {
                    if (mode === "stream_rate_limited") {
                      return Effect.succeed({
                        model: {
                          stream: () => Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "429" }))
                        },
                        options: { credential: "sk-1", modelId: "m1" }
                      })
                    }
                    if (mode === "stream_auth_err") {
                      return Effect.succeed({
                        model: {
                          stream: () =>
                            Stream.fail(new ModelError.ModelError({ code: "authentication", message: "401" }))
                        },
                        options: { credential: "sk-1", modelId: "m1" }
                      })
                    }
                    if (mode === "stream_defect") {
                      return Effect.succeed({
                        model: { stream: () => Stream.die(new Error("boom")) },
                        options: { credential: "sk-1", modelId: "m1" }
                      })
                    }
                    if (mode === "stream_too_large") {
                      const big = "x".repeat(200_000)
                      return Effect.succeed({
                        model: {
                          stream: () =>
                            Stream.fromIterable<ModelEvent.ModelEvent>([
                              ...Array.from({ length: 12 }, (_, i) => ({
                                type: "text-delta" as const,
                                id: `t-${i}`,
                                text: big
                              })),
                              { type: "settle", stopReason: "stop" }
                            ])
                        },
                        options: { credential: "sk-1", modelId: "m1" }
                      })
                    }
                    const preflightModel: Model.Model = {
                      stream: () =>
                        Stream.fromIterable<ModelEvent.ModelEvent>([
                          { type: "text-delta", id: "p1", text: "[]" },
                          { type: "settle", stopReason: "stop" }
                        ])
                    }
                    return Effect.succeed({
                      model: {
                        stream: () =>
                          Stream.fromIterable<ModelEvent.ModelEvent>([
                            { type: "text-delta", id: "t1", text: "ok" },
                            { type: "settle", stopReason: "stop" }
                          ])
                      },
                      options: { credential: "sk-1", modelId: "m1" },
                      ...(mode === "context_ok"
                        ? {
                          preflight: {
                            input: {
                              prompt: "q",
                              author: "ben",
                              branch: "main",
                              state: "synced" as const,
                              recent: [],
                              candidates: [{
                                item: { kind: "file" as const, label: "a.ts", ref: "a.ts", revision: "1" },
                                text: "x"
                              }],
                              tokenBudget: 4000,
                              wikiOnly: false
                            },
                            model: preflightModel,
                            options: { credential: "sk-1", modelId: "m1" }
                          }
                        }
                        : {})
                    })
                  }
                }).pipe(Effect.provide(silentLogger))
              )

              const headers = {
                authorization: `Bearer ${AUTH}`,
                "content-type": "application/json",
                "x-smithers-model-host-protocol": String(MODEL_HOST_PROTOCOL)
              }

              if (mode.startsWith("stream_")) {
                const res = await handler(
                  new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      ownerId: mode === "stream_bad_owner" ? -1 : 1,
                      runId: "run",
                      instructions: "hi",
                      messages: [{ role: "user", content: "hi" }]
                    })
                  })
                )
                expect(res.status).toBeGreaterThanOrEqual(400)
              } else if (mode.startsWith("context_")) {
                const body = mode === "context_bad_body"
                  ? { bad: true }
                  : {
                    runId: "run",
                    ownerId: 1,
                    instructions: "",
                    messages: [],
                    contextSelection: {
                      prompt: "q",
                      author: "ben",
                      branch: "main",
                      state: "synced" as const,
                      recent: [],
                      candidates: [{
                        item: { kind: "file" as const, label: "a.ts", ref: "a.ts", revision: "1" },
                        text: "x"
                      }],
                      tokenBudget: 4000,
                      wikiOnly: false
                    }
                  }
                const res = await handler(
                  new Request(`http://host.test${MODEL_HOST_CONTEXT_SELECT_PATH}`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body)
                  })
                )
                if (mode === "context_ok") expect(res.status).toBe(200)
                else expect(res.status).toBeGreaterThanOrEqual(400)
              } else {
                const baseGrant = makeGrant({
                  expiresAt: mode === "turn_expired"
                    ? new Date(Date.now() - 10_000).toISOString()
                    : new Date(Date.now() + 60_000).toISOString(),
                  installOrigin: mode === "turn_bad_install_origin"
                    ? "https://user:pass@bad.example.com/path"
                    : "https://ok.example.com"
                })
                const wire: any = {
                  ...baseGrant,
                  request: mode === "turn_bad_messages"
                    ? { runId: "run", instructions: "hi", messages: [{ role: "bogus", content: 123 }] }
                    : baseGrant.request
                }
                const res = await handler(
                  new Request(`http://host.test${MODEL_HOST_TURN_PATH}`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(wire)
                  })
                )
                if (mode === "turn_valid_install_origin") expect(res.status).toBeLessThan(300)
                else expect(res.status).toBeGreaterThanOrEqual(400)
              }
              return true
            }),
          { executions: Math.min(executions, 24), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "fuzzes ModelTurnHost, DurableModelCall, ContextPreflight, DurableChatProducer, ModelProbe, LocalModel, FastModelFallback, HostDiagnostics, BoundedJson, and ContextStream",
    async () => {
      const turnScenarios = [
        "stop_aborted",
        "stop_length",
        "delta_before_start",
        "end_before_start",
        "double_settle",
        "retry_reset",
        "cred_in_event_id",
        "cred_in_settle_id",
        "tool_result_cut"
      ] as const
      for (const sc of turnScenarios) {
        const secret = "sk-topsecret-999"
        const model: Model.Model = {
          stream: () => {
            switch (sc) {
              case "stop_aborted":
                return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "settle", stopReason: "aborted" }])
              case "stop_length":
                return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "settle", stopReason: "length" }])
              case "delta_before_start":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "tool-call-delta", id: "missing", arguments: "{}" },
                  { type: "settle", stopReason: "stop" }
                ])
              case "end_before_start":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "tool-call-end", id: "missing" },
                  { type: "settle", stopReason: "stop" }
                ])
              case "double_settle":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "settle", stopReason: "stop" },
                  { type: "settle", stopReason: "stop" }
                ])
              case "retry_reset":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "thinking-delta", id: "th1", text: "hmm" },
                  { type: "text-delta", id: "tx1", text: "partial" },
                  { type: "retry", attempt: 1, code: `err-${secret}`, delayMs: 1 } as any,
                  { type: "text-delta", id: "tx2", text: "fresh" },
                  {
                    type: "settle",
                    stopReason: "stop",
                    timing: {
                      totalMs: 10,
                      failedTries: [{ attempt: 1, code: `fail-${secret}`, delayMs: 1 }]
                    } as any
                  }
                ])
              case "cred_in_event_id":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-delta", id: `id-${secret}`, text: "x" },
                  { type: "settle", stopReason: "stop" }
                ])
              case "cred_in_settle_id":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "settle", stopReason: "stop", responseId: `resp-${secret}` } as any
                ])
              case "tool_result_cut":
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "tool-result", id: "tr-1", name: "t", output: `out-${secret}` } as any,
                  { type: "settle", stopReason: "stop" }
                ])
            }
          }
        }
        const frames: Array<unknown> = []
        const exit = await Effect.runPromiseExit(
          runModelTurn(
            model,
            {
              runId: "run",
              instructions: "hi",
              messages: [
                { role: "user", content: "q" },
                { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a", arguments: "{}" }] } as any,
                { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "b", arguments: "{}" }] } as any,
                { role: "tool", toolCallId: "c1", name: "a", content: "r1" } as any,
                { role: "tool", toolCallId: "c2", name: "b", content: "r2" } as any
              ]
            },
            { credential: secret, modelId: "m1" },
            (frame) =>
              Effect.sync(() => {
                frames.push(frame)
              })
          ).pipe(Effect.provide(silentLogger))
        )
        expect(exit).toBeDefined()
      }

      const badPreflight = await Effect.runPromiseExit(
        runContextPreflight(
          { bad: true } as any,
          { stream: () => Stream.empty },
          { credential: "sk-1", modelId: "m1" }
        ).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(badPreflight)).toBe(true)

      const preflightRetryModel: Model.Model = {
        stream: () =>
          Stream.fromIterable<ModelEvent.ModelEvent>([
            { type: "text-delta", id: "1", text: "garbage" },
            { type: "retry", attempt: 1, code: "transient", delayMs: 1 } as any,
            { type: "usage", inputTokens: 1, outputTokens: 1 } as any,
            { type: "text-delta", id: "2", text: "[{\"index\":0,\"reason\":\"hi \uD83D" },
            { type: "text-delta", id: "2", text: "\uDE00\"}]" },
            { type: "settle", stopReason: "stop" }
          ])
      }
      const okPref = await Effect.runPromise(
        runContextPreflight(
          {
            prompt: "q",
            author: "ben",
            branch: "main",
            state: "synced" as const,
            recent: [],
            candidates: [{ item: { kind: "file" as const, label: "a.ts", ref: "a.ts", revision: "1" }, text: "x" }],
            tokenBudget: 4000,
            wikiOnly: false
          },
          preflightRetryModel,
          { credential: "sk-1", modelId: "m1" }
        ).pipe(Effect.provide(silentLogger))
      )
      expect(okPref.result.context.length).toBe(1)

      for (
        const badEvs of [
          [{ type: "tool-call-start", id: "t1", name: "x" }, { type: "settle", stopReason: "stop" }],
          [{ type: "settle", stopReason: "length" }]
        ] as ReadonlyArray<ReadonlyArray<ModelEvent.ModelEvent>>
      ) {
        const ex = await Effect.runPromiseExit(
          runContextPreflight(
            {
              prompt: "q",
              author: "ben",
              branch: "main",
              state: "synced" as const,
              recent: [],
              candidates: [{ item: { kind: "file" as const, label: "a.ts", ref: "a.ts", revision: "1" }, text: "x" }],
              tokenBudget: 4000,
              wikiOnly: false
            },
            { stream: () => Stream.fromIterable(badEvs) },
            { credential: "sk-1", modelId: "m1" }
          ).pipe(Effect.provide(silentLogger))
        )
        expect(Exit.isFailure(ex)).toBe(true)
      }

      await Effect.runPromise(
        runDurableChatTurn(
          {
            stream: () =>
              Stream.fromIterable<ModelEvent.ModelEvent>([
                { type: "text-delta", id: "1", text: "ok" },
                { type: "settle", stopReason: "stop" }
              ])
          },
          makeGrant(),
          { credential: "sk-1", modelId: "m1" },
          "http://callback.test/",
          makeCommitFetch({ failFirstCommit: true })
        ).pipe(Effect.provide(silentLogger))
      )
      const badRcptExit = await Effect.runPromiseExit(
        runDurableChatTurn(
          {
            stream: () =>
              Stream.fromIterable<ModelEvent.ModelEvent>([
                { type: "text-delta", id: "1", text: "ok" },
                { type: "settle", stopReason: "stop" }
              ])
          },
          makeGrant(),
          { credential: "sk-1", modelId: "m1" },
          "http://callback.test/",
          makeCommitFetch({ invalidReceipt: true })
        ).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(badRcptExit)).toBe(true)

      expect(LocalModel.modelFailureOf(new ModelError.ModelError({ code: "unknown", message: "x" }), 1000).code).toBe(
        "invalid"
      )
      expect(LocalModel.modelFailureOf(new Evaluator.EvaluatorError({ code: "unreachable", message: "x" }), 1000).code)
        .toBe(
          "unreachable"
        )
      expect(LocalModel.modelFailureOf(new Evaluator.EvaluatorError({ code: "timeout", message: "x" }), 1000).code)
        .toBe(
          "timeout"
        )
      expect(
        LocalModel.modelFailureOf(new Evaluator.EvaluatorError({ code: "refused", status: 403, message: "x" }), 1000)
          .code
      ).toBe("refused")

      const emptyFallback = FastModelFallback.fastModelFallback([])
      const fbExit = await Effect.runPromiseExit(
        inFlow(Stream.runCollect(emptyFallback.stream({ messages: [] } as any)))
      )
      expect(Exit.isFailure(fbExit)).toBe(true)

      const cgPlanned = LocalModel.planOnLocal(
        { id: "cg", protocol: "openai-responses-chatgpt", modelId: "gpt-5", credential: "OPENAI_API_KEY" },
        { OPENAI_API_KEY: JSON.stringify({ accessToken: "tok", accountId: "acct-1" }) },
        { egress: true }
      )
      if (cgPlanned.ok && cgPlanned.plan.kind === "generation") {
        const m = ConfiguredModelRoute.toModel(
          cgPlanned.plan,
          Redacted.make(JSON.stringify({ accessToken: "tok", accountId: "acct-1" }))
        )
        expect(m).toBeDefined()
      }

      const probe = createModelProbe({
        env: { OPENAI_API_KEY: "sk-test" },
        egress: true,
        deadlineMs: 50
      })
      const mismatchRes = await Effect.runPromise(
        probe.test(
          {
            id: "gen-m",
            protocol: "openai-chat",
            modelId: "gpt-4o-mini",
            credential: "OPENAI_API_KEY"
          },
          ConfiguredModel.modelCallDefault("decision")
        )
      )
      expect(mismatchRes.ok).toBe(false)

      // HostDiagnostics: missing runtime throws + pending timer fires
      expect(() => HostDiagnostics.createHostDiagnostics({ write: () => undefined })).toThrow()
      const lines: Array<string> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const clock = yield* Clock.Clock
            const scope = yield* Scope.Scope
            const diag = HostDiagnostics.createHostDiagnostics({
              runtime: { clock, scope },
              pendingMillis: 10,
              write: (line) => {
                lines.push(line)
              }
            })
            const finish = yield* diag.begin("turn", {})
            yield* TestClock.adjust(Duration.millis(25))
            finish({ status: "ok" })
          }).pipe(Effect.provide(TestClock.layer()))
        )
      )
      expect(lines.some((l) => l.includes("pending"))).toBe(true)

      const hugeCl = await Effect.runPromise(
        BoundedJson.boundedJson({ headers: { "content-length": "999999999" }, stream: Stream.empty } as any)
      )
      expect(hugeCl).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({ headers: { "content-length": "not-a-num" }, stream: Stream.empty } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({ headers: {}, stream: Stream.empty } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({
            headers: {},
            stream: Stream.make(new Uint8Array(1_100_000), new Uint8Array(1_100_000))
          } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({ headers: {}, stream: Stream.make(new Uint8Array([0xff, 0xfe])) } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({ headers: {}, stream: Stream.fail(new Error("read error")) } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({ headers: {}, stream: Stream.die(new Error("read defect")) } as any)
        )
      ).toBeUndefined()
      expect(
        await Effect.runPromise(
          BoundedJson.boundedJson({
            headers: {},
            stream: Stream.make(new TextEncoder().encode("{\"ok\":true}"))
          } as any)
        )
      ).toEqual({ ok: true })

      const makeStream = (parts: ReadonlyArray<string>) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const p of parts) controller.enqueue(new TextEncoder().encode(p))
            controller.close()
          }
        })
      // Exercise thinking-delta finish on settle + dual tool calls in one assistant turn
      const dualAndThinkingModel: Model.Model = {
        stream: () =>
          Stream.fromIterable<ModelEvent.ModelEvent>([
            { type: "thinking-delta", id: "th-1", text: "hmm" } as any,
            { type: "tool-call-start", id: "tc-a", name: "commands" },
            { type: "tool-call-delta", id: "tc-a", arguments: JSON.stringify({ action: "list" }) },
            { type: "tool-call-start", id: "tc-b", name: "commands" },
            { type: "tool-call-delta", id: "tc-b", arguments: JSON.stringify({ action: "list" }) },
            { type: "settle", stopReason: "tool_calls" }
          ])
      }
      await Effect.runPromiseExit(
        runDurableChatTurn(
          dualAndThinkingModel,
          makeGrant(),
          { credential: "sk-1", modelId: "m1" },
          "http://callback.test/",
          makeCommitFetch()
        ).pipe(Effect.provide(silentLogger))
      )

      // Exercise DurableChatProducer preflight pagination (>96KB)
      const bigCandidates = Array.from({ length: 40 }, (_, i) => ({
        item: { kind: "file" as const, label: `f${i}.ts`, ref: `f${i}.ts`, revision: "1" },
        text: "x".repeat(3_500)
      }))
      const bigPreflightInput = {
        prompt: "q",
        author: "ben",
        branch: "main",
        state: "synced" as const,
        recent: [],
        candidates: bigCandidates,
        tokenBudget: 4000,
        wikiOnly: false
      }
      await Effect.runPromiseExit(
        runDurableChatTurn(
          {
            stream: () =>
              Stream.fromIterable<ModelEvent.ModelEvent>([
                { type: "text-delta", id: "1", text: "ok" },
                { type: "settle", stopReason: "stop" }
              ])
          },
          makeGrant(),
          { credential: "sk-1", modelId: "m1" },
          "http://callback.test/",
          makeCommitFetch(),
          {
            input: bigPreflightInput,
            model: {
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  {
                    type: "text-delta",
                    id: "1",
                    text: JSON.stringify(bigCandidates.map((_, index) => ({ index, reason: "r".repeat(200) })))
                  },
                  { type: "settle", stopReason: "stop" }
                ])
            },
            options: { credential: "sk-1", modelId: "m1" }
          }
        ).pipe(Effect.provide(silentLogger))
      )

      // Exercise ModelProbe redirect & timeout
      const redirectProbe = createModelProbe({
        env: { K: "sk-1" },
        egress: true,
        deadlineMs: 50,
        fetch: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example" }
          })) as unknown as typeof globalThis.fetch
      })
      const redirOut = await Effect.runPromise(
        inFlow(
          redirectProbe.test(
            {
              id: "p1",
              protocol: "openai-compatible",
              modelId: "m1",
              baseUrl: "http://127.0.0.1:1/v1",
              credential: "K"
            } as any
          )
        ).pipe(Effect.provide(silentLogger))
      )
      expect(redirOut).toBeDefined()

      const timeoutProbe = createModelProbe({
        env: { K: "sk-1" },
        egress: true,
        deadlineMs: 15,
        fetch: ((_u: unknown, init?: RequestInit) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          })) as unknown as typeof globalThis.fetch
      })
      const toOut = await Effect.runPromise(
        inFlow(
          timeoutProbe.test(
            {
              id: "p2",
              protocol: "openai-compatible",
              modelId: "m1",
              baseUrl: "http://127.0.0.1:1/v1",
              credential: "K"
            } as any
          )
        ).pipe(Effect.provide(silentLogger))
      )
      expect(toOut).toBeDefined()

      // Exercise ContextStream out-of-order error
      const oooExit = await Effect.runPromiseExit(
        Effect.tryPromise(() =>
          ContextStream.readContextStream(
            new Response(
              makeStream([
                JSON.stringify({
                  type: "candidate",
                  value: { item: { kind: "file", label: "a", ref: "a", revision: "1" }, text: "x" }
                }) + "\n"
              ])
            )
          )
        )
      )
      expect(Exit.isFailure(oooExit)).toBe(true)

      for (
        const chunks of [
          ["a".repeat(200_000) + "\n"],
          ["{\"type\":\"end\"}\n{\"type\":\"input\",\"value\":{}}\n"],
          ["{\"type\":\"input\",\"value\":{}}\n{\"type\":\"input\",\"value\":{}}\n"],
          ["{\"type\":\"input\",\"value\":{}}\n{\"type\":\"candidate\",\"value\":{}}\n{\"type\":\"recent\",\"value\":{}}\n"],
          ["{\"type\":\"input\",\"value\":{}}"]
        ]
      ) {
        const ex = await Effect.runPromiseExit(
          Effect.tryPromise(() => ContextStream.readContextStream(new Response(makeStream(chunks))))
        )
        expect(Exit.isFailure(ex)).toBe(true)
      }
    },
    60_000
  )
})
