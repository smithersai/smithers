import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { ExecutionContext, executionContextFrom } from "./Environment"
import { FRONT_DOOR_CALL_PREFIX, FRONT_DOOR_CONFIDENCE_FLOOR } from "./frontDoor"
import { transportLayer } from "./Http"
import {
  memoryRecommendStorage,
  readRecommendLog,
  RECOMMEND_JEV_TIMEOUT_MS,
  RecommendLog,
  recommendLogLayer
} from "./recommend"
import type { RecommendLogRow } from "./recommend"
import { handleTurn, TurnCancelRegistry, turnCancelsLayer } from "./turns"

/*
 * The front door: Jev decides the turn before the chat upstream is paid for
 * it. These tests hold the route to the contract the client already speaks —
 * a routed turn is the tool_call / done pair the concierge would have emitted
 * — and to the three that keep it honest: the upstream is untouched when Jev
 * routes, the upstream answers every turn Jev does not, and the hidden
 * runtime context never leaves this Worker.
 */

const COMMANDS = [
  { name: "runs.list", summary: "See your runs" },
  { name: "repo.open", summary: "Open a repository" },
  { name: "flow.create", summary: "Create a workflow" }
]

const CONTEXT: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 9,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  activeRepository: "smithersai/smithers",
  github: { connected: true, login: "octocat", repositories: 3 },
  worldState: { documentCount: 0, documents: [] },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."]
}

const GATEWAY_KEY = { aiGatewayApiKey: Redacted.make("vck-test") }

const turnBody = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-front-door",
  messages: [{ role: "user", content: "show me my runs" }],
  instructions: "Be brief.",
  commands: COMMANDS,
  context: CONTEXT,
  ...overrides
})

const post = (body: unknown): Request =>
  new Request("https://mvp.test/api/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const ndjsonText = (...frames: ReadonlyArray<unknown>): string =>
  frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")

/** A gateway evaluation: one command choice with its probabilities, and the impossible class. */
const evaluation = (
  choice: string,
  confidence: number,
  impossible = "none"
): Response =>
  new Response(
    JSON.stringify({
      answers: {
        command: { type: "choice", choice, probabilities: { [choice]: confidence } },
        impossible: { type: "choice", choice: impossible }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )

const memoryCancels = (): NativeNamespace => {
  const registries = new Map<string, TurnCancelRegistry>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = registries.get(name)
      if (registry === undefined) {
        registry = new TurnCancelRegistry({ storage: memoryStorage() })
        registries.set(name, registry)
      }
      const object = registry
      return { fetch: (request) => object.fetch(request) }
    }
  }
}

const memoryLog = (): NativeNamespace => {
  const logs = new Map<string, RecommendLog>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new RecommendLog({ storage: memoryRecommendStorage() })
        logs.set(name, log)
      }
      const object = log
      return { fetch: (request) => object.fetch(request) }
    }
  }
}

interface Calls {
  readonly gateway: Array<Request>
  readonly upstream: Array<Request>
}

/**
 * The turn route with its two outbound seams recorded: the AI Gateway (Jev)
 * and the chat upstream. A seam a test does not name must not be reached.
 */
const turn = async (
  body: unknown,
  options: {
    readonly jev?: (request: Request) => Response | Promise<Response>
    readonly config?: Partial<ServerConfigShape>
    readonly logs?: NativeNamespace
  } = {}
): Promise<{ readonly response: Response; readonly calls: Calls }> => {
  const calls: Calls = { gateway: [], upstream: [] }
  const transport = transportLayer(async (input, init) => {
    const request = new Request(input as string, init)
    if (new URL(request.url).hostname === "ai-gateway.vercel.sh") {
      calls.gateway.push(request)
      if (options.jev === undefined) throw new Error("Jev must not be asked")
      return options.jev(request)
    }
    calls.upstream.push(request)
    return new Response(ndjsonText({ type: "delta", kind: "text", text: "upstream" }, { type: "done", reason: "stop" }), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    })
  })
  const response = await Effect.runPromise(
    handleTurn(post(body)).pipe(
      Effect.provide(Layer.mergeAll(
        transport,
        testConfigLayer({ chatUrl: "https://upstream.test/chat", upstreamTimeoutMs: 5_000, ...GATEWAY_KEY, ...options.config }),
        turnCancelsLayer(memoryCancels()),
        recommendLogLayer(options.logs),
        Layer.succeed(ExecutionContext, executionContextFrom(undefined))
      ))
    )
  )
  return { response, calls }
}

const frames = async (response: Response): Promise<Array<Record<string, unknown>>> =>
  (await response.text()).split("\n").filter((line) => line.trim() !== "").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  )

const rowsOf = (logs: NativeNamespace): Promise<ReadonlyArray<RecommendLogRow>> =>
  Effect.runPromise(readRecommendLog().pipe(Effect.provide(recommendLogLayer(logs))))

