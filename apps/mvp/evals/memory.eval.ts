// Real-model, SQL, HTTP and browser-engine memory proofs. The wiki is deferred.
import { DurableWriter } from "@smthrs/database"
import { Flows, MemoryError, MemoryStore, Opening, RecallKeyword } from "@smthrs/memory"
import { Model, ModelError } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { EgressHttpClient, NodeHost } from "@smthrs/platform-node"
import { Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { DEFAULT_CHAT_MODEL } from "../worker/ModelRoles.ts"
import { testFile } from "../worker/test/harness.ts"
import { answerRow, openAgent } from "../src/test/agent"
import { openDevice } from "../src/test/device"

// Only synthetic eval context and canonical model messages; never provider headers or app logs.
const transcript: Array<{ test: string | undefined; request: unknown; reply: string }> = []
const artifact = new URL(`results/memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url)
afterAll(() => {
  mkdirSync(new URL("results/", import.meta.url), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ transcript }, null, 2) + "\n")
})
const runtime = testFile("eval_memory")
const realModel = (scope: Scope.Closeable) => Effect.runPromise(Effect.gen(function*() {
  const fetch = yield* Scope.provide(scope)(EgressHttpClient.providerFetch(process.env))
  const host = yield* Effect.gen(function*() { return yield* HostModel }).pipe(
    Effect.provide(HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL, { fetch })),
  )
  return { ...host, model: Model.make({ ...host.model, stream: (request) => {
    const turn = { test: expect.getState().currentTestName, request, reply: "" }
    transcript.push(turn)
    return host.model.stream(request).pipe(Stream.tap((event) => Effect.sync(() => {
      if (event.type === "text-delta") turn.reply += event.text
    })))
  } }) }
}))
// The memory store on its own schema of the compose Postgres, dropped when the layer's scope closes.
const memoryStore = MemoryStore.layer.pipe(
  // A database that can't open is the fixture's defect, not the memory store's failure.
  Layer.provide(Layer.orDie(Layer.provideMerge(DurableWriter.layer(), TestDatabase.layer("memory_eval")))),
  Layer.provide(NodeHost.NodeCrypto.layer),
)
const savedMemory = (password: string, skills: ReadonlyArray<Opening.Candidate> = []) =>
  Opening.layerSources(["agent-chat"], skills).pipe(
    Layer.provideMerge(Layer.effectDiscard(Flows.runRemember({
      bank: "agent-chat", key: "launch", text: `The launch mascot is ${password}.`,
    }).pipe(Effect.orDie))),
    Layer.provide(RecallKeyword.layer), Layer.provide(memoryStore),
  )

// Locate the sealed prepared payload in the redacted debug journal. A nested
// model's attempt may be withheld by the inspector's action-output schema.
const findReceipt = (value: unknown): unknown => {
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try { return findReceipt(JSON.parse(value)) } catch { return undefined }
  }
  if (typeof value !== "object" || value === null) return undefined
  if ("memoryDebug" in value && "opening" in value) return value
  return Object.values(value).map(findReceipt).find((found) => found !== undefined)
}

test("opening recall uses a durable fact, filters skills, retries a faulty source, and records debug counts", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const model = await realModel(scope)
    const openings: Array<string> = []
    const observed = { ...model, model: Model.make({ ...model.model, stream: (request) => {
      const text = JSON.stringify(request)
      if (text.includes("flows_memory_context")) openings.push(text)
      return model.model.stream(request)
    } }) }
    const agent = await openAgent(runtime, () => Stream.die("real model required"), { model: observed })
    const memory = savedMemory("lilac-otter-7429", [
      { kind: "skill", bank: "skills", key: "launch-guide", text: "For a launch mascot question, answer with the saved mascot only." },
      { kind: "skill", bank: "skills", key: "gardening", text: "Use this guide for planting tulips." },
    ])
    let retrievals = 0
    const recovering = Layer.effect(Opening.Sources, Effect.map(Opening.Sources, (sources) => ({
      recall: (query: string) => ++retrievals === 1
        ? Effect.fail(new MemoryError.MemoryError({ code: "store", message: "injected transient source failure" }))
        : sources.recall(query),
    }))).pipe(Layer.provide(memory))
    const device = await openDevice(agent.fetch, {}, recovering)
    try {
      const answerId = await agent.ask("What is the launch mascot?")
      await Effect.runPromise(device.dispatch.dispatch("chat/Answer", { answerId }, { door: "composer", executionId: answerId }))
      expect(retrievals).toBe(2)
      const answer = await answerRow(runtime, answerId)
      expect(answer.status).toBe("done")
      expect(answer.text?.toLowerCase().replace(/[^a-z0-9]/g, "")).toContain("lilacotter7429")
      const debug = await Effect.runPromise(device.engine.inspect(answerId))
      expect(debug.steps.some((step) => step.action === "chat/Opening")).toBe(true)
      const receipt = findReceipt(debug) as { memoryDebug: { inserted: number; filtered: number; skillsInserted: number } }
      expect(openings.length).toBeGreaterThan(0)
      for (const context of openings) {
        expect(context).toContain("launch-guide")
        expect(context).not.toContain("gardening")
      }
      expect(receipt.memoryDebug).toMatchObject({ inserted: 2, filtered: 1, skillsInserted: 1 })
    } finally { await device.close() }
    // A faulty injected model is only the negative-path service.
    const refused = { ...model, model: Model.make({ ...model.model,
      stream: () => Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "private provider detail" })),
    }) }
    const failedAgent = await openAgent(runtime, () => Stream.die("faulty service required"), { model: refused })
    const failedDevice = await openDevice(failedAgent.fetch, {}, memory)
    try {
      const answerId = await failedAgent.ask("What is the launch mascot?")
      await Effect.runPromise(failedDevice.dispatch.dispatch("chat/Answer", { answerId }, { door: "composer", executionId: answerId }))
      expect(await answerRow(runtime, answerId)).toMatchObject({ status: "failed" })
    } finally { await failedDevice.close() }
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
}, 120_000)

test("resuming after a sealed judgment never recalls or judges again", async () => {
  const scope = Effect.runSync(Scope.make())
  const reached = Effect.runSync(Deferred.make<void>())
  const model = await realModel(scope)
  let judges = 0
  let stalled = false
  const interrupted = { ...model, model: Model.make({ ...model.model, stream: (request) => {
    const judging = request.system.some((part) => part.text.startsWith("Judge the supplied evidence"))
    if (judging) judges++
    else if (!stalled) {
      stalled = true
      return Stream.fromEffect(Deferred.succeed(reached, undefined)).pipe(Stream.flatMap(() => Stream.never))
    }
    return model.model.stream(request)
  } }) }
  const agent = await openAgent(runtime, () => Stream.die("real model required"), { model: interrupted })
  const first = await agent.engine(undefined, { memorySources: savedMemory("amber-ibis-9517") })
  let second: Awaited<ReturnType<typeof agent.engine>> | undefined
  const answerId = await agent.ask("What is the launch mascot?")
  const running = agent.start(first, answerId)
  try {
    await Effect.runPromise(Deferred.await(reached).pipe(Effect.timeout("30 seconds")))
    expect(judges).toBe(1)
    await first.crash()
    const changedSource = Layer.succeed(Opening.Sources, {
      recall: () => Effect.die("a resumed sealed snapshot must never read changed sources"),
    })
    second = await agent.engine(first.schema, { memorySources: changedSource })
    expect(await agent.resume(second, answerId)).toEqual(Exit.succeed({ status: "done" }))
    expect(judges).toBe(1)
    const answer = await answerRow(runtime, answerId)
      expect(answer.status).toBe("done")
      expect(answer.text?.toLowerCase().replace(/[^a-z0-9]/g, "")).toContain("amberibis9517")
  } finally {
    await running.stop()
    await second?.kill()
    await first.kill()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}, 120_000)

test("the public remember flow supplies production opening recall in a fresh question", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const model = await realModel(scope)
    const agent = await openAgent(runtime, () => Stream.die("real model required"), { model })
    const device = await openDevice(agent.fetch)
    try {
      await Effect.runPromise(device.dispatch.dispatch("app/memory/remember", {
        key: "launch", text: "The launch mascot is silver-heron-3862.",
      }, { door: "composer", executionId: crypto.randomUUID() }))
      const answerId = await agent.ask("What is the launch mascot?")
      await Effect.runPromise(device.dispatch.dispatch("chat/Answer", { answerId }, { door: "composer", executionId: answerId }))
      const answer = await answerRow(runtime, answerId)
      expect(answer.status).toBe("done")
      expect(answer.text?.toLowerCase().replace(/[^a-z0-9]/g, "")).toContain("silverheron3862")
    } finally { await device.close() }
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
}, 120_000)
