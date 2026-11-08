/**
 * A ChatGPT-subscription seat end to end (#3808): the seat calls the ChatGPT
 * backend directly, signed with the local Codex login. The run's cache key
 * reaches every request as the cache key and the session id, reasoning items
 * return with the next call, and a 401 has the Codex CLI refresh its own login
 * before one retry. Every token in these fixtures is fabricated.
 */
import { Seat } from "@smthrs/agent"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Application from "../src/Application.vibe"
import * as NodeControl from "../src/NodeControl.ts"
import { liveModel } from "./support/liveModel.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** A syntactically valid JWT whose payload carries only the given expiry. */
const jwt = (marker: string, expiresInSeconds = 3600): string =>
  `eyJhbGciOiJub25lIn0.${
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, marker })).toString("base64url")
  }.signature`

/** A machine with a Codex login, and optionally a `codex` on its `PATH`. */
const machine = (login: unknown, codex?: string) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-codex-seat-"))
  roots.push(root)
  if (login !== undefined) writeFileSync(join(root, "auth.json"), JSON.stringify(login), { mode: 0o600 })
  if (codex !== undefined) writeFileSync(join(root, "codex"), `#!${process.execPath}\n${codex}`, { mode: 0o755 })
  return { root, environment: { PATH: root, HOME: root, CODEX_HOME: root } as Record<string, string | undefined> }
}

const subscription = (access: string) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "fake-id", access_token: access, refresh_token: "fake-refresh", account_id: "acct-fake" },
  last_refresh: "2026-10-01T00:00:00.000000Z"
})

const sse = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const completed = (text: string, usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 7 }) => [
  { type: "response.output_text.delta", item_id: "msg_1", delta: text },
  { type: "response.completed", response: { id: "resp_1", usage } }
]

interface Sent {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown>
}

/** The model transport, scripted: records each request and answers it with the next reply. */
const backend = (
  replies: ReadonlyArray<
    | { readonly events: ReadonlyArray<unknown>; readonly headers?: Readonly<Record<string, string>> }
    | ModelError
  >
) => {
  const sent: Array<Sent> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request: HttpClientRequest.HttpClientRequest) => {
      const reply = replies[Math.min(sent.length, replies.length - 1)]!
      sent.push({
        url: request.url,
        headers: { ...request.headers },
        body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {}
      })
      return reply instanceof ModelError
        ? Effect.fail(reply)
        : Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(sse(reply.events), {
            status: 200,
            headers: { "content-type": "text/event-stream", ...reply.headers }
          })
        ))
    }
  })
  return { sent, executor }
}

const unused = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("model transport was not expected"))
})

const resolve = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor = unused,
  seat = "codex:sol"
) => Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

const request = (overrides: Partial<ModelRequest.ModelRequest> = {}) =>
  ModelRequest.ModelRequest.make({
    modelId: "gpt-6.1-sol",
    system: [ModelRequest.SystemPart.make({ text: "Write a cell." })],
    messages: [ModelRequest.Message.user("first frame")],
    tools: [],
    toolChoice: "none",
    params: ModelRequest.GenerationParams.make({ reasoningEffort: "xhigh" }),
    cacheKey: "smithers-run-1",
    ...overrides
  })

const collect = (seat: Seat.Seat, input: ModelRequest.ModelRequest) =>
  Effect.runPromise(
    Effect.scoped(Stream.runCollect(seat.model.stream(input))).pipe(Effect.map((events) => Array.from(events)))
  )

