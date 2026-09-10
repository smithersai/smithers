/**
 * The Node seat resolver: `provider:modelId` seats into live model routes,
 * with keys read from an environment record and never hardcoded.
 */
import { NodeHttpClient } from "@effect/platform-node"
import type * as Undici from "@effect/platform-node/Undici"
import { MockAgent } from "@effect/platform-node/Undici"
import { Seat } from "@smthrs/agent"
import { Control } from "@smthrs/control"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

describe("NodeControl.seatResolver", () => {
  const unusedExecutor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die(new Error("model transport was not expected"))
  })

  it("refuses a seat whose provider has no route", async () => {
    const error = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("mystery:model-x"))
    )
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("mystery")
  })

  it("refuses a seat whose key variable is unset, naming the variable", async () => {
    const anthropic = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("anthropic:claude-sonnet-4-5"))
    )
    expect(anthropic.message).toContain("ANTHROPIC_API_KEY")

    const openai = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("openai:gpt-5"))
    )
    expect(openai.message).toContain("OPENAI_API_KEY")

    const openrouter = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("openrouter:openai/gpt-5.6-sol"))
    )
    expect(openrouter.message).toContain("OPENROUTER_API_KEY")
  })

  it("resolves an openrouter seat through the compatible route with the slashed model id intact", async () => {
    const seat = await Effect.runPromise(
      Effect.scoped(
        NodeControl.seatResolver({ OPENROUTER_API_KEY: "test-key" }, unusedExecutor).resolve(
          "openrouter:openai/gpt-5.6-sol"
        )
      )
    )
    // gpt-5-class ids resolve the 400k window regardless of the vendor prefix.
    expect(seat.contextWindowTokens).toBe(400_000)
  })

  it("boots the full local composition with the production executor provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-executor-"))
    try {
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, { environment: {} })
      // Building this layer migrates the durable engine, registers the agent
      // flow, starts the resume bridge, and migrates the memory store over the
      // control database — the whole local `smthrs run` composition, minus a
      // provider.
      const flowId = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          return card.flowId
        }).pipe(
          Effect.provide(
            Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
          ),
          Effect.scoped,
          Effect.orDie
        )
      )
      expect(flowId).toBe("system/test")
      expect(existsSync(NodeControl.executionDatabasePath(root))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("boots with a configured MCP server, spawning it through the real guarded spawner", async () => {
    // A minimal real MCP server over stdio: `initialize` and `tools/list`
    // only, which is everything `McpClient.connect` needs. Spawned as an
    // actual subprocess through `node -e` so this exercises the real guarded
    // `ChildProcessSpawner`, not a scripted double.
    const server = [
      "process.stdin.setEncoding('utf8')",
      "let buf = ''",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk",
      "  let idx",
      "  while ((idx = buf.indexOf('\\n')) !== -1) {",
      "    const line = buf.slice(0, idx)",
      "    buf = buf.slice(idx + 1)",
      "    if (!line.trim()) continue",
      "    let msg",
      "    try { msg = JSON.parse(line) } catch { continue }",
      "    if (msg.id === undefined) continue",
      "    let result",
      "    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '0' } }",
      "    else if (msg.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Replies pong', inputSchema: { type: 'object' } }] }",
      "    else continue",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
      "  }",
      "})"
    ].join("\n")

    const root = await mkdtemp(join(tmpdir(), "flows-cli-executor-mcp-"))
    try {
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {
        environment: {},
        mcpServers: [{ server: "ping", command: process.execPath, args: ["-e", server] }]
      })
      const flowId = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          return card.flowId
        }).pipe(
          Effect.provide(
            Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
          ),
          Effect.scoped,
          Effect.orDie
        )
      )
      expect(flowId).toBe("system/test")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves a keyed anthropic seat into a route and a nonzero context window", async () => {
    const seat = await Effect.runPromise(
      NodeControl.seatResolver({ ANTHROPIC_API_KEY: "test-key" }, unusedExecutor).resolve("anthropic:claude-sonnet-4-5")
    )
    // The window comes from the model catalog, so compaction is armed rather
    // than silently disabled at zero.
    expect(seat.contextWindowTokens).toBe(200_000)
    // The resolved record carries the seat it was declared as, which is what
    // the agent stamps onto every turn.
    expect(seat.id).toBe("anthropic:claude-sonnet-4-5")
    const preparedRequest = await Effect.runPromise(
      seat.route.prepare({
        modelId: "claude-sonnet-4-5",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        params: {}
      } as never)
    )
    // The prepared view is credential-free: the key is applied by Auth at
    // send time and never enters the sealed request.
    expect(preparedRequest.url).toContain("api.anthropic.com")
    expect(JSON.stringify(preparedRequest.publicHeaders)).not.toContain("test-key")
  })

  it("keeps the live model transport open while a resolved seat streams", async () => {
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"live\"}",
      "",
      "event: response.output_text.done",
      "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const agent = new MockAgent()
    agent.disableNetConnect()
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(200, sse, {
      headers: { "content-type": "text/event-stream" }
    })
    const transport = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const executor = await Effect.runPromise(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, transport))
    )
    try {
      const events = await Effect.runPromise(
        Effect.scoped(
          NodeControl.seatResolver({ OPENAI_API_KEY: "test-key" }, executor).resolve("openai:gpt-4o-mini").pipe(
            Effect.flatMap((seat) =>
              seat.model.stream({
                modelId: "gpt-4o-mini",
                system: [],
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
                tools: [],
                params: {}
              }).pipe(Stream.runCollect)
            )
          )
        )
      )

      expect(Array.from(events)).toContainEqual({ type: "text-delta", id: "msg_1", text: "live" })
      expect(agent.assertNoPendingInterceptors()).toBeUndefined()
    } finally {
      await agent.close()
    }
  })
})

