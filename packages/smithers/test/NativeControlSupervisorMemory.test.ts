/**
 * The supervisor's memory through the executor the CLI ships.
 *
 * `SupervisorMemory.test.ts` holds the layer `SupervisorMemory` builds to its
 * promises, but it builds that layer itself, so an executor that stopped
 * providing it (the `Recall.layerNoop` this replaced) left every one of its
 * cases green. These runs go through `NodeControl.layerExecutor`, the
 * composition `smithers run` uses: a real flow, planned, approved and run
 * twice over one `SMITHERS_MEMORY_DB`. The provider is an Undici mock and the
 * judge is scripted, so nothing leaves the process.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import { Control } from "@smthrs/control"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const roots = new Set<string>()
const agents = new Set<MockAgent>()

afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.close()))
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })))
  agents.clear()
  roots.clear()
})

const sentence = "The repository runs its suite through tox, never pytest directly."

/** One OpenAI Responses stream whose only output is `text`. */
const sse = (text: string): string =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_memory", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

const cell = (source: string): string => `\`\`\`cell\n${source}\n\`\`\``

describe("the shipped Node executor's supervisor memory", () => {
  it("recalls a note run 1 remembered into run 2's supervisor snapshot", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-memory-")))
    roots.add(root)
    const directory = join(root, "flows", "tox")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "flow.mdx"),
      [
        "---",
        "name: tox",
        "description: Makes the tox suite pass.",
        "model: openai:gpt-4o-mini",
        "---",
        "",
        "Make the tox suite pass.",
        ""
      ].join("\n")
    )

    // Which run the provider and the judge are answering, and how many model
    // calls that run has made. Run 1 says the sentence on its first frame and
    // finishes on its second; run 2 says something else and finishes.
    type Phase = "run-1" | "run-2"
    let phase: Phase = "run-1"
    let frame = 0
    const snapshots: Record<Phase, Array<Supervisor.Snapshot>> = { "run-1": [], "run-2": [] }
    const read = Deferred.makeUnsafe<void>()

    const agent = new MockAgent()
    agents.add(agent)
    agent.disableNetConnect()
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      200,
      () => {
        const first = frame++ === 0
        const prose = phase === "run-1" ? sentence : "Looking around first."
        return sse(first ? `${prose}\n\n${cell("console.log('observed')")}` : cell("ctx.done('done')"))
      },
      { headers: { "content-type": "text/event-stream" } }
    ).persist()
    const client = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const inner = await Effect.runPromise(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
    )
    // Run 1's second frame waits for the supervisor to read its first, so the
    // reading, and the note it decides to write, happen inside the run.
    const executor = Layer.succeed(RequestExecutor.RequestExecutor, {
      execute: (request, options) =>
        (phase === "run-1" && frame > 0 ? Deferred.await(read) : Effect.void).pipe(
          Effect.andThen(inner.execute(request, options))
        )
    })

    // Finishes every completion and accepts every memory candidate.
    const judge = Evaluator.layerScripted((request) => {
      if (!Object.hasOwn(request.questions, "thrashing")) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      snapshots[phase].push(Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state))
      Deferred.doneUnsafe(read, Effect.void)
      return Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          key === "needs_help"
            ? { choice: "none" }
            : ["frustrated", "anxious", "scared", "confused", "confident"].includes(key)
            ? { score: 0 }
            : { probability: key === "on_target" || key.startsWith("remember_") ? 0.99 : 0.01 }
        ])
      )
    })

    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const runs = NodeControl.layerExecutor(registry, engine, root, {
      evaluator: judge,
      environment: { OPENAI_API_KEY: "test-key", SMITHERS_MEMORY_DB: join(root, "memory", "tox.db") },
      grants: GrantStore.layerNoop,
      requestExecutor: executor
    })
    const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>

    const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
    const run = (ordinal: number) =>
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "tox", input: { ordinal } })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `native-memory:${ordinal}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind)),
          Stream.runCollect,
          Effect.map((events) => events.at(-1)?.kind)
        )
      })

    const statuses = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* run(1)
        phase = "run-2"
        frame = 0
        const second = yield* run(2)
        return [first, second]
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )

    expect(statuses).toEqual(["control.run.completed", "control.run.completed"])
    expect(snapshots["run-1"][0]?.candidates).toEqual([sentence])
    expect(snapshots["run-2"][0]?.recalled.map((row) => row.text)).toContain(sentence)
  }, 60_000)
})