describe("Codex subscription seat on the direct route", () => {
  it("signs with the login's token and account, and sends the run's key as cache key and session id", async () => {
    const access = jwt("signed-in")
    const { environment } = machine(subscription(access))
    const { sent, executor } = backend([{ events: completed("```cell\nreturn 2\n```") }])
    const seat = await Effect.runPromise(resolve({ ...environment, OPENAI_API_KEY: "ambient-key" }, executor))

    const events = await collect(seat, request())

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(sent[0]!.headers).toMatchObject({
      authorization: `Bearer ${access}`,
      "chatgpt-account-id": "acct-fake",
      "session-id": "smithers-run-1",
      originator: "codex_cli_rs"
    })
    expect(sent[0]!.body).toMatchObject({
      model: "gpt-6.1-sol",
      instructions: "Write a cell.",
      prompt_cache_key: "smithers-run-1",
      reasoning: { effort: "xhigh", summary: "auto" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"]
    })
    // The ambient API key never signs a subscription seat, and the refresh token never leaves the file.
    expect(JSON.stringify(sent)).not.toContain("ambient-key")
    expect(JSON.stringify(sent)).not.toContain("fake-refresh")
    const settled = ModelEvent.ModelEvent.settledMessage(events)
    expect(settled.message.content).toEqual([{ type: "text", text: "```cell\nreturn 2\n```" }])
    expect(settled.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 })
  })

  it("carries reasoning items into the next call of the same session and counts the cached input", async () => {
    const { environment } = machine(subscription(jwt("signed-in")))
    const { sent, executor } = backend([
      {
        headers: { "x-codex-turn-state": "turn-state-1" },
        events: [
          {
            type: "response.output_item.done",
            item: {
              id: "rs_1",
              type: "reasoning",
              summary: [{ type: "summary_text", text: "plan" }],
              encrypted_content: "opaque-reasoning-state"
            }
          },
          ...completed("first answer", {
            input_tokens: 9_000,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 30 }
          })
        ]
      },
      {
        events: completed("second answer", {
          input_tokens: 9_500,
          input_tokens_details: { cached_tokens: 9_216 },
          output_tokens: 12
        })
      }
    ])
    // One resolve per frame, as the agent step does: the session must not depend on a retained model object.
    const key = `smithers-carry-${Math.random()}`
    const first = await collect(await Effect.runPromise(resolve(environment, executor)), request({ cacheKey: key }))
    const settled = ModelEvent.ModelEvent.settledMessage(first)
    const second = await collect(
      await Effect.runPromise(resolve(environment, executor)),
      request({
        cacheKey: key,
        messages: [
          ModelRequest.Message.user("first frame"),
          settled.message,
          ModelRequest.Message.user("second frame")
        ]
      })
    )

    expect(sent).toHaveLength(2)
    // One session: the same key in the body and the header of both calls, and the backend's routing token echoed.
    expect(sent.map((call) => call.body.prompt_cache_key)).toEqual([key, key])
    expect(sent.map((call) => call.headers["session-id"])).toEqual([key, key])
    expect(sent.map((call) => call.headers["x-codex-turn-state"])).toEqual([undefined, "turn-state-1"])
    // The second request extends the first and replays its reasoning item whole.
    expect(sent[1]!.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "first frame" }] },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "plan" }],
        encrypted_content: "opaque-reasoning-state"
      },
      { role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
      { role: "user", content: [{ type: "input_text", text: "second frame" }] }
    ])
    // Reasoning is inside the output count, never added to it.
    expect(settled.usage).toMatchObject({ inputTokens: 9_000, outputTokens: 40, reasoningTokens: 30 })
    expect(ModelEvent.ModelEvent.settledMessage(second).usage).toMatchObject({
      inputTokens: 9_500,
      cachedInputTokens: 9_216,
      outputTokens: 12
    })
  })

  it("after a 401 has the Codex CLI refresh its own login and retries once with the new token", async () => {
    const revoked = jwt("revoked")
    const rotated = jwt("rotated")
    const { root, environment } = machine(
      subscription(revoked),
      `const fs = require("node:fs"), path = require("node:path")
fs.appendFileSync(path.join(path.dirname(process.argv[1]), "argv"), process.argv.slice(2).join(" ") + "\\n")
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  if (!chunk.includes("account/read")) return
  const file = path.join(process.env.CODEX_HOME, "auth.json")
  const login = JSON.parse(fs.readFileSync(file, "utf8"))
  login.tokens.access_token = ${JSON.stringify(rotated)}
  login.tokens.refresh_token = "rotated-by-codex"
  fs.writeFileSync(file, JSON.stringify(login))
  process.stdout.write(JSON.stringify({ id: 1, result: { account: null, requiresOpenaiAuth: false } }) + "\\n")
})
`
    )
    const { sent, executor } = backend([
      new ModelError({ code: "authentication", message: "401" }),
      { events: completed("after refresh") }
    ])
    const seat = await Effect.runPromise(resolve(environment, executor))

    const events = await collect(seat, request())

    expect(sent.map((call) => call.headers.authorization)).toEqual([`Bearer ${revoked}`, `Bearer ${rotated}`])
    expect(readFileSync(join(root, "argv"), "utf8")).toBe("app-server --listen stdio://\n")
    expect(ModelEvent.ModelEvent.settledMessage(events).message.content).toEqual([{
      type: "text",
      text: "after refresh"
    }])
  })

  it("fails a call typed when the login stays refused and Codex is not installed", async () => {
    const { environment } = machine(subscription(jwt("revoked")))
    const { sent, executor } = backend([new ModelError({ code: "authentication", message: "401" })])
    const seat = await Effect.runPromise(resolve(environment, executor))

    const failure = await Effect.runPromise(
      Effect.flip(Effect.scoped(Stream.runCollect(seat.model.stream(request()))))
    )

    expect(sent).toHaveLength(1)
    expect(failure).toMatchObject({ code: "authentication", message: expect.stringContaining("codex login") })
  })

  it("refuses an output cap before the request leaves, because the subscription backend takes none", async () => {
    const { environment } = machine(subscription(jwt("signed-in")))
    const { sent, executor } = backend([{ events: completed("unreached") }])
    const seat = await Effect.runPromise(resolve(environment, executor))

    const failure = await Effect.runPromise(Effect.flip(Effect.scoped(Stream.runCollect(
      seat.model.stream(request({ params: ModelRequest.GenerationParams.make({ maxTokens: 512 }) }))
    ))))

    expect(failure).toMatchObject({ code: "invalid_request" })
    expect(sent).toEqual([])
  })
})