describe("NodeControl.rebuildableTransport", () => {
  const request = () =>
    HttpClientRequest.post("https://api.openai.com/v1/responses").pipe(
      HttpClientRequest.bodyUint8Array(new TextEncoder().encode("{}"), "application/json")
    )

  it("replaces the connection pool once waiting has stopped explaining the failure", async () => {
    // The scripted poisoned session: an agent that refuses to connect at all,
    // which is what a destroyed HTTP/2 session looks like from above — it fails
    // identically however long the ladder waits between attempts.
    const acquired: Array<MockAgent> = []
    const closed: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      acquired.push(agent)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed.push(agent)
          await agent.close()
        })
      )
      return agent as unknown as Undici.Dispatcher
    })

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* Effect.flatMap(
            NodeControl.rebuildableTransport(acquire),
            RequestExecutor.makeWith
          )
          const run = () => Effect.scoped(executor.execute(request(), { modelId: "gpt-4o-mini" })).pipe(Effect.flip)
          // One execute spends this executor's own ladder — an attempt plus its
          // bounded retries — which is what reaches `rebuildAfter`.
          const first = yield* run()
          expect(acquired).toHaveLength(1)
          const second = yield* run()
          // Read inside the scope: the enclosing teardown closes the surviving
          // pool too, so only here can the test tell the two apart.
          return { first, second, closedDuringRun: [...closed] }
        })
      )
    )

    expect(outcome.first).toMatchObject({ code: "transport" })
    expect(outcome.second).toMatchObject({ code: "transport" })
    // A second pool was built, and the first was destroyed as soon as it was:
    // a run that keeps meeting dead sockets holds one agent, not a queue of
    // them, and the enclosing scope closes the last.
    expect(acquired).toHaveLength(2)
    expect(outcome.closedDuringRun).toHaveLength(1)
    expect(outcome.closedDuringRun[0]).toBe(acquired[0])
    // And the scope that owned the run closed the one it was still holding.
    expect(closed).toHaveLength(2)
  }, 30_000)

  it("builds one pool and keeps it while the transport answers", async () => {
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"ok\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const agents: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(200, sse, {
        headers: { "content-type": "text/event-stream" }
      })
      agents.push(agent)
      yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()))
      return agent as unknown as Undici.Dispatcher
    })

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* Effect.flatMap(
            NodeControl.rebuildableTransport(acquire),
            RequestExecutor.makeWith
          )
          const response = yield* executor.execute(request(), { modelId: "gpt-4o-mini" })
          return response.status
        })
      )
    )

    expect(status).toBe(200)
    expect(agents).toHaveLength(1)
  })
})
