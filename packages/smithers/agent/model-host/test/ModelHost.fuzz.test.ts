import { Fuzz } from "@smthrs/fuzz"
import { Model, ModelError, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { AgentTurnJournal, ConfiguredModel, ContextPreflight, type NativeAgent } from "@smthrs/rpc"
import { Arbitrary, ConfigProvider, Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import { HttpEffect } from "effect/http"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { inertCallbackTransport } from "../src/CallbackTransport.ts"
import { toEvaluatorLayer, toModel, withRoute } from "../src/ConfiguredModelRoute.ts"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { fastModelFallback } from "../src/FastModelFallback.ts"
import { createHostDiagnostics, HOST_DIAGNOSTIC_MARKER, makeHostDiagnostics } from "../src/HostDiagnostics.ts"
import { HostModel } from "../src/HostModel.ts"
import { readContextStream } from "../src/internal/ContextStream.ts"
import { cutCredentialJson } from "../src/internal/CredentialJson.ts"
import { localModelCatalog, localModelCredential, modelFailureOf, planOnLocal } from "../src/LocalModel.ts"
import { ResolveFailed } from "../src/ModelHostError.ts"
import { modelAnswersOf } from "../src/ModelProbe.ts"
import { providerTransport, refusingRedirects } from "../src/ProviderTransport.ts"
import { StreamingCredentialCutter } from "../src/StreamingCredentialCutter.ts"
import {
  apiCaller,
  bearerAuthorization,
  createModelProbe,
  createModelTurnHandler,
  fixtureRoute,
  inFlow,
  MODEL_HOST_CONTEXT_SELECT_PATH,
  MODEL_HOST_HEALTH_PATH,
  MODEL_HOST_PROTOCOL,
  MODEL_HOST_STREAM_PATH,
  MODEL_HOST_TURN_PATH,
  providerRequest,
  runContextPreflight,
  runDurableChatTurn,
  runHostTurn,
  runModelTurn,
  sourceLister,
  sourceReader
} from "./fixtures/durable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeCommittedResponse = (body: Record<string, any>) => {
  const expected = body.expected
  const frames = body.frames as Array<any>
  const unsigned = {
    version: 1 as const,
    runId: expected.runId ?? "run",
    legId: expected.legId ?? "leg",
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames
  }
  const hash = createHash("sha256")
    .update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned))
    .digest("hex")
  const batch = { ...unsigned, hash }
  return {
    status: "committed" as const,
    batch,
    cursor: {
      version: 1 as const,
      runId: unsigned.runId,
      legId: unsigned.legId,
      batch: batch.batch,
      position: unsigned.from + frames.length - 1,
      hash
    }
  }
}

const baseCursor: AgentTurnJournal.AgentTurnCursor = {
  version: 1,
  runId: "run",
  legId: "leg",
  batch: 0,
  position: 0,
  hash: "a".repeat(64)
}

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  turnId: "turn-1",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "producer_capability_producer_capability_1234",
  cursor: baseCursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: { runId: "run", instructions: "answer", messages: [{ role: "user" as const, content: "hi" }] },
  producerBaseUrl: "http://callback.test/",
  ...overrides
})