describe("Codex subscription seat resolution", () => {
  it("keeps codex:sol as its journal identity and prepares a credential-free direct route", async () => {
    const access = jwt("signed-in")
    const { environment } = machine(subscription(access))
    const seat = await Effect.runPromise(resolve(environment))
    expect(seat.id).toBe("codex:sol")
    expect(seat.modelId).toBe("gpt-6.1-sol")
    expect(seat.contextWindowTokens).toBeGreaterThanOrEqual(128_000)
    const prepared = await Effect.runPromise(seat.route.prepare(request()))
    expect(prepared.routeId).toBe("openai-chatgpt")
    expect(prepared.protocolId).toBe("openai-responses-chatgpt")
    expect(prepared.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(JSON.stringify(prepared)).not.toContain(access)
    expect(JSON.stringify(prepared)).not.toContain("acct-fake")
  })

  it("starts no vendor process to resolve a seat", async () => {
    const { root, environment } = machine(
      subscription(jwt("signed-in")),
      "require('node:fs').appendFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'argv'), 'started\\n')\n"
    )
    await Effect.runPromise(resolve(environment))
    await Effect.runPromise(resolve(environment, unused, "codex:luna"))
    expect(() => readFileSync(join(root, "argv"))).toThrow()
  })

  it.each([
    ["no login file", undefined, "no ChatGPT login at"],
    ["an API-key login", { auth_mode: "apikey", OPENAI_API_KEY: "sk-fake" }, "an API-key login cannot serve this seat"]
  ])("refuses %s with a typed, actionable device-login instruction", async (_state, login, reason) => {
    const { root, environment } = machine(login, "process.exit(0)\n")
    const failure = await Effect.runPromise(Effect.flip(resolve(environment)))
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.seat).toBe("codex:sol")
    expect(failure.message).toBe(
      `run \`codex login --device-auth\` to run the codex:sol seat: ${
        login === undefined
          ? `${reason} ${join(root, "auth.json")}`
          : `${join(root, "auth.json")} holds no ChatGPT login (${reason})`
      }`
    )
    expect(failure.message).not.toContain("sk-fake")
  })

  it("names the Codex install when neither a login nor the CLI is present", async () => {
    const { environment } = machine(undefined)
    const failure = await Effect.runPromise(Effect.flip(resolve(environment)))
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.message).toContain("install Codex, then run `codex login --device-auth`")
  })

  it("maps a template recording's signed-out refusal to a typed model authentication error without HTTP", async () => {
    const { root } = machine(undefined)
    vi.stubEnv("PATH", root)
    vi.stubEnv("HOME", root)
    vi.stubEnv("CODEX_HOME", root)
    vi.stubEnv("OPENAI_API_KEY", undefined)
    vi.stubEnv("SMITHERS_OPENAI_AUTH", undefined)
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("A signed-out Codex seat must not call HTTP")
    })
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(liveModel("codex:sol").stream(request()))))
    expect(failure).toMatchObject({ code: "authentication", message: expect.stringContaining("codex") })
    expect(failure).not.toBeInstanceOf(Seat.SeatUnresolved)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("journals the direct route and the seat identity through the real native host", async () => {
    // The login lives outside the workspace, as `~/.codex` does.
    const { environment } = machine(subscription(jwt("signed-in")))
    const root = mkdtempSync(join(tmpdir(), "smithers-codex-workspace-"))
    roots.push(root)
    const { sent, executor } = backend([{ events: completed("```cell\nctx.done(\"journal-ok\")\n```") }])
    mkdirSync(join(root, ".smithers", "flows", "proof"), { recursive: true })
    writeFileSync(
      join(root, ".smithers", "flows", "proof", "flow.mdx"),
      "---\ndescription: Codex journal proof.\nmodel: codex:sol\n---\nReply journal-ok.\n"
    )
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const runs = NodeControl.layerExecutor(registry, engine, root, {
      environment: { ...environment, PATH: `${root}:/usr/bin:/bin` },
      evaluator: ScriptedJudge.layerAll,
      grants: GrantStore.layerNoop,
      requestExecutor: Layer.succeed(RequestExecutor.RequestExecutor)(executor)
    })
    const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const plan = yield* control.plan({ flowId: "proof", input: {} })
        yield* control.approve(plan.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: plan.planId,
          digest: plan.digest,
          envelope: plan.envelope,
          idempotencyKey: "codex-journal"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("Run was not accepted")
        return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) =>
            ["control.run.completed", "control.run.failed", "control.run.cancelled"].includes(event.kind)
          ),
          Stream.runCollect,
          Effect.map((events) => Array.from(events))
        )
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
    expect(events.at(-1)?.kind).toBe("control.run.completed")
    const requested = events.filter((event) => event.kind === "control.agent.model-requested")
    expect(requested.length).toBeGreaterThan(0)
    expect(requested[0]?.payload).toMatchObject({
      seat: "codex:sol",
      routeId: "openai-chatgpt",
      protocolId: "openai-responses-chatgpt"
    })
    // Every frame of the run went out under one session id, the run's cache key.
    const sessions = new Set(sent.map((call) => call.headers["session-id"]))
    expect(sessions.size).toBe(1)
    expect([...sessions][0]).toMatch(/^smithers-/)
    expect(sent.every((call) => call.body.prompt_cache_key === [...sessions][0])).toBe(true)
  })
})
