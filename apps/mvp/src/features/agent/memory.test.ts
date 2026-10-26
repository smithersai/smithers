import { DurableWriter } from "@smthrs/database"
import { ModelStep } from "@smthrs/agent"
import { Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Flows, MemoryError, MemoryStore, Opening, RecallKeyword } from "@smthrs/memory"
import { NodeHost } from "@smthrs/platform-node"
import { ModelError } from "@smthrs/model"
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger, Metric, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { contents, harness, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { answerRow, cell, member, openAgent, ORIGIN } from "../../test/agent"
import { JudgeSeat } from "../jev/steps"
import { runFlow } from "../../../worker/test/flowHost.ts"
import { OpeningFailed, OpeningRefused, Prepare, PreparedTurn } from "./flows"
import { catalogUnavailable, layer, openingSkipped, prepare, recall, remembered, rememberRegistration } from "./memory"

import { MEMORY_BANK, Remember } from "./memoryFlows"

const runtime = testFile("memory_sources")
// The memory banks' own schema on the compose Postgres, dropped when each test's scope closes.
const database = Layer.provideMerge(DurableWriter.layer(), TestDatabase.layer("memory_banks"))
const turn = { question: "What is its launch mascot?", history: [{ question: "Remember the launch", answer: "Okay" }] }
const http = (fetch: typeof globalThis.fetch) => FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))

