/**
 * Safety contracts of the shipped Node agent composition.
 *
 * These cases cross the actual CLI composition root, SQL control runtime, SQL
 * journal, durable Node engine, discovered markdown registry, and model
 * protocol. The provider is the one external input: an Undici transport
 * returns the wire response named by each case.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { Application, NodeControl } from "@smthrs/cli"
import { Control, type ControlSchema } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"

const roots = new Set<string>()
const agents = new Set<MockAgent>()

afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.close()))
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  agents.clear()
  roots.clear()
})

const workspace = async (budget: ControlSchema.Envelope["budget"] = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "smithers-composition-contract-"))
  roots.add(root)
  const directory = join(root, "flows", "capacity")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "flow.mdx"),
    [
      "---",
      "name: capacity",
      "description: Exercises the production model boundary.",
      "model: openai:gpt-4o-mini",
      `budget: ${JSON.stringify(budget)}`,
      "---",
      "",
      "Exercise the production model boundary.",
      ""
    ].join("\n")
  )
  return root
}

const modelExecutor = async (agent: MockAgent): Promise<Layer.Layer<RequestExecutor.RequestExecutor>> => {
  const client = await Effect.runPromise(
    NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
  )
  const executor = await Effect.runPromise(
    RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
  )
  return Layer.succeed(RequestExecutor.RequestExecutor, executor)
}

const composition = (
  root: string,
  executor: Layer.Layer<RequestExecutor.RequestExecutor>
): Layer.Layer<Control.Control> => {
  const registry = NodeControl.layerRegistry(root)
  // Discover the actual descriptor, including its budget and executable
  // identity, through the same composition used by the shipped CLI.
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    environment: { OPENAI_API_KEY: "test-key" },
    // This is the deliberately permissive TEST input. Production takes the
    // executor's real store default.
    grants: GrantStore.layerNoop,
    requestExecutor: executor,
    // Proves the recorder's floor: explicitly declining to park must not make
    // a provider-capacity refusal recordable again.
    quotaPolicy: QuotaPolicy.layerUnclassified()
  })
  return Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
}

const terminal = new Set(["completed", "failed", "cancelled"])

const run = (ordinal: number) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan({ flowId: "capacity", input: { same: true } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `composition-contract:${ordinal}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die("expected an accepted run")
    }
    for (let attempt = 0; attempt < 1_200; attempt++) {
      const page = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
      if (page._tag === "runs") {
        const summary = page.items[0]
        if (summary !== undefined && terminal.has(summary.status)) return summary
      }
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(`run ${receipt.runId} did not settle`)
  })

const calls = (agent: MockAgent): number => agent.getCallHistory()?.calls().length ?? 0

const recordedCapacityValues = (root: string): ReadonlyArray<string> => {
  const database = new DatabaseSync(NodeControl.executionDatabasePath(root), { readOnly: true })
  try {
    return database.prepare(
      "SELECT outcome_json FROM flows_attempts WHERE outcome_json IS NOT NULL"
    ).all().flatMap((row) => {
      const outcome = (row as { readonly outcome_json: string }).outcome_json
      return /rate_limited|quota_exceeded|provider_internal/.test(outcome) ? [outcome] : []
    })
  } finally {
    database.close()
  }
}

describe("the shipped Node agent composition", () => {
  it("never serves a provider 429 from the sealed cache to a later execution id", async () => {
    const root = await workspace()
    const agent = new MockAgent({ enableCallHistory: true })
    agents.add(agent)
    agent.disableNetConnect()
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      429,
      JSON.stringify({ error: { code: "rate_limit_exceeded", message: "capacity window closed" } }),
      { headers: { "content-type": "application/json", "retry-after": "0" } }
    ).persist()
    const layer = composition(root, await modelExecutor(agent))

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* run(1)
        const afterFirst = calls(agent)
        const recorded = recordedCapacityValues(root)
        const second = yield* run(2)
        return { first, afterFirst, recorded, second, afterSecond: calls(agent) }
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.status).toBe("failed")
    expect(observed.second.status).toBe("failed")
    expect(observed.afterFirst).toBeGreaterThan(0)
    expect(observed.recorded).toEqual([])
    // The two plans have the same flow and input but distinct execution ids.
    // A durable refusal value makes this equal; a failed sealed action asks
    // the provider again.
    expect(observed.afterSecond).toBeGreaterThan(observed.afterFirst)
  }, 30_000)

  it("enforces the token budget approved in the plan envelope", async () => {
    const root = await workspace({ tokens: 1_000 })
    const agent = new MockAgent({ enableCallHistory: true })
    agents.add(agent)
    agent.disableNetConnect()
    const cell = "```cell\nconsole.log(\"continue\")\n```"
    const response = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: cell })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
      "",
      `data: ${
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_budget",
            usage: { input_tokens: 600, output_tokens: 200, total_tokens: 800 }
          }
        })
      }`,
      "",
      ""
    ].join("\n")
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      200,
      response,
      { headers: { "content-type": "text/event-stream" } }
    ).persist()
    const layer = composition(root, await modelExecutor(agent))

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const summary = yield* run(1)
        const control = yield* Control.Control
        const events = yield* Stream.runCollect(control.watch({ runId: summary.runId, follow: false }))
        return { summary, events, calls: calls(agent) }
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )

    expect(observed.summary.status).toBe("failed")
    expect(observed.calls).toBe(1)
    expect(JSON.stringify(observed.events)).toContain("BudgetExceeded")
  }, 30_000)
})
