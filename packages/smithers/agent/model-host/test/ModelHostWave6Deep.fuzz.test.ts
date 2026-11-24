import { Fuzz } from "@smthrs/fuzz"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { AgentTurnJournal, type NativeAgent } from "@smthrs/rpc"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import * as HttpEffect from "effect/http/HttpEffect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { bearerAuthorization, MODEL_HOST_PROTOCOL } from "../src/HostServer.ts"
import { SOURCE_LIST_PATH, SOURCE_READ_PATH } from "../src/HostTools.ts"
import type { DurableChatGrant } from "./fixtures/durable.ts"
import { createModelTurnHandler, runDurableChatTurn } from "./fixtures/durable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

const makeGrant = (extra: Partial<DurableChatGrant> = {}): DurableChatGrant => ({
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run",
  legId: "leg",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor: {
    version: 1,
    runId: "run",
    legId: "leg",
    batch: 0,
    position: 0,
    hash: "a".repeat(64)
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: {
    runId: "run",
    instructions: "Answer briefly.",
    messages: [{ role: "user", content: "Inspect repository" }]
  },
  producerBaseUrl: "http://callback.test/",
  source: { repository: "acme/app" },
  ...extra
})

const makeProducer = (options: {
  readonly readCode?: string | undefined
  readonly listCode?: string | undefined
  readonly binaryFile?: boolean
  readonly longFile?: boolean
  readonly apiStatus?: number
  readonly apiBody?: unknown
  readonly commitStatus?: number
} = {}) => {
  const frames: Array<NativeAgent.AgentTurnFrame> = []
  const reads: Array<string> = []
  const lists: Array<string> = []
  const apiCalls: Array<string> = []
  let expected: AgentTurnJournal.AgentTurnCursor = {
    version: 1,
    runId: "run",
    legId: "leg",
    batch: 0,
    position: 0,
    hash: "a".repeat(64)
  }

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const raw = typeof init?.body === "string" ? init.body : "{}"
    const body = raw ? JSON.parse(raw) : {}
    if (url.pathname.endsWith("/provider-started")) {
      return new Response(null, { status: 204 })
    }
    if (url.pathname === SOURCE_READ_PATH) {
      const p = String(body.path ?? "")
      reads.push(p)
      if (options.readCode) {
        return Response.json({ code: options.readCode }, { status: 400 })
      }
      const content = options.longFile ? "line\n".repeat(4000) : "hello from " + p
      return Response.json({
        repository: "acme/app",
        path: p,
        commit: COMMIT,
        content,
        binary: options.binaryFile === true
      })
    }
    if (url.pathname === SOURCE_LIST_PATH) {
      const p = String(body.path ?? "")
      lists.push(p)
      if (options.listCode) {
        return Response.json({ code: options.listCode }, { status: 400 })
      }
      return Response.json({
        repository: "acme/app",
        path: p,
        commit: COMMIT,
        entries: [
          { name: "README.md", kind: "file" },
          { name: "src", kind: "dir" }
        ],
        truncated: false
      })
    }
    if (url.pathname.startsWith("/api/")) {
      apiCalls.push(url.pathname)
      return Response.json(options.apiBody ?? [], { status: options.apiStatus ?? 200 })
    }
    if (options.commitStatus && options.commitStatus !== 200) {
      return Response.json({ error: "commit_refused" }, { status: options.commitStatus })
    }
    const batchFrames = (body.frames ?? []) as Array<NativeAgent.AgentTurnFrame>
    frames.push(...batchFrames)
    const exp = (body.expected ?? expected) as AgentTurnJournal.AgentTurnCursor
    const unsigned = {
      version: 1 as const,
      runId: exp.runId,
      legId: exp.legId,
      batch: exp.batch + 1,
      from: exp.position + 1,
      previousHash: exp.hash,
      frames: batchFrames
    }
    const hash = createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned)).digest(
      "hex"
    )
    expected = {
      version: 1,
      runId: exp.runId,
      legId: exp.legId,
      batch: unsigned.batch,
      position: exp.position + batchFrames.length,
      hash
    }
    return Response.json({ status: "committed", batch: { ...unsigned, hash }, cursor: expected })
  }) as typeof fetch

  return { frames, reads, lists, apiCalls, fetchImpl: fetchImpl as typeof fetch }
}