describe("the Jev front door on POST /api/agent/turn", () => {
  test("a confident command answers the turn with the concierge's own tool-call frames, and the upstream is never called", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody(), { jev: () => evaluation("runs.list", 0.97), logs })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(calls.upstream).toEqual([])
    expect(calls.gateway.length).toBe(1)

    const emitted = await frames(response)
    expect(emitted.length).toBe(2)
    expect(emitted[0]).toMatchObject({
      runId: "run-front-door",
      type: "tool_call",
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "runs.list" })
    })
    expect(String(emitted[0]!.call_id)).toStartWith(FRONT_DOOR_CALL_PREFIX)
    expect(emitted[1]).toEqual({ runId: "run-front-door", type: "done", reason: "tool_call" })

    const rows = await rowsOf(logs)
    expect(rows.length).toBe(1)
    expect(rows[0]!.model).toBe("typesafe-ai/jev")
    expect(rows[0]!.commands).toEqual(["runs.list"])
    expect(rows[0]!.commandCount).toBe(COMMANDS.length)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.97, impossible: "none", routed: true })
    expect(rows[0]!.outcome).toBeNull()
  })

  test("the outbound Jev request carries the repository name and the tail, and never the hidden context", async () => {
    let sent: Record<string, unknown> = {}
    await turn(
      turnBody({
        messages: [
          { role: "user", content: "what does this repo do?" },
          { role: "assistant", content: "It is a control plane." },
          { role: "user", content: "show me my runs" }
        ]
      }),
      {
        jev: (request) => {
          void request.json().then((body) => {
            sent = body as Record<string, unknown>
          })
          return evaluation("runs.list", 0.97)
        }
      }
    )
    // The body is read on the same microtask queue as the response above.
    await Promise.resolve()
    const state = sent.state as { repository: string; conversation: string }
    expect(Object.keys(state).sort()).toEqual(["conversation", "repository"])
    expect(state.repository).toBe("smithersai/smithers")
    expect(state.conversation).toBe(
      "user: what does this repo do?\nassistant: It is a control plane.\nuser: show me my runs"
    )
    const serialized = JSON.stringify(sent)
    expect(serialized).not.toContain("octocat")
    expect(serialized).not.toContain("github")
    expect((sent.providerOptions as { gateway: { zeroDataRetention: boolean } }).gateway.zeroDataRetention).toBe(true)
  })

  test("`none` spends the upstream exactly as before, and the fall-through is logged", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody(), { jev: () => evaluation("none", 0.99, "email"), logs })

    expect(response.status).toBe(200)
    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.commands).toEqual([])
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.99, impossible: "email", routed: false })
  })

  test("a command under the confidence floor goes upstream", async () => {
    const logs = memoryLog()
    const { calls } = await turn(turnBody(), { jev: () => evaluation("runs.list", 0.6), logs })

    expect(0.6).toBeLessThan(FRONT_DOOR_CONFIDENCE_FLOOR)
    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.6, impossible: "none", routed: false })
  })

  test("a choice with no probabilities is an unmeasured lean, so the turn goes upstream", async () => {
    const { calls } = await turn(turnBody(), {
      jev: () =>
        new Response(JSON.stringify({ answers: { command: { type: "choice", choice: "runs.list" } } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    })
    expect(calls.upstream.length).toBe(1)
  })

  test("a refused gateway goes upstream and logs nothing", async () => {
    const logs = memoryLog()
    const { calls } = await turn(turnBody(), { jev: () => new Response("no", { status: 403 }), logs })

    expect(calls.gateway.length).toBe(1)
    expect(calls.upstream.length).toBe(1)
    expect(await rowsOf(logs)).toEqual([])
  })

  test("a gateway that misses the deadline goes upstream", async () => {
    const logs = memoryLog()
    const slow = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(evaluation("runs.list", 0.99)), RECOMMEND_JEV_TIMEOUT_MS * 3)
    })
    const { calls } = await turn(turnBody(), { jev: () => slow, logs })

    expect(calls.gateway.length).toBe(1)
    expect(calls.upstream.length).toBe(1)
    expect(await rowsOf(logs)).toEqual([])
  }, 10_000)

  test("a body without commands goes upstream and Jev is never asked", async () => {
    const { calls } = await turn(turnBody({ commands: undefined }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a malformed command list is dropped, never refused: the turn goes upstream and Jev is never asked", async () => {
    const { response, calls } = await turn(turnBody({ commands: [{ name: "", summary: 7 }] }))
    expect(response.status).toBe(200)
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("with no AI_GATEWAY_API_KEY nothing changes: no gateway call, the upstream answers", async () => {
    const { calls } = await turn(turnBody(), { config: { aiGatewayApiKey: undefined } })
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a tool-loop continuation is never read by Jev", async () => {
    const { calls } = await turn(turnBody({
      messages: [
        { role: "user", content: "show me my runs" },
        { type: "function_call", call_id: "call_1", name: "commands", arguments: "{\"action\":\"list\"}" },
        { type: "function_call_output", call_id: "call_1", output: "{}" }
      ]
    }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a turn whose last message is the assistant's is not a front-door turn", async () => {
    const { calls } = await turn(turnBody({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]
    }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("the leg answering this Worker's own tool call is answered here: the command's name, then stop", async () => {
    const callId = `${FRONT_DOOR_CALL_PREFIX}b0a1`
    const { response, calls } = await turn(turnBody({
      messages: [
        { role: "user", content: "show me my runs" },
        { type: "function_call", call_id: callId, name: "commands", arguments: JSON.stringify({ action: "execute", name: "runs.list" }) },
        { type: "function_call_output", call_id: callId, output: "executed /runs.list" }
      ]
    }))

    expect(calls.gateway).toEqual([])
    expect(calls.upstream).toEqual([])
    expect(await frames(response)).toEqual([
      { runId: "run-front-door", type: "delta", kind: "text", text: "/runs.list" },
      { runId: "run-front-door", type: "done", reason: "stop" }
    ])
  })
})