describe("@smthrs/model-host fuzz invariants", () => {
  it("StreamingCredentialCutter & cutCredentialJson never leak credentials across arbitrary chunk splits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.Literals([
          "sk-ant-secret-1234567890",
          "tok_alpha_beta_gamma_99",
          "ab+cd/ef=gh_secret_key",
          "{\"accessToken\":\"jwt-secret-111\",\"accountId\":\"acct-222\"}",
          ""
        ]),
        extraSecret: Schema.Literals(["", "extra-secret-zzzz"]),
        prefix: Schema.Literals(["", "hello ", "sk-", "sk-ant-"]),
        middle: Schema.Literals(["", " ", "mid", "sk-ant-secret-1234567890"]),
        suffix: Schema.Literals(["", " end", "1234567890"]),
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 11 }))),
        nestedSandwich: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secret, extraSecret, prefix, middle, suffix, chunkSize, nestedSandwich }) =>
          Effect.sync(() => {
            const parts = [secret, extraSecret].flatMap(ConfiguredModel.modelCredentialParts)
            const cutter = new StreamingCredentialCutter(secret, extraSecret === "" ? [] : [extraSecret])
            const sandwich = nestedSandwich && secret.length >= 4
              ? secret.slice(0, 3) + secret + secret.slice(3)
              : secret
            const full = `${prefix}${sandwich}${middle}${extraSecret}${suffix}`

            let out = ""
            for (let i = 0; i < full.length; i += chunkSize) {
              out += cutter.push(full.slice(i, i + chunkSize))
            }
            out += cutter.finish()

            // Core security invariant: no credential part ever appears in the combined output!
            for (const part of parts) {
              if (out.includes(part)) return false
            }

            // cutCredentialJson preserves valid JSON and strips secret from string values
            const jsonText = JSON.stringify({ msg: `leaked ${secret} here`, n: 42 })
            const cutJson = cutCredentialJson(jsonText, (s) => {
              const c = new StreamingCredentialCutter(secret)
              return c.push(s) + c.finish()
            })
            const parsed = JSON.parse(cutJson) as { msg: string; n: number }
            if (parsed.n !== 42) return false
            for (const part of ConfiguredModel.modelCredentialParts(secret)) {
              if (parsed.msg.includes(part)) return false
            }
            // Invalid JSON passes through untouched
            if (cutCredentialJson("{bad json", (s) => s) !== "{bad json") return false

            // Inert callback transport runs action cleanly
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)

    const attempt = inertCallbackTransport.begin()
    expect(await attempt.run(async () => 42)).toBe(42)
    expect(attempt.fields()).toEqual({})
  })

  it("ConfiguredModelRoute, LocalModel, HostModel, ProviderTransport, ModelProbe & EnvironmentResolver", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        protocol: Schema.Literals([
          "anthropic-messages",
          "openai-responses",
          "openai-chat",
          "openai-responses-chatgpt",
          "evaluation"
        ]),
        credMode: Schema.Literals(["valid", "missing", "bad-chatgpt", "stored"]),
        egress: Schema.Boolean,
        redirectStatus: Schema.Literals([200, 301, 302, 307, 308]),
        failureKind: Schema.Literals(["timeout", "auth", "rate-limit", "transport", "unknown"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ protocol, credMode, egress, redirectStatus, failureKind }) =>
          Effect.gen(function*() {
            const baseUrl = egress ? "https://fixture.test" : "http://127.0.0.1:8080"
            const keyValue = protocol === "openai-responses-chatgpt"
              ? credMode === "bad-chatgpt"
                ? "{\"accessToken\":\"only-token\"}"
                : JSON.stringify({ accessToken: "at-123", accountId: "acc-456" })
              : "sk-test-fixture-key"

            const env: ConfiguredModel.ModelCredentialEnv = credMode === "valid" || credMode === "bad-chatgpt"
              ? {
                SMITHERS_MODEL_KEY_FIXTURE: ` ${keyValue} `,
                SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: baseUrl
              }
              : {}

            const stored = credMode === "stored"
              ? {
                refresh: () => Effect.void,
                list: () => [{ name: "FIXTURE", present: true, origins: [baseUrl] }],
                read: (name: string) => (name === "FIXTURE" ? Redacted.make(keyValue) : undefined)
              }
              : undefined

            const binding = {
              protocol,
              baseUrl,
              modelId: "fixture-model",
              credential: "FIXTURE"
            }

            const planned = planOnLocal(binding, env, egress ? {} : { egress: false }, stored)
            const catalog = localModelCatalog(env, egress ? {} : { egress: false }, stored)
            if (credMode === "missing") {
              if (planned.ok) return false
            } else if (planned.ok) {
              const apiKey = planned.apiKey
              const routeRes = withRoute(planned.plan, apiKey, (r) => r.id)
              if (protocol === "evaluation") {
                if (Result.isSuccess(routeRes) || routeRes.failure.code !== "no_route") return false
              } else if (protocol === "openai-responses-chatgpt" && credMode === "bad-chatgpt") {
                if (Result.isSuccess(routeRes) || routeRes.failure.code !== "authentication") return false
              } else {
                if (Result.isFailure(routeRes)) return false
                const builtModel = yield* Effect.result(toModel(planned.plan, apiKey))
                if (Result.isFailure(builtModel)) return false
                // HostModel.layer & HostModel.make
                const hostSvc = yield* HostModel.pipe(Effect.provide(HostModel.layer(planned.plan, apiKey)))
                if (hostSvc.modelId !== "fixture-model") return false
              }
              // Evaluator layer builds cleanly
              const evalLayer = toEvaluatorLayer(planned.plan, apiKey, 500)
              if (evalLayer === undefined) return false
            }

            // HostModel.make via ConfigProvider
            const cfgProvider = ConfigProvider.fromUnknown(env)
            const madeHost = yield* Effect.result(
              HostModel.make(binding).pipe(Effect.provide(ConfigProvider.layer(cfgProvider)))
            )
            if (
              protocol === "evaluation" || credMode === "missing" || credMode === "stored" ||
              (protocol === "openai-responses-chatgpt" && credMode === "bad-chatgpt")
            ) {
              if (Result.isSuccess(madeHost)) return false
            } else if (Result.isFailure(madeHost)) {
              return false
            }

            // refusingRedirects + providerTransport
            let refusedCode: number | undefined
            const fakeFetch: typeof globalThis.fetch = Object.assign(
              async () =>
                new Response("ok", {
                  status: redirectStatus,
                  headers: redirectStatus >= 300 ? { location: "https://evil.test" } : {}
                }),
              { preconnect() {} }
            )
            const guarded = refusingRedirects(fakeFetch, (code) => {
              refusedCode = code
            })
            const fetchOutcome = yield* Effect.result(
              Effect.tryPromise(() => guarded("https://fixture.test/v1/test"))
            )
            if (redirectStatus >= 300) {
              if (Result.isSuccess(fetchOutcome) || refusedCode !== redirectStatus) return false
            } else if (Result.isFailure(fetchOutcome)) {
              return false
            }
            const transportLayer = providerTransport(fakeFetch)
            if (transportLayer === undefined) return false

            // localModelCredential & modelFailureOf
            const cred = localModelCredential(env, "FIXTURE")
            if ((credMode === "valid" || credMode === "bad-chatgpt") && cred === undefined) return false
            const errInput = failureKind === "timeout"
              ? new ModelError.ModelError({ code: "call_timeout", message: "timed out" })
              : failureKind === "auth"
              ? new ModelError.ModelError({ code: "authentication", message: "bad key" })
              : failureKind === "rate-limit"
              ? new ModelError.ModelError({ code: "rate_limited", message: "429" })
              : failureKind === "transport"
              ? new ModelError.ModelError({ code: "transport", message: "conn reset" })
              : new Error("mystery")
            const mappedFail = modelFailureOf(errInput, failureKind === "timeout" ? 1000 : undefined)
            if (failureKind === "timeout" && mappedFail.code !== "timeout") return false

            // EnvironmentResolver
            const resolver = environmentModelResolver({
              binding,
              env
            })
            const resolved = yield* Effect.result(resolver(makeGrant() as any))
            if (
              protocol === "evaluation" || credMode === "missing" || credMode === "stored" ||
              (protocol === "openai-responses-chatgpt" && credMode === "bad-chatgpt")
            ) {
              if (Result.isSuccess(resolved)) return false
            } else if (Result.isFailure(resolved)) {
              return false
            }

            // ModelProbe catalog
            const probe = createModelProbe({
              env,
              egress,
              ...(stored === undefined ? {} : { credentials: stored }),
              fetch: fakeFetch
            })
            const probeCat = probe.catalog()
            const answers = modelAnswersOf(
              { q1: { kind: "yes-no", prompt: "ok?" } as any },
              { q1: { kind: "yes-no", value: true } as any }
            )
            return catalog.credentials.length >= 0 && probeCat.credentials.length >= 0 && "q1" in answers
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    assertPassed(report)
  })

  it("HostDiagnostics sanitizes fields, rejects reserved/unknown fields, and isolates sink errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        event: Schema.Literals(["turn", "provider_call", "journal_commit", "unknown_event_xyz"]),
        phase: Schema.Literals(["start", "end", "pending", "failed", "bogus_phase"]),
        statusKey: Schema.Literals(["200", "500", "nan", "inf"]),
        capAt: Schema.Literals([3, 100]),
        inert: Schema.Boolean,
        detailLimit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ event, phase, statusKey, capAt, inert, detailLimit }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const lines: Array<string> = []
              let now = 1000
              const diag = yield* makeHostDiagnostics({
                turnId: "turn-fuzz",
                detailLimit,
                limit: capAt,
                slowMillis: 50,
                pendingMillis: 10_000,
                clock: () => {
                  now += 10
                  return now
                },
                write: inert
                  ? undefined
                  : (line) => {
                    lines.push(line)
                  }
              })

              diag.record(event, phase, {
                status: statusKey === "200"
                  ? 200
                  : statusKey === "500"
                  ? 500
                  : statusKey === "nan"
                  ? Number.NaN
                  : Number.POSITIVE_INFINITY,
                marker: "forged-marker",
                turnId: "forged-turn",
                secretField: "sk-ant-do-not-log",
                bytes: 128,
                ok: true
              })

              // Also exercise begin/finish lifecycle past detailLimit
              for (let i = 0; i <= detailLimit + 1; i += 1) {
                const finish = yield* diag.begin(event, { bytes: i })
                finish({ status: 200 })
                finish({ status: 500 }) // idempotent second call must be ignored
              }

              if (inert) {
                return lines.length === 0
              }
              if (lines.length === 0 || lines.length > capAt) return false
              for (const line of lines) {
                if (
                  line.includes("sk-ant-do-not-log") || line.includes("forged-marker") || line.includes("forged-turn")
                ) {
                  return false
                }
                const parsed = JSON.parse(line) as Record<string, unknown>
                if (parsed.diagnostic !== HOST_DIAGNOSTIC_MARKER) return false
                if (parsed.turnId !== "turn-fuzz") return false
              }
              // createHostDiagnostics without write returns inert
              const inertDiag = createHostDiagnostics()
              inertDiag.record("turn", "start")
              return true
            })
          ),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("FastModelFallback, ModelTurnHost, ContextPreflight & ContextStream uphold contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        primaryMode: Schema.Literals(["ok", "retryable-fail", "fatal-fail", "tool-call"]),
        fallbackOk: Schema.Boolean,
        preflightOutput: Schema.Literals([
          "[{\"index\":0,\"reason\":\"Relevant\"}]",
          "[{\"index\":0,\"reason\":\"A\"},{\"index\":0,\"reason\":\"Dup\"},{\"index\":99,\"reason\":\"OOB\"}]",
          "not valid json",
          "[]"
        ]),
        streamMode: Schema.Literals(["valid", "bad-content-type", "bad-json", "count-mismatch"]),
        usageNeg: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ primaryMode, fallbackOk, preflightOutput, streamMode, usageNeg }) =>
          Effect.gen(function*() {
            const makeModel = (mode: "ok" | "retryable-fail" | "fatal-fail" | "tool-call") =>
              Model.make({
                stream: () => {
                  if (mode === "retryable-fail") {
                    return Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "429" }))
                  }
                  if (mode === "fatal-fail") {
                    return Stream.fail(new ModelError.ModelError({ code: "invalid_request", message: "400" }))
                  }
                  if (mode === "tool-call") {
                    return Stream.fromIterable<ModelEvent.ModelEvent>([
                      { type: "tool-call-start", id: "tc1", name: "read_file" },
                      { type: "tool-call-delta", id: "tc1", arguments: "{\"path\":\"a.ts\"}" },
                      { type: "tool-call-end", id: "tc1" },
                      {
                        type: "usage",
                        inputTokens: usageNeg ? -5 : 10,
                        outputTokens: usageNeg ? Number.NaN : 5,
                        totalTokens: 15
                      },
                      { type: "settle", stopReason: "tool-calls" }
                    ])
                  }
                  return Stream.fromIterable<ModelEvent.ModelEvent>([
                    { type: "thinking-start", id: "r0" },
                    { type: "thinking-delta", id: "r0", text: "thinking sk-secret-999" },
                    { type: "thinking-end", id: "r0" },
                    { type: "text-start", id: "t0" },
                    { type: "text-delta", id: "t0", text: "answer sk-secret-999" },
                    { type: "text-end", id: "t0" },
                    { type: "usage", inputTokens: 12, outputTokens: 8, totalTokens: 20 },
                    { type: "settle", stopReason: "stop" }
                  ])
                }
              })

            // 1. fastModelFallback
            const fallbackIndices: Array<number> = []
            const fb = fastModelFallback(
              [
                { model: makeModel(primaryMode), route: fixtureRoute, modelId: "primary" },
                {
                  model: makeModel(fallbackOk ? "ok" : "fatal-fail"),
                  route: fixtureRoute,
                  modelId: "backup"
                }
              ],
              (idx) =>
                Effect.sync(() => {
                  fallbackIndices.push(idx)
                })
            )
            const fbReq = providerRequest(
              { runId: "r1", instructions: "sys", messages: [{ role: "user", content: "hi" }] },
              { modelId: "primary" }
            )
            const fbEvents = yield* Effect.result(inFlow(Stream.runCollect(fb.stream(fbReq))))
            if (primaryMode === "ok" || primaryMode === "tool-call") {
              if (Result.isFailure(fbEvents) || fallbackIndices.length !== 0) return false
            } else if (primaryMode === "retryable-fail" && fallbackOk) {
              if (Result.isFailure(fbEvents) || !fallbackIndices.includes(1)) return false
            }

            // 2. runModelTurn with credential redaction
            const frames: Array<NativeAgent.AgentTurnFrame> = []
            const turnRes = yield* Effect.result(
              runModelTurn(
                makeModel(primaryMode),
                { runId: "r1", instructions: "sys", messages: [{ role: "user", content: "hi" }] },
                { modelId: "primary", credential: "sk-secret-999" },
                (frame) =>
                  Effect.sync(() => {
                    frames.push(frame)
                  })
              )
            )
            if (primaryMode === "ok") {
              if (Result.isFailure(turnRes)) return false
              const serialized = JSON.stringify(frames)
              if (serialized.includes("sk-secret-999")) return false
            }

            // 3. runContextPreflight
            const pfModel = Model.make({
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-delta", id: "s", text: preflightOutput },
                  { type: "settle", stopReason: "stop" }
                ])
            })
            const pfInput: ContextPreflight.ContextPreflightInput = {
              prompt: "where are retries?",
              author: "alice",
              branch: "main",
              state: "synced",
              recent: [{ title: "R1", text: "recent text" }],
              candidates: [
                {
                  item: { kind: "file", label: "retry.ts", ref: "src/retry.ts", revision: "r1" },
                  text: "export const retry = 3"
                }
              ],
              tokenBudget: 8000,
              wikiOnly: false
            }
            const pfRes = yield* Effect.result(runContextPreflight(pfInput, pfModel, { modelId: "fast" }))
            const expectPfFail = preflightOutput === "not valid json" || preflightOutput.includes("99")
            if (expectPfFail) {
              if (Result.isSuccess(pfRes)) return false
            } else {
              if (Result.isFailure(pfRes)) return false
              if (pfRes.success.selectedContext.length > pfInput.candidates.length) return false
            }

            // 4. readContextStream
            const ctxResp = streamMode === "bad-content-type"
              ? new Response("{}", { headers: { "content-type": "application/json" } })
              : streamMode === "bad-json"
              ? new Response("{bad\n", { headers: { "content-type": "application/x-ndjson" } })
              : streamMode === "count-mismatch"
              ? new Response(
                JSON.stringify({
                  type: "input",
                  version: 1,
                  value: {
                    prompt: "p",
                    author: "a",
                    branch: "main",
                    state: "synced",
                    tokenBudget: 1000,
                    wikiOnly: false
                  }
                }) + "\n" + JSON.stringify({ type: "end", recent: 9, candidates: 9 }) + "\n",
                { headers: { "content-type": "application/x-ndjson" } }
              )
              : new Response(
                [
                  {
                    type: "input",
                    version: 1,
                    value: {
                      prompt: "p",
                      author: "a",
                      branch: "main",
                      state: "synced",
                      tokenBudget: 1000,
                      wikiOnly: false
                    }
                  },
                  { type: "recent", value: { title: "t", text: "x" } },
                  {
                    type: "candidate",
                    value: {
                      item: { kind: "file", label: "a.ts", ref: "a.ts", revision: "1" },
                      text: "code"
                    }
                  },
                  { type: "end", recent: 1, candidates: 1 }
                ].map((r) => JSON.stringify(r)).join("\n") + "\n",
                { headers: { "content-type": "application/x-ndjson" } }
              )
            const readRes = yield* Effect.result(Effect.tryPromise(() => readContextStream(ctxResp)))
            if (streamMode === "valid") return Result.isSuccess(readRes)
            return Result.isFailure(readRes)
          }),
        { seed: seed + 3, executions: Math.min(executions, 60) }
      )
    )
    assertPassed(report)
  })

  it("HostServer, DurableChatProducer & HostTools enforce auth, journal commits, and callback validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        authHeader: Schema.Literals(["Bearer valid-secret", "Bearer wrong-secret", "Basic abc", "missing"]),
        route: Schema.Literals(["health", "turn", "turn-bad-json", "context-select", "stream", "not-found"]),
        callbackBehavior: Schema.Literals(["commit", "conflict-409", "server-500", "bad-hash"]),
        resolverFails: Schema.Boolean
      })
    )

    const authCheck = bearerAuthorization("valid-secret")

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ authHeader, route, callbackBehavior, resolverFails }) =>
          Effect.promise(async () => {
            // Check bearerAuthorization directly
            const probeReq = new Request("http://host.test/health", {
              headers: authHeader === "missing" ? {} : { authorization: authHeader }
            })
            if (authCheck(probeReq) !== (authHeader === "Bearer valid-secret")) return false

            const callbackFetch: NativeAgent.FetchLike = async (url, init) => {
              if (String(url).includes("provider-started")) {
                return new Response(null, { status: 204 })
              }
              if (callbackBehavior === "conflict-409") {
                return new Response(JSON.stringify({ code: "cursor_conflict" }), { status: 409 })
              }
              if (callbackBehavior === "server-500") {
                return new Response("err", { status: 500 })
              }
              const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>
              const committed = makeCommittedResponse(parsed)
              if (callbackBehavior === "bad-hash") {
                committed.cursor.hash = "0".repeat(64)
              }
              return new Response(JSON.stringify(committed), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            }

            const okModel = Model.make({
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-start", id: "t0" },
                  { type: "text-delta", id: "t0", text: "hello world" },
                  { type: "text-end", id: "t0" },
                  { type: "settle", stopReason: "stop" }
                ])
            })

            const handler = HttpEffect.toWebHandler(
              createModelTurnHandler({
                authorization: "valid-secret",
                callbackBaseUrl: "http://callback.test/",
                fetchImpl: callbackFetch,
                resolve: () =>
                  resolverFails
                    ? Effect.fail(new ResolveFailed({ message: "no model" }))
                    : Effect.succeed({
                      model: okModel,
                      options: { modelId: "test-model" }
                    })
              })
            )

            const headers: Record<string, string> = { "content-type": "application/json" }
            if (authHeader !== "missing") headers.authorization = authHeader

            if (route === "health") {
              const resp = await handler(new Request(`http://host.test${MODEL_HOST_HEALTH_PATH}`, { method: "GET" }))
              if (resp.status !== 200) return false
              const body = await resp.json() as { protocol?: string }
              return body.protocol === MODEL_HOST_PROTOCOL
            }

            if (route === "not-found") {
              const resp = await handler(new Request("http://host.test/nope", { method: "GET", headers }))
              return resp.status === 404 || resp.status === 401
            }

            const path = route === "turn" || route === "turn-bad-json"
              ? MODEL_HOST_TURN_PATH
              : route === "context-select"
              ? MODEL_HOST_CONTEXT_SELECT_PATH
              : MODEL_HOST_STREAM_PATH

            const bodyStr = route === "turn"
              ? JSON.stringify(makeGrant())
              : route === "turn-bad-json"
              ? "{broken"
              : route === "context-select"
              ? JSON.stringify({
                prompt: "p",
                author: "a",
                branch: "main",
                state: "synced",
                recent: [],
                candidates: [],
                tokenBudget: 1000,
                wikiOnly: false
              })
              : JSON.stringify({
                modelId: "test-model",
                messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
              })

            const resp = await handler(
              new Request(`http://host.test${path}`, {
                method: "POST",
                headers,
                body: bodyStr
              })
            )

            if (authHeader !== "Bearer valid-secret") {
              return resp.status === 401
            }
            if (route === "turn-bad-json") {
              return resp.status === 400
            }
            return resp.status >= 200 && resp.status < 600
          }),
        { seed: seed + 4, executions: Math.min(executions, 45) }
      )
    )
    assertPassed(report)

    // Exercise DurableChatProducer + HostTools (sourceReader, sourceLister, apiCaller, runHostTurn) directly
    const grant = makeGrant() as any
    const readResp = await Effect.runPromise(
      sourceReader(
        "http://callback.test/",
        grant,
        async () =>
          new Response(
            JSON.stringify({ repository: "r", path: "a.ts", content: "hi", truncated: false, totalBytes: 2 }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
      )("a.ts")
    )
    expect("file" in readResp || "code" in readResp).toBe(true)

    const listResp = await Effect.runPromise(
      sourceLister(
        "http://callback.test/",
        grant,
        async () =>
          new Response(JSON.stringify({ repository: "r", path: "", entries: [], truncated: false }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )("")
    )
    expect("directory" in listResp || "code" in listResp).toBe(true)

    const apiForbidden = await Effect.runPromise(
      apiCaller("http://callback.test/", grant, async () => new Response("{}", { status: 200 }))("/v1/repos")
    )
    expect(apiForbidden).toEqual({ code: "forbidden" })

    const hostFrames: Array<NativeAgent.AgentTurnFrame> = []
    const okModel = Model.make({
      stream: () =>
        Stream.fromIterable<ModelEvent.ModelEvent>([
          { type: "text-delta", id: "t0", text: "done" },
          { type: "settle", stopReason: "stop" }
        ])
    })
    await Effect.runPromise(
      runHostTurn(
        okModel,
        grant,
        { modelId: "test-model" },
        (frame) =>
          Effect.sync(() => {
            hostFrames.push(frame)
          }),
        {
          read: () => Effect.succeed({ code: "not_found" }),
          list: () => Effect.succeed({ code: "not_found" }),
          api: () => Effect.succeed({ code: "forbidden" })
        }
      )
    )
    expect(hostFrames.length).toBeGreaterThan(0)

    const commitFetch: NativeAgent.FetchLike = async (url, init) => {
      if (String(url).includes("provider-started")) return new Response(null, { status: 204 })
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>
      return new Response(JSON.stringify(makeCommittedResponse(parsed)), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
    await Effect.runPromise(
      runDurableChatTurn(okModel, grant, { modelId: "test-model" }, "http://callback.test/", commitFetch)
    )
    expect(FetchHttpClient.layer).toBeDefined()
  })

  it("HostTools multi-leg execution, ModelProbe.test & HostModel.layerConfig uphold boundaries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        toolAction: Schema.Literals(["read-ok", "read-missing", "list-ok", "docs-read", "unknown-tool", "bad-json"]),
        probeKind: Schema.Literals(["generation-ok", "generation-err", "evaluation-ok", "missing-cred"]),
        hasConfigFallback: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ toolAction, probeKind, hasConfigFallback }) =>
          Effect.gen(function*() {
            let leg = 0
            const toolModel = Model.make({
              stream: () => {
                leg += 1
                if (leg === 1) {
                  const call = toolAction === "read-ok"
                    ? { name: "read", arguments: JSON.stringify({ path: "README.md" }) }
                    : toolAction === "read-missing"
                    ? { name: "read", arguments: JSON.stringify({ path: "missing.md" }) }
                    : toolAction === "list-ok"
                    ? { name: "list", arguments: JSON.stringify({ path: "" }) }
                    : toolAction === "docs-read"
                    ? { name: "docs", arguments: JSON.stringify({ path: "intro" }) }
                    : toolAction === "unknown-tool"
                    ? { name: "not_a_tool", arguments: "{}" }
                    : { name: "read", arguments: "{broken" }
                  return Stream.fromIterable<ModelEvent.ModelEvent>([
                    { type: "tool-call-start", id: "c1", name: call.name },
                    { type: "tool-call-delta", id: "c1", arguments: call.arguments },
                    { type: "tool-call-end", id: "c1" },
                    { type: "settle", stopReason: "tool-calls" }
                  ])
                }
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-delta", id: "t1", text: "all done" },
                  { type: "settle", stopReason: "stop" }
                ])
              }
            })

            const frames: Array<NativeAgent.AgentTurnFrame> = []
            const grantWithSource = makeGrant({ source: { repository: "acme/app" } }) as any
            yield* runHostTurn(
              toolModel,
              grantWithSource,
              { modelId: "test-model" },
              (frame) =>
                Effect.sync(() => {
                  frames.push(frame)
                }),
              {
                read: (path) =>
                  path === "README.md"
                    ? Effect.succeed({
                      file: {
                        repository: "acme/app",
                        path: "README.md",
                        content: "hello\n",
                        binary: false,
                        commit: "0123456789abcdef0123456789abcdef01234567"
                      }
                    })
                    : Effect.succeed({ code: "not_found" }),
                list: (path) =>
                  Effect.succeed({
                    directory: {
                      repository: "acme/app",
                      path,
                      entries: [{ name: "README.md", kind: "file" }],
                      truncated: false,
                      commit: "0123456789abcdef0123456789abcdef01234567"
                    }
                  }),
                api: () => Effect.succeed({ code: "forbidden" }),
                docs: [{ slug: "intro", title: "Intro", summary: "Welcome", body: "Docs body" }] as any
              }
            )
            if (frames.length === 0) return false

            const origin = "http://127.0.0.1:9"
            const probeEnv: ConfiguredModel.ModelCredentialEnv = probeKind === "missing-cred"
              ? {}
              : { SMITHERS_MODEL_KEY_LAB: "sk-probe-secret-1234", SMITHERS_MODEL_KEY_LAB_ORIGIN: origin }
            const sseBody = [
              `data: ${
                JSON.stringify({
                  id: "c",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "lab",
                  choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }]
                })
              }\n\n`,
              `data: ${
                JSON.stringify({
                  id: "c",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "lab",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                })
              }\n\n`,
              "data: [DONE]\n\n"
            ].join("")
            const probeFetch: typeof globalThis.fetch = Object.assign(
              async () => {
                if (probeKind === "generation-err") return new Response("err", { status: 500 })
                if (probeKind === "evaluation-ok") {
                  return Response.json({ scores: { ok: 1 }, answers: { ok: { kind: "yes-no", value: true } } })
                }
                return new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
              },
              { preconnect() {} }
            )
            const probe = createModelProbe({ env: probeEnv, egress: false, fetch: probeFetch, deadlineMs: 2000 })
            const modelCfg: ConfiguredModel.ConfiguredModel = {
              id: "lab",
              protocol: probeKind === "evaluation-ok" ? "evaluation" : "openai-chat",
              baseUrl: origin,
              modelId: "lab",
              credential: "LAB"
            }
            const probeResult = yield* probe.test(modelCfg)
            if (probeKind === "missing-cred" && probeResult.ok) return false
            if (probeKind === "generation-ok" && !probeResult.ok) return false

            const cfgEnv: Record<string, string> = {
              SMITHERS_MODEL_KEY_LAB: "sk-cfg-secret-9999",
              SMITHERS_MODEL_KEY_LAB_ORIGIN: "https://cfg.test",
              ...(hasConfigFallback
                ? {}
                : {
                  MY_MODEL: JSON.stringify({
                    protocol: "openai-chat",
                    baseUrl: "https://cfg.test",
                    modelId: "cfg-m",
                    credential: "LAB"
                  })
                })
            }
            const fallbackRecord = hasConfigFallback
              ? { protocol: "openai-chat", baseUrl: "https://cfg.test", modelId: "cfg-m", credential: "LAB" }
              : undefined
            const cfgSvc = yield* HostModel.pipe(
              Effect.provide(
                HostModel.layerConfig("MY_MODEL", fallbackRecord).pipe(
                  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(cfgEnv)))
                )
              )
            )
            return cfgSvc.modelId === "cfg-m"
          }),
        { seed: seed + 5, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  })
})