const scriptedModel = (calls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>) =>
  Model.make({
    stream: (request: ModelRequest.ModelRequest) => {
      const results = request.messages.flatMap((m) => (m.role === "tool" ? [m] : []))
      const call = calls[results.length]
      if (call === undefined) {
        const events: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "text-delta", id: "t", text: "Done answering." },
          { type: "usage", inputTokens: 12, outputTokens: 4, cachedInputTokens: 2 },
          { type: "settle", stopReason: "stop" }
        ]
        return Stream.fromIterable(events)
      }
      const id = `call-${results.length}`
      const events: ReadonlyArray<ModelEvent.ModelEvent> = [
        { type: "tool-call-start", id, name: call.name },
        { type: "tool-call-end", id, arguments: call.arguments },
        { type: "usage", inputTokens: 8, outputTokens: 2 },
        { type: "settle", stopReason: "tool-calls" }
      ]
      return Stream.fromIterable(events)
    }
  })

describe("@smthrs/model-host Wave 6 deep fuzz (HostTools, DurableChatProducer, HostServer)", () => {
  it(
    "HostTools + DurableChatProducer execute /file, /files, commands list/run, refusal codes, binary/long truncation, invalid tool args, and unknown tools safely",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "readOk",
            "readBinary",
            "readLong",
            "readNotFound",
            "readPathRefused",
            "readForbidden",
            "readTooLarge",
            "readNotReady",
            "listRoot",
            "listRefused",
            "listNotFound",
            "cmdList",
            "cmdListNamespace",
            "badJsonArgs",
            "nonObjectArgs",
            "missingAction",
            "unknownTool",
            "noSourceGrant",
            "tooManyLegs"
          ]),
          pathArg: Schema.Literals(["README.md", "./README.md", "acme/app/README.md", "README.md#L1-L5"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scenario, pathArg }) =>
            Effect.promise(async () => {
              const readCode = scenario === "readNotFound" ?
                "not_found"
                : scenario === "readPathRefused" ?
                "path_refused"
                : scenario === "readForbidden" ?
                "forbidden"
                : scenario === "readTooLarge" ?
                "too_large"
                : scenario === "readNotReady" ?
                "source_not_ready"
                : undefined
              const listCode = scenario === "listRefused" ?
                "path_refused"
                : scenario === "listNotFound" ?
                "not_found"
                : undefined

              const prod = makeProducer({
                readCode,
                listCode,
                binaryFile: scenario === "readBinary",
                longFile: scenario === "readLong"
              })

              const calls = scenario.startsWith("read")
                ? [{ name: "commands", arguments: JSON.stringify({ action: "execute", name: "file", args: pathArg }) }]
                : scenario.startsWith("list")
                ? [{ name: "commands", arguments: JSON.stringify({ action: "execute", name: "files", args: "." }) }]
                : scenario === "cmdList"
                ? [{ name: "commands", arguments: JSON.stringify({ action: "list" }) }]
                : scenario === "cmdListNamespace"
                ? [{ name: "commands", arguments: JSON.stringify({ action: "list", namespace: "file" }) }]
                : scenario === "badJsonArgs"
                ? [{ name: "commands", arguments: "{broken" }]
                : scenario === "nonObjectArgs"
                ? [{ name: "commands", arguments: "[]" }]
                : scenario === "missingAction"
                ? [{ name: "commands", arguments: JSON.stringify({ action: "run" }) }]
                : scenario === "unknownTool"
                ? [{ name: "shell", arguments: JSON.stringify({ command: "id" }) }]
                : scenario === "tooManyLegs"
                ? Array.from(
                  { length: 12 },
                  () => ({ name: "commands", arguments: JSON.stringify({ action: "list" }) })
                )
                : []

              const baseGrant = makeGrant()
              const { source: _drop, ...noSource } = baseGrant
              const grant: DurableChatGrant = scenario === "noSourceGrant" ? noSource : baseGrant
              const m = scriptedModel(calls)
              await Effect.runPromise(
                runDurableChatTurn(m, grant, { modelId: "m" }, "http://callback.test", prod.fetchImpl)
              )
              expect(prod.frames.length).toBeGreaterThanOrEqual(1)
              // Renderer never sees an unhandled host tool_call frame
              expect(prod.frames.some((f) => f.type === "tool_call")).toBe(false)
              return true
            }),
          { executions: Math.min(executions, 60), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "HostServer handles health, bearer auth, /v1/chat/turn, /v1/model/stream, /v1/context/select, bad methods/routes, empty/oversize bodies, and resolver failures",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          route: Schema.Literals([
            "health",
            "turnOk",
            "turnNoAuth",
            "turnWrongAuth",
            "turnBadMethod",
            "turnEmptyBody",
            "turnBadJson",
            "streamOk",
            "streamBadMethod",
            "streamResolveFail",
            "contextSelect",
            "unknownRoute"
          ]),
          ownerId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ route, ownerId }) =>
            Effect.promise(async () => {
              const authCheck = bearerAuthorization("host-secret-tok")
              expect(
                authCheck(new Request("http://h.test/x", { headers: { authorization: "Bearer host-secret-tok" } }))
              ).toBe(true)
              expect(authCheck(new Request("http://h.test/x", { headers: { authorization: "Bearer wrong" } }))).toBe(
                false
              )

              const prod = makeProducer()
              const handler = HttpEffect.toWebHandler(createModelTurnHandler({
                installOrigin: "http://127.0.0.1:4567",
                authorization: "host-secret-tok",
                callbackBaseUrl: "http://callback.test",
                resolve: () =>
                  route === "streamResolveFail"
                    ? Effect.fail(
                      {
                        _tag: "ModelResolutionError",
                        stage: "lookup",
                        code: "no_model",
                        message: "secret internal detail"
                      } as never
                    )
                    : Effect.succeed({
                      model: scriptedModel([]),
                      options: { modelId: "fixture" }
                    }),
                fetchImpl: prod.fetchImpl
              }))

              const authHeaders = { authorization: "Bearer host-secret-tok", "content-type": "application/json" }
              if (route === "health") {
                const res = await handler(new Request("http://h.test/health"))
                expect(res.status).toBe(200)
                expect(await res.json()).toEqual({ protocol: MODEL_HOST_PROTOCOL })
              } else if (route === "turnOk") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify(makeGrant({ ownerId }))
                  })
                )
                if (res.status !== 204) throw new Error(`turnOk status=${res.status} body=${await res.text()}`)
                expect(res.status).toBe(204)
              } else if (route === "turnNoAuth") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", {
                    method: "POST",
                    body: JSON.stringify(makeGrant({ ownerId }))
                  })
                )
                expect(res.status).toBe(401)
              } else if (route === "turnWrongAuth") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", {
                    method: "POST",
                    headers: { authorization: "Bearer nope" },
                    body: JSON.stringify(makeGrant({ ownerId }))
                  })
                )
                expect(res.status).toBe(401)
              } else if (route === "turnBadMethod") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", { method: "GET", headers: authHeaders })
                )
                expect(res.status).toBe(405)
              } else if (route === "turnEmptyBody") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", { method: "POST", headers: authHeaders, body: "" })
                )
                expect(res.status).toBe(400)
              } else if (route === "turnBadJson") {
                const res = await handler(
                  new Request("http://h.test/v1/chat/turn", { method: "POST", headers: authHeaders, body: "{nope" })
                )
                expect(res.status).toBe(400)
              } else if (route === "streamOk") {
                const res = await handler(
                  new Request("http://h.test/v1/model/stream", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                      runId: "r1",
                      ownerId,
                      instructions: "hi",
                      messages: [{ role: "user", content: "yo" }]
                    })
                  })
                )
                expect(res.status).toBe(200)
                const txt = await res.text()
                expect(txt.length).toBeGreaterThan(0)
              } else if (route === "streamBadMethod") {
                const res = await handler(
                  new Request("http://h.test/v1/model/stream", { method: "GET", headers: authHeaders })
                )
                expect(res.status).toBe(405)
              } else if (route === "streamResolveFail") {
                const res = await handler(
                  new Request("http://h.test/v1/model/stream", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                      runId: "r1",
                      ownerId,
                      instructions: "hi",
                      messages: [{ role: "user", content: "yo" }]
                    })
                  })
                )
                expect(res.status).toBeGreaterThanOrEqual(400)
                const txt = await res.text()
                expect(txt).not.toContain("secret internal detail")
              } else if (route === "contextSelect") {
                const res = await handler(
                  new Request("http://h.test/v1/context/select", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({ ownerId, prompt: "hello", items: [{ id: "1", text: "item 1" }] })
                  })
                )
                expect([200, 400, 404, 501]).toContain(res.status)
              } else {
                const res = await handler(new Request("http://h.test/nope", { headers: authHeaders }))
                expect(res.status).toBe(404)
              }
              return true
            }),
          { executions: Math.min(executions, 50), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