test("production sources read the real saved-flow catalog and durable memory database", async () => {
  const agent = await openAgent(runtime, () => Stream.die("no model expected"))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO flows(id, owner_id, name, revision, description, placement)
    VALUES (${crypto.randomUUID()}, ${member.subject.id}, 'launch-guide', 1, 'Read the launch mascot', 'client')`))
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Flows.runRemember({ bank: "agent-chat", key: "launch", text: "launch mascot is cobalt" })
    return yield* (yield* Opening.Sources).recall("launch")
  }).pipe(
    Effect.provide(layer(ORIGIN).pipe(Layer.provideMerge(MemoryStore.layer))), Effect.provide(database), Effect.provide(NodeHost.NodeCrypto.layer),
    Effect.provide(http(agent.fetch)),
  )))
  expect(result.some((row) => row.kind === "memory" && row.text.includes("cobalt"))).toBe(true)
  expect(result).toContainEqual({ kind: "skill", bank: "skills", key: "launch-guide", text: "Saved flow launch-guide, revision 1: Read the launch mascot" })
})

test("recall preserves history and maps faulty source codes without exposing their content", async () => {
  for (const [code, tag] of [["store", OpeningFailed], ["invalid_namespace", OpeningRefused]] as const) {
    const fault = Layer.succeed(Opening.Sources, { recall: () => Effect.fail(new MemoryError.MemoryError({ code, message: "private content" })) })
    const exit = await Effect.runPromiseExit(recall(turn).pipe(Effect.provide(fault)))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(tag)
    expect(JSON.stringify(exit)).not.toContain("private content")
  }
  const sources = Opening.layerSources(["agent-chat"]).pipe(
    Layer.provide(RecallKeyword.layer),
    Layer.provide(MemoryStore.layer),
    Layer.provide(database), Layer.provide(NodeHost.NodeCrypto.layer),
  )
  expect(await Effect.runPromise(Effect.scoped(recall(turn).pipe(Effect.provide(sources))))).toEqual({ ...turn, candidates: [] })
})

test("empty opening records zero counts and preserves the turn without calling the judge", async () => {
  const flow = Flow.make("memory/TestEmpty", {
    payload: {}, success: PreparedTurn, error: OpeningFailed,
    body: Node.capture({ prepare: Prepare.name, turn }, () => Prepare.call({ ...turn, candidates: [] })),
  })
  const result = await runFlow(flow, {}, Interpreter.layerWithImplementations(flow, Prepare.toLayer(prepare)).pipe(
    Layer.provide(JudgeSeat.layer(ORIGIN)), Layer.provide(FetchHttpClient.layer),
  ))
  expect(result.exit).toEqual(Exit.succeed({ ...turn, opening: [], memoryDebug: { recalled: 0, inserted: 0, filtered: 0, skillsInserted: 0 } }))
  const invalid = await runFlow(flow, {}, Interpreter.layerWithImplementations(flow, Prepare.toLayer(prepare)).pipe(
    Layer.provide(JudgeSeat.layer(ORIGIN)), Layer.provide(FetchHttpClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AGENT_OPENING_TOKENS: "invalid" }))),
  ))
  expect(Exit.isFailure(invalid.exit)).toBe(true)

})


test("production sources preserve a real signed-out refusal", async () => {
  const denied = await harness(runtime, () => Stream.die("no model expected"))
  const deniedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return denied.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }) as typeof globalThis.fetch
  for (const [fetch, code] of [[deniedFetch, "invalid_namespace"]] as const) {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.flatMap(Opening.Sources, (sources) => sources.recall("launch")).pipe(
      Effect.provide(layer(ORIGIN)), Effect.provide(database), Effect.provide(NodeHost.NodeCrypto.layer),
      Effect.provide(http(fetch)),
    )))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code, message: "Skill catalog unavailable" })
  }
})


test.each([
  ["on the network", (() => Promise.reject(new Error("injected catalog outage"))) as typeof globalThis.fetch, undefined],
  ["with a status", (async () => new Response("injected catalog outage", { status: 503 })) as typeof globalThis.fetch, 503],
] as const)("a catalog outage %s preserves recalled memory so chat can continue", async (_how, brokenFetch, status) => {
  const logs: string[] = []
  const before = Effect.runSync(Metric.value(catalogUnavailable)).count
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Flows.runRemember({ bank: "agent-chat", key: "launch", text: "launch mascot is cobalt" })
    return yield* recall(turn)
  }).pipe(
    Effect.provide(layer(ORIGIN).pipe(Layer.provideMerge(MemoryStore.layer))),
    Effect.provide(database), Effect.provide(NodeHost.NodeCrypto.layer), Effect.provide(http(brokenFetch)),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => { logs.push(JSON.stringify(Logger.formatStructured.log(options))) })])),
  )))
  expect(Effect.runSync(Metric.value(catalogUnavailable)).count - before).toBe(1)
  // Once, at Warn, by the failure's code: the counting logger counts it by that code.
  expect(logs.map((log) => JSON.parse(log)).filter((log) => log.message === "memory.catalog_unavailable")).toEqual([
    expect.objectContaining({
      level: "WARN",
      annotations: expect.objectContaining({
        feature: "agent",
        outcome: "unavailable",
        errorCode: "@smthrs/mvp/flows/FlowsUnavailable",
        ...(status === undefined ? {} : { status }),
      }),
    }),
  ])
  if (status === undefined) {
    expect(logs.map((log) => JSON.parse(log)).find((log) => log.message === "memory.catalog_unavailable").annotations)
      .not.toHaveProperty("status")
  }
  expect(logs.join("\n")).not.toContain("injected catalog outage")
  expect(logs.join("\n")).not.toContain("cobalt")
  expect(result.question).toBe(turn.question)
  expect(result.history).toEqual(turn.history)
  expect(result.candidates).toContainEqual(expect.objectContaining({ kind: "memory", key: "launch", text: "launch mascot is cobalt" }))
  expect(result.candidates.some((row) => row.kind === "skill")).toBe(false)
})

test("remember returns a save receipt, stores in the host-owned bank and replaces the same key", async () => {
  const before = Effect.runSync(Metric.value(remembered)).count
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(MemoryStore.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(NodeHost.NodeCrypto.layer)))
    for (const text of ["launch mascot is cobalt", "launch mascot is amber"]) {
      const result = yield* Effect.promise(() => runFlow(Remember, { key: "mascot", text }, rememberRegistration.pipe(Layer.provide(Layer.succeedContext(context)))))
      expect(result.exit).toEqual(Exit.succeed({ key: "mascot" }))
      const rows = yield* Effect.flatMap(Opening.Sources, (sources) => sources.recall("launch mascot")).pipe(
        Effect.provide(Opening.layerSources([MEMORY_BANK]).pipe(Layer.provide(RecallKeyword.layer), Layer.provide(Layer.succeedContext(context)))),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ bank: MEMORY_BANK, key: "mascot", text })
    }
  })))
  expect(Effect.runSync(Metric.value(remembered)).count - before).toBe(2)
})


test.each(["judged", "unavailable"] as const)("a nonempty opening is %s through the durable judge seat", async (mode) => {
  const agent = mode === "unavailable" ? undefined : await openAgent(runtime, (request) => {
    const asked = JSON.parse(contents(request).at(-1)!) as { questions: Record<string, unknown> }
    return Stream.make({ type: "text-delta" as const, id: "judge", text: JSON.stringify({ answers: Object.fromEntries(
      Object.keys(asked.questions).map((id, index) => [id, { type: "boolean", probability: index === 0 ? 0.01 : 0.99 }]),
    ) }) }, usage, stop)
  })
  const candidates = [
    { kind: "memory" as const, bank: MEMORY_BANK, key: "launch", text: "launch mascot is cobalt" },
    { kind: "skill" as const, bank: "skills", key: "irrelevant", text: "unrelated skill" },
  ]
  const flow = Flow.make(`memory/TestOpening-${mode}`, {
    payload: {}, success: PreparedTurn, error: OpeningFailed,
    body: Node.capture({ prepare: Prepare.name, turn }, () => Prepare.call({ ...turn, candidates })),
  })
  let attempts = 0
  const transport = agent?.fetch ?? (() => {
    attempts++
    return Promise.reject(new Error("injected judge outage"))
  }) as typeof fetch
  // Exercise the real retry exhaustion through the seat service, without production backoff waits.
  const judge = Layer.effect(JudgeSeat, Effect.map(JudgeSeat, (seat) => ({
    ...seat,
    retryPolicy: RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 }),
  }))).pipe(Layer.provide(JudgeSeat.layer(ORIGIN)))
  const skipped = Metric.withAttributes(openingSkipped, { reason: "unreachable" })
  const before = Effect.runSync(Metric.value(skipped)).count
  const result = await runFlow(flow, {}, Interpreter.layerWithImplementations(flow, Prepare.toLayer(prepare)).pipe(
    Layer.provide(judge), Layer.provide(http(transport)),
  ))
  if (mode === "unavailable") {
    // An outage outlasted the judge's every durable attempt: the turn opens with no memory, and says so.
    expect(result.exit).toEqual(Exit.succeed({ ...turn, memoryDebug: { recalled: 2, inserted: 0, filtered: 2, skillsInserted: 0 }, opening: [] }))
    expect(attempts).toBe(6)
    expect(Effect.runSync(Metric.value(skipped)).count - before).toBe(1)
  } else {
    expect(result.exit).toEqual(Exit.succeed({ ...turn, memoryDebug: { recalled: 2, inserted: 1, filtered: 1, skillsInserted: 0 },
      opening: [{ bank: MEMORY_BANK, key: "launch", text: "launch mascot is cobalt", origin: "recall" }],
    }))
  }
})

test("an opening whose judge is refused for credit asks once and fails as a quota refusal, which the answer reports at once", async () => {
  // smithers.sh, 2026-10-25: each question's opening judge asked a provider answering 402 six times.
  let calls = 0
  const agent = await openAgent(runtime, () => {
    calls++
    return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "payment required" }))
  })
  const flow = Flow.make("memory/TestOpening-refused", {
    payload: {}, success: PreparedTurn, error: OpeningFailed,
    body: Node.capture({ prepare: Prepare.name, turn }, () => Prepare.call({ ...turn, candidates: [
      { kind: "memory" as const, bank: MEMORY_BANK, key: "launch", text: "launch mascot is cobalt" },
    ] })),
  })
  const judge = Layer.effect(JudgeSeat, Effect.map(JudgeSeat, (seat) => ({
    ...seat,
    retryPolicy: RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 }),
  }))).pipe(Layer.provide(JudgeSeat.layer(ORIGIN)))
  const result = await runFlow(flow, {}, Interpreter.layerWithImplementations(flow, Prepare.toLayer(prepare)).pipe(
    Layer.provide(judge), Layer.provide(http(agent.fetch)),
  ))
  // The person's agent uses the same key and would be refused the same way: no skipping to an answer that can't come.
  expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toMatchObject({
    _tag: "@smthrs/mvp/memory/OpeningFailed",
    quota: true,
  })
  expect(calls).toBe(1)
})

test("a judge whose answer can't be read leaves the turn without memory, and the answer completes", async () => {
  // Memory is context, never a gate on answering (decision 0027's amendment): before it, any judge failure settled the
  // answer failed before the agent ran.
  const asked: Array<"judge" | "agent"> = []
  const agent = await openAgent(runtime, (request) => {
    const judging = contents(request).at(-1)?.includes("\"questions\"") === true
    asked.push(judging ? "judge" : "agent")
    return judging
      ? Stream.make({ type: "text-delta" as const, id: "j", text: "not a reading" }, usage, stop)
      : Stream.make({ type: "text-delta" as const, id: "t", text: cell(`ctx.done("Answered without memory.")`) }, usage, stop)
  })
  const engine = await agent.engine(undefined, { memorySources: Layer.succeed(Opening.Sources, {
    recall: () => Effect.succeed([{ kind: "memory" as const, bank: MEMORY_BANK, key: "launch", text: "launch mascot is cobalt" }]),
  }) })
  try {
    const id = await agent.ask("What is the launch mascot?")
    expect(await agent.answer(engine, id)).toEqual(Exit.succeed({ status: "done" }))
    expect(await answerRow(runtime, id)).toMatchObject({ status: "done", text: "Answered without memory." })
    expect(asked).toEqual(["judge", "agent"])
  } finally { await engine.kill() }
})

test("a host with an injected failing memory source closes the answer before calling a model", async () => {
  const agent = await openAgent(runtime, () => Stream.die("source failure must precede model calls"))
  const engine = await agent.engine(undefined, { memorySources: Layer.succeed(Opening.Sources, {
    recall: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "injected storage fault" })),
  }) })
  try {
    const id = await agent.ask("Recall the launch")
    expect(await agent.answer(engine, id)).toEqual(Exit.succeed({ status: "failed" }))
  } finally { await engine.kill() }
})
