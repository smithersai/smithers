import { Opening } from "@smthrs/memory"
// `chat/Answer` on the Node host (src/test/agent.ts): the browser's agent flow, its model calls through ChatApi's real
// model endpoint and its writes through the real answer routes, on the compose Postgres (`pnpm db:up`). The model is
// the only scripted seam. The same registration runs in the browser's engine worker (src/flows/engine.worker.ts), so
// passing here is the `sdk.host-agnostic-flows` proof for the agent.
import { SeatResolver } from "@smthrs/agent"
import { Sandbox } from "@smthrs/harness"
import { ModelError, ModelRequest } from "@smthrs/model"
import { Cause, Deferred, Effect, Exit, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import { contents, eventually, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { answerRow as row, cell, type Engine, openAgent } from "../../test/agent"
import { AnswerRun } from "../status/flows"
import { AnswerSettled } from "./answers"
import { MAX_FRAMES } from "./contract"
import { WORD_CORRECTIONS } from "./flows"
import { AGENT_SEAT, LIMITS, PLAN_SEAT, seats } from "./host"

const runtime = testFile("agent")

const probe = ModelRequest.ModelRequest.make({
  modelId: "agent",
  system: [],
  messages: [ModelRequest.Message.user("hi")],
  tools: [],
  params: ModelRequest.GenerationParams.make({}),
})

const engines: Array<Engine> = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.kill()
})

/** Prove a held run renewed after the exact backdated stamp, independent of polling delay. */
const backdateAndAwaitHeartbeat = async (
  agent: Awaited<ReturnType<typeof openAgent>>,
  answerId: string,
  within: number,
) => {
  const [before] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ stamp: number }>`
    UPDATE messages SET updated_at = now() - interval '35 seconds' WHERE id = ${answerId}
    RETURNING extract(epoch FROM updated_at)::float8 AS stamp`))
  let sampled: { renewed: boolean; ageMs: number; status: string; failure: string | null } | undefined
  await eventually(async () => {
    const [stamp] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<NonNullable<typeof sampled>>`
      SELECT extract(epoch FROM updated_at)::float8 > ${before!.stamp} AS renewed,
        extract(epoch FROM now() - updated_at)::float8 * 1000 AS "ageMs", status, failure
      FROM messages WHERE id = ${answerId}`))
    sampled = stamp
    return stamp!.renewed
  }, within).catch((cause) => {
    const heartbeats = agent.h.line("chat.answer.heartbeat").filter((line) => line.annotations.answerId === answerId)
      .map((line) => ({ status: line.annotations.status, renewed: line.annotations.renewed, errorCode: line.annotations.errorCode }))
    throw new Error(`Answer lease did not renew: ${JSON.stringify({ answerId, sampled, heartbeats })}`, { cause })
  })
}

/** A model that answers every call with the next of `cells`, the last one repeating. */
const answering = (...cells: ReadonlyArray<string>) => {
  const calls: Array<number> = []
  const script = () => {
    const source = cells[Math.min(calls.length, cells.length - 1)]!
    calls.push(calls.length)
    return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
  }
  return { script, calls }
}

describe("chat/Answer", () => {
  test("answers a question through the model endpoint and settles the answer with its text", async () => {
    const model = answering(`ctx.done("Hello from Smithers.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Say hello")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    const answer = await row(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Hello from Smithers.", inputTokens: 12, outputTokens: 34 })
    expect(model.calls).toHaveLength(1)
  })

  test("calls app/theme/set as a journaled step, and answers from its receipt", async () => {
    const model = answering(
      `const set = await ctx.call("app/theme/set", { mode: "dark" })\nconsole.log(JSON.stringify(set))`,
      `ctx.done("Dark mode is on.")`,
    )
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Switch to dark mode")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(agent.painted).toEqual(["dark"])
    expect(await Effect.runPromise(engine.theme.current)).toBe("dark")
    const answer = await row(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Dark mode is on." })
    expect(answer.parts).toEqual([{ id: "0.0", kind: "step", flow: "app/theme/set", status: "done" }])
    expect(model.calls).toHaveLength(2)
  })

  test("a flow that answered passes the !result.ok guard the model wrote, and the answer says it worked", async () => {
    // The guard gpt-4.1-mini put after `sandbox/write` on smithers.sh (2026-10-25, e2e/sandbox-tools.spec.ts "agent
    // tools"): the machine wrote the file, the call settled done, and the answer was "I couldn't write the file.",
    // because a success resolved `{ path, bytes }` with no `ok` (docs/features/sandbox-tools.md#the-flows).
    const model = answering(
      `const set = await ctx.call("app/theme/set", { mode: "dark" })
if (!set.ok) {
  ctx.done("I couldn't change the theme.")
}
ctx.done("Dark mode is on (" + set.mode + ").")`,
    )
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Switch to dark mode")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(agent.painted).toEqual(["dark"])
    const answer = await row(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Dark mode is on (dark)." })
    expect(answer.parts).toEqual([{ id: "0.0", kind: "step", flow: "app/theme/set", status: "done" }])
    expect(model.calls).toHaveLength(1)
  })

  test("streams the answer's text and steps to its row while the model writes, then settles the whole text", async () => {
    const release = Effect.runSync(Deferred.make<void>())
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      if (calls === 1) {
        return Stream.make(
          { type: "text-delta" as const, id: "t", text: cell(`await ctx.call("app/theme/set", { mode: "light" })`) },
          usage,
          stop,
        )
      }
      return Stream.concat(
        Stream.make({ type: "text-delta" as const, id: "t", text: "```cell\nctx.done(\"Light mode is" }),
        Stream.fromEffect(Deferred.await(release)).pipe(
          Stream.flatMap(() =>
            Stream.make({ type: "text-delta" as const, id: "t", text: " on.\")\n```" }, usage, stop)
          ),
        ),
      )
    })
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Light mode, please")

    const running = agent.start(engine, answerId)
    // The engine's run, with its model calls through ChatApi, can take seconds on a loaded machine.
    await eventually(async () => (await row(runtime, answerId)).text === "Light mode is", 20_000)
    const streaming = await row(runtime, answerId)
    Effect.runSync(Deferred.succeed(release, undefined))
    const exit = await running.done

    expect(streaming).toMatchObject({
      status: "streaming",
      parts: [{ id: "0.0", kind: "step", flow: "app/theme/set", status: "done" }],
    })
    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "done", text: "Light mode is on." })
  })

  test("resumes after the tab is killed mid-answer, without calling the model or the theme again for sealed steps", async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const resumed = Effect.runSync(Deferred.make<void>())
    const releaseResumed = Effect.runSync(Deferred.make<void>())
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      if (calls === 1) {
        return Stream.make(
          { type: "text-delta" as const, id: "t", text: cell(`await ctx.call("app/theme/set", { mode: "dark" })`) },
          usage,
          stop,
        )
      }
      // The second model call never ends in the first tab: the tab dies while the model writes.
      if (calls === 2) {
        return Stream.fromEffect(Deferred.succeed(reached, undefined)).pipe(Stream.flatMap(() => Stream.never))
      }
      return Stream.fromEffect(Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Deferred.await(releaseResumed)))).pipe(
        Stream.flatMap(() => Stream.make(
          { type: "text-delta" as const, id: "t", text: cell(`ctx.done("Dark mode is on.")`) }, usage, stop,
        )),
      )
    })
    const first = await agent.engine()
    engines.push(first)
    const answerId = await agent.ask("Dark mode")
    const running = agent.start(first, answerId)
    await Effect.runPromise(Deferred.await(reached))

    // The tab dies: its engine records nothing more. The next tab's engine takes the run over at once, as the browser's
    // leader does (`BrowserRuntime.isAlive`), and drives it. The dead engine is closed only after the run has finished.
    await first.crash()
    const second = await agent.engine(first.schema)
    engines.push(second)
    const resumedRun = agent.resume(second, answerId)
    await Effect.runPromise(Deferred.await(resumed))
    await backdateAndAwaitHeartbeat(agent, answerId, 10_000)
    // The sealed LoadTurn was replayed, yet the new incarnation renewed liveness.
    expect(agent.h.line("chat.answer.turn")).toHaveLength(1)
    Effect.runSync(Deferred.succeed(releaseResumed, undefined))
    const exit = await resumedRun
    await running.stop()
    await first.kill()

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    // One call sealed before the kill, one cut off by it, and one after: the sealed call isn't paid for again.
    expect(calls).toBe(3)
    expect(agent.painted).toEqual(["dark"])
    expect(await row(runtime, answerId)).toMatchObject({
      status: "done",
      text: "Dark mode is on.",
      parts: [{ id: "0.0", kind: "step", flow: "app/theme/set", status: "done" }],
    })
  }, 90_000)

  test("a silent reasoning model keeps its turn through confirmed host pulses, then releases history", async () => {
    const release = Effect.runSync(Deferred.make<void>())
    const reached = Effect.runSync(Deferred.make<void>())
    let calls = 0
    const prompts: Array<string> = []
    const agent = await openAgent(runtime, (request) => {
      prompts.push([...request.system.map((part) => part.text), ...contents(request)].join("\n"))
      calls++
      const reply = calls === 1 ? "First answer." : "Second answer."
      if (calls !== 1) return Stream.make({ type: "text-delta" as const, id: "t", text: cell(`ctx.done(${JSON.stringify(reply)})`) }, usage, stop)
      return Stream.concat(
        Stream.make({ type: "thinking-delta" as const, id: "r", text: "Private reasoning" }),
        Stream.fromEffect(Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
          Stream.flatMap(() => Stream.make({ type: "text-delta" as const, id: "t", text: cell(`ctx.done("First answer.")`) }, usage, stop)),
        ),
      )
    })
    const engine = await agent.engine()
    engines.push(engine)
    const first = await agent.ask("First question")
    const running = agent.start(engine, first)
    await Effect.runPromise(Deferred.await(reached))
    const second = await agent.ask("Second question")
    // Advance only the old last-write stamp: no model text or parts arrive.
    // The real driver's next confirmed pulse must renew it before admission.
    await backdateAndAwaitHeartbeat(agent, first, 10_000)
    expect(await row(runtime, first)).toMatchObject({ status: "streaming", text: "", parts: [] })
    expect((await agent.h.fetch(`/api/answers/${second}`)).status).toBe(409)
    expect(calls).toBe(1)
    Effect.runSync(Deferred.succeed(release, undefined))
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(await agent.answer(engine, second)).toEqual(Exit.succeed({ status: "done" }))
    expect(prompts[1]).toContain("Smithers: First answer.")
    const heartbeatCount = agent.h.line("chat.answer.heartbeat").length
    await Effect.runPromise(Effect.sleep(1_200))
    expect(agent.h.line("chat.answer.heartbeat")).toHaveLength(heartbeatCount)
  }, 90_000)

  test("heartbeat outages and terminal refusals leave ownership available for the next confirmed receipt", async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const agent = await openAgent(runtime, () => Stream.fromEffect(
      Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Stream.flatMap(() => Stream.make(
      { type: "text-delta" as const, id: "t", text: cell(`ctx.done("Recovered.")`) }, usage, stop,
    ))))
    let pulses = 0
    // Inject only failures into the browser's transport service. The driver,
    // ownership writes, credentials and successful routes remain real.
    const engine = await agent.engine(undefined, { fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === "PATCH" && new URL(request.url).pathname.startsWith("/api/answers/")) {
        pulses++
        if (pulses === 1) throw new TypeError("offline")
        if (pulses === 2) return new Response("{}", { status: 503 })
        if (pulses === 3) return new Response('{"code":"settled"}', { status: 409 })
      }
      return agent.fetch(request)
    } })
    engines.push(engine)
    const answerId = await agent.ask("Recover the connection")
    const running = agent.start(engine, answerId)
    try {
      await Effect.runPromise(Deferred.await(reached))
      await eventually(async () => pulses >= 4, 10_000)
      // A real later receipt still renews a silent answer after every refusal.
      await backdateAndAwaitHeartbeat(agent, answerId, 10_000)
      expect(await row(runtime, answerId)).toMatchObject({ status: "streaming", text: "" })
    } finally {
      Effect.runSync(Deferred.succeed(release, undefined))
    }
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "done", text: "Recovered." })
  }, 60_000)

  test("a held child tool renews its answer lease without new model or visible output", async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const model = answering(
      `await ctx.call("app/web/open", { url: "https://held-tool.example/article" })`,
      `ctx.done("Opened the page.")`,
    )
    // A faulty outside-page service stalls before headers; all app handlers,
    // child execution, durable stores and authenticated HTTP stay real.
    const agent = await openAgent(runtime, model.script, { fetch: async () => {
      Effect.runSync(Deferred.succeed(reached, undefined))
      await Effect.runPromise(Deferred.await(release))
      return new Response("<!doctype html><title>Page</title>", { headers: { "content-type": "text/html" } })
    } })
    const engine = await agent.engine()
    engines.push(engine)
    const first = await agent.ask("Open the page")
    const running = agent.start(engine, first)
    try {
      await Effect.runPromise(Deferred.await(reached))
      await eventually(async () => (await row(runtime, first)).parts.some((part) => part.flow === "app/web/open" && part.status === "running"), 5_000)
      await backdateAndAwaitHeartbeat(agent, first, 5_000)
      expect(model.calls).toHaveLength(1)
      expect((await row(runtime, first)).status).toBe("streaming")
      const second = await agent.ask("Next question")
      expect((await agent.h.fetch(`/api/answers/${second}`)).status).toBe(409)
    } finally {
      Effect.runSync(Deferred.succeed(release, undefined))
    }
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect((await row(runtime, first)).parts).toContainEqual(expect.objectContaining({ flow: "app/web/open", status: "done" }))
  }, 90_000)

  test("answers a settled answer's run again from its record, without calling the model", async () => {
    const model = answering(`ctx.done("Once.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Once?")

    await agent.answer(engine, answerId)
    const again = await agent.answer(engine, answerId)

    expect(again).toEqual(Exit.succeed({ status: "done" }))
    expect(model.calls).toHaveLength(1)
  })

  test("answers in turn: a later answer waits until the earlier one settles, then reads it in its history", async () => {
    const prompts: Array<string> = []
    const agent = await openAgent(runtime, (request) => {
      prompts.push(
        [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) => message.content.map((part) => ("text" in part ? part.text : ""))),
        ].join("\n"),
      )
      return Stream.make(
        { type: "text-delta" as const, id: "t", text: cell(`ctx.done("Answer ${prompts.length}.")`) },
        usage,
        stop,
      )
    })
    const engine = await agent.engine()
    engines.push(engine)
    const first = await agent.ask("First question")
    const second = await agent.ask("Second question")

    const later = agent.start(engine, second)
    const earlier = await agent.answer(engine, first)
    const exit = await later.done

    expect(earlier).toEqual(Exit.succeed({ status: "done" }))
    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("Person: First question")
    expect(prompts[1]).toContain("Smithers: Answer 1.")
    expect(await row(runtime, second)).toMatchObject({ status: "done", text: "Answer 2." })
  })

  // The agent evals caught answers quoting `app/web/open`, `flow_failed` and `WebPageRefused` (2026-10-20). The answer is
  // declared in product words, so one that names machinery goes back to the agent in its own session to say plainly.
  test("an answer naming machinery goes back to the agent once, and settles in the person's words", async () => {
    const prompts: Array<string> = []
    const replies = [
      `ctx.done("app/theme/set failed (flow_failed): PreferencesUnavailable.")`,
      `ctx.done("I couldn't change the theme.")`,
    ]
    const agent = await openAgent(runtime, (request) => {
      prompts.push(
        [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) => message.content.map((part) => ("text" in part ? part.text : ""))),
        ].join("\n"),
      )
      return Stream.make({ type: "text-delta" as const, id: "t", text: cell(replies.shift()!) }, usage, stop)
    })
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Switch to dark mode")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "done", text: "I couldn't change the theme." })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(
      `The person can't read "app/theme/set", "flow_failed", "PreferencesUnavailable". Say the same thing in their words`,
    )
  })

  test("an answer that names machinery after every correction fails rather than reach the person", async () => {
    const model = answering(`ctx.done("Done: app/theme/set.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Switch to dark mode")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect((await row(runtime, answerId)).status).toBe("failed")
    // The first answer and one more per correction.
    expect(model.calls).toHaveLength(1 + WORD_CORRECTIONS)
  })

  // The agent evals saw the agent save a draft it was only asked to create (2026-10-20). A flow the registry marks
  // `confirm` runs from the agent's call only once the person approves it.
  describe("a call the person must approve (flow/save)", () => {
    const draftId = "6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    const saving = () => {
      const seen: Array<string> = []
      const script = (request: Parameters<Parameters<typeof openAgent>[1]>[0]) => {
        const text = contents(request).join("\n")
        seen.push(text)
        const source = seen.length > 1
          ? `ctx.done("Handled.")`
          : `const saved = await ctx.call("flow/save", { draftId: "${draftId}" })\nconsole.log(JSON.stringify(saved))`
        return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
      }
      return { script, seen }
    }
    const waiting = (answerId: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly status: string; readonly wait: { readonly execution: string; readonly prompt: string } | null }>`
          SELECT status, wait FROM runs WHERE id = ${answerId}`)).then(([row]) => row)
    const decide = async (engine: Engine, answerId: string, approve: boolean) => {
      await eventually(async () => (await waiting(answerId))?.status === "needs_you", 60_000)
      const open = (await waiting(answerId))!
      expect(open.wait).toMatchObject({ prompt: "Save this draft as your flow?" })
      expect(open.wait!.execution).toMatch(/\/call\/0\.0\/confirm$/)
      await Effect.runPromise(engine.flows.execute(AnswerRun, {
        executionId: `answer-${answerId}`,
        payload: { runId: answerId, version: 1, execution: open.wait!.execution, value: approve },
      }))
    }

    test("denied, the flow never runs and the agent reads NotApproved", async () => {
      const model = saving()
      const agent = await openAgent(runtime, model.script)
      const engine = await agent.engine()
      engines.push(engine)
      const answerId = await agent.ask("Save my draft")
      const running = agent.start(engine, answerId)

      await decide(engine, answerId, false)

      expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
      // The call failed on the approval, before the flow ran: the flow's own failure never reached the cell.
      expect(model.seen[1]).toContain(`"message":"Flow flow/save failed: NotApproved"`)
    })

    // The flows eval `flow-delete-denied` saw the agent ask again, in other words, after the person said no.
    test("denied once, the same call again and the agent's own approval ask read no, and the person isn't asked again", async () => {
      const seen: Array<string> = []
      const script = (request: Parameters<Parameters<typeof openAgent>[1]>[0]) => {
        seen.push(contents(request).join("\n"))
        const source = seen.length === 1
          ? `await ctx.call("flow/save", { draftId: "${draftId}" })`
          : seen.length === 2
          ? [
            `let again = "ran"`,
            `try { await ctx.call("flow/save", { draftId: "${draftId}" }) } catch (error) { again = String(error) }`,
            `const asked = await ctx.call("app/agent/ask", { kind: "approval", prompt: "Really save it?" })`,
            `console.log(JSON.stringify({ again, asked }))`,
          ].join("\n")
          : `ctx.done("Left it.")`
        return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
      }
      const agent = await openAgent(runtime, script)
      const engine = await agent.engine()
      engines.push(engine)
      const answerId = await agent.ask("Save my draft")
      const running = agent.start(engine, answerId)

      await decide(engine, answerId, false)

      expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
      expect(seen[2]).toContain("flow/save failed: NotApproved")
      expect(seen[2]).toContain(`"asked":{"answered":true,"approved":false}`)
      // One question, the first: its version never moved on.
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly version: number }>`SELECT version FROM runs WHERE id = ${answerId}`)).then(([row]) => row?.version))
        .toBe(1)
    })

    test("approved, the flow runs", async () => {
      const model = saving()
      const agent = await openAgent(runtime, model.script)
      const engine = await agent.engine()
      engines.push(engine)
      const answerId = await agent.ask("Save my draft")
      const running = agent.start(engine, answerId)

      await decide(engine, answerId, true)

      expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
      // It ran, and failed on its own: there is no such draft.
      expect(model.seen[1]).not.toContain("NotApproved")
      expect(model.seen[1]).toContain("Flow flow/save failed")
    })
  })

  test("a plain 429 backs off durably and answers with the same request", async () => {
    const requests: Array<ModelRequest.ModelRequest> = []
    const reply = answering(`ctx.done("Recovered after a rate limit.")`)
    const agent = await openAgent(runtime, (request) => {
      requests.push(request)
      return requests.length === 1
        ? Stream.fail(new ModelError.ModelError({ code: "rate_limited", httpStatus: 429, message: "wait", retryAfterMillis: 1 }))
        : reply.script()
    })
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Wait for a rate window")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(await row(runtime, answerId)).toMatchObject({ status: "done", text: "Recovered after a rate limit." })
    expect(agent.h.line("model.quota.refused")).toHaveLength(0)
  })

  test.each([
    { code: "quota_exceeded" as const, httpStatus: 429 },
    { code: "out_of_credit" as const, httpStatus: 429 },
    { code: "provider_internal" as const, httpStatus: 402 },
  ])("a deployment refusal $code ($httpStatus) fails the answer on its first call", async ({ code, httpStatus }) => {
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      return Stream.fail(new ModelError.ModelError({
        code, httpStatus, message: "private provider detail", retryAfterMillis: 60_000,
        resetAtEpochMillis: Date.now() + 60_000, quotaScope: "model",
      }))
    })
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("A question refused for credit")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect(calls).toBe(1)
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "quota", text: "" })
  })

  test("a sealed quota refusal keeps its reason after a crash during settlement, with no new model call", async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 429, message: "private balance" }))
    })
    // Fault only the first incarnation's injected HTTP service. The durable
    // settlement stays pending; the next incarnation uses the real routes.
    const first = await agent.engine(undefined, { fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === "POST" && new URL(request.url).pathname.startsWith("/api/answers/") &&
        (await request.clone().json() as { status?: string }).status === "failed") {
        Effect.runSync(Deferred.succeed(reached, undefined))
        return new Response("{}", { status: 503 })
      }
      return agent.fetch(request)
    } })
    engines.push(first)
    const answerId = await agent.ask("Resume the refused answer")
    const running = agent.start(first, answerId)
    await Effect.runPromise(Deferred.await(reached))
    await first.crash()
    await running.stop()
    const second = await agent.engine(first.schema)
    engines.push(second)
    expect(await agent.resume(second, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "quota", text: "" })
    expect(calls).toBe(1)
  })

  test.each([
    { code: "provider_internal" as const, httpStatus: 402 },
    { code: "quota_exceeded" as const, httpStatus: 429 },
  ])("a deployment $code refusal during memory selection settles with the quota reason", async ({ code, httpStatus }) => {
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      return Stream.fail(new ModelError.ModelError({ code, httpStatus, message: "private balance", retryAfterMillis: 60_000 }))
    })
    const engine = await agent.engine(undefined, { memorySources: Layer.succeed(Opening.Sources, {
      recall: () => Effect.succeed([{ kind: "memory" as const, bank: "agent-chat", key: "launch", text: "A remembered fact" }]),
    }) })
    engines.push(engine)
    const answerId = await agent.ask("Recall a fact")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "quota" })
    expect(calls).toBe(1)
  })

  test("a model that refuses settles the answer failed, model_error", async () => {
    const agent = await openAgent(
      runtime,
      () => Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "refused" })),
    )
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Something it refuses")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "model_error", text: "" })
  })

  test("an agent that never answers settles the answer failed, unfinished, after its last frame", async () => {
    const model = answering(`console.log("thinking")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Think forever")

    const exit = await agent.answer(engine, answerId)

    expect(exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(model.calls.length).toBeGreaterThanOrEqual(MAX_FRAMES)
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "unfinished" })
  })

  test("an empty answer settles failed, empty", async () => {
    const agent = await openAgent(runtime, answering(`ctx.done("")`).script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Say nothing")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "empty" })
  })

  test("a turn whose queue doesn't move for the turn wait settles failed, unfinished, with no model call", async () => {
    const model = answering(`ctx.done("Never.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine(undefined, { turnWait: "1 seconds" })
    engines.push(engine)
    // The first answer's device never runs it, and it stays live past the turn wait, so the second never gets its turn.
    const first = await agent.ask("Asked on a device that went away")
    const second = await agent.ask("Asked here")

    const exit = await agent.answer(engine, second)

    expect(exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(model.calls).toHaveLength(0)
    expect(await row(runtime, second)).toMatchObject({ status: "failed", failure: "unfinished", text: "" })
    expect(await row(runtime, first)).toMatchObject({ status: "streaming" })
  })

  test("a burst's tail: an answer whose queue keeps moving waits past the turn wait counted from its start, and is answered", async () => {
    const model = answering(`ctx.done("At last.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine(undefined, { turnWait: "1 seconds" })
    engines.push(engine)
    // An earlier answer settled, and the routes count the turn's wait from then: here a moment the server's clock
    // hasn't reached, so the queue has always just moved (worker/Answers.test.ts proves how the wait is counted).
    const settled = await agent.ask("Answered before the burst")
    await agent.fetch(`http://chat.test/api/answers/${settled}`, {
      method: "POST",
      body: JSON.stringify({ status: "done", text: "Done." }),
    })
    await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE messages SET updated_at = now() + interval '1 hour' WHERE id = ${settled}`,
      ),
    )
    // The answer ahead is live, as on a device answering it; this device's run for the next one starts now.
    const ahead = await agent.ask("Ahead in the burst")
    const tail = await agent.ask("The burst's tail")
    const refusals = () =>
      agent.h.line("chat.answer.turn").filter((line) =>
        line.annotations.answerId === tail && line.annotations.status === 409
      ).length
    const running = agent.start(engine, tail)

    // Its fourth refusal comes at least 1.75 s after its start (the retries wait 250 ms, doubling): past a turn wait of
    // 1 s counted from the start, which would have settled it there. Then the answer ahead settles.
    await eventually(() => refusals() >= 4, 20_000)
    await agent.fetch(`http://chat.test/api/answers/${ahead}`, {
      method: "POST",
      body: JSON.stringify({ status: "failed", failure: "model_error" }),
    })

    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(model.calls).toHaveLength(1)
    expect(await row(runtime, tail)).toMatchObject({ status: "done", text: "At last." })
  })

  test("the turn wait is the server's record: a run killed while it waits settles on resume once its queue hasn't moved for the turn wait", async () => {
    const model = answering(`ctx.done("Never.")`)
    const agent = await openAgent(runtime, model.script)
    const first = await agent.engine()
    engines.push(first)
    await agent.ask("Asked on a device that went away")
    const answerId = await agent.ask("Asked here")
    const running = agent.start(first, answerId)
    // The run is waiting: the routes have answered it `not_your_turn`.
    await eventually(
      () => agent.h.line("chat.answer.turn").some((line) => line.annotations.answerId === answerId),
      20_000,
    )

    // The tab dies, and the app opens again an hour after the question was asked, with nothing ahead of it having
    // moved: the next engine, with the default turn wait (10 minutes), settles it on its first turn request.
    await first.crash()
    await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE messages SET created_at = now() - interval '1 hour' WHERE id = ${answerId}`,
      ),
    )
    const second = await agent.engine(first.schema)
    engines.push(second)
    const exit = await agent.resume(second, answerId)
    await running.stop()
    await first.kill()

    expect(exit).toEqual(Exit.succeed({ status: "failed" }))
    expect(model.calls).toHaveLength(0)
    expect(await row(runtime, answerId)).toMatchObject({ status: "failed", failure: "unfinished" })
  })

  test("a model's fractional token counts settle done, rounded, rather than kill the settle", async () => {
    const agent = await openAgent(runtime, () =>
      Stream.make(
        { type: "text-delta" as const, id: "t", text: cell(`ctx.done("Counted.")`) },
        { type: "usage" as const, inputTokens: 12.5, outputTokens: 3.2 },
        stop,
      ))
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Count")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))
    expect(await row(runtime, answerId)).toMatchObject({
      status: "done",
      text: "Counted.",
      inputTokens: 13,
      outputTokens: 3,
    })
  })

  test("an answer that settled some other way fails the run with AnswerSettled, and calls no model", async () => {
    const model = answering(`ctx.done("Late.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Already answered")
    await agent.fetch(`http://chat.test/api/answers/${answerId}`, {
      method: "POST",
      body: JSON.stringify({ status: "failed", failure: "model_error" }),
    })

    const exit = await agent.answer(engine, answerId)

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new AnswerSettled())
    expect(model.calls).toHaveLength(0)
  })
})

describe("the agent's sandbox commands", () => {
  test("a command's call is cut neither at its own timeout nor by the frame's backstop", () => {
    // 2026-10-22: a 570 s command with timeoutSeconds 600 settled 37 s past its timeout; the call was cut at 600 s.
    expect("callMs" in LIMITS).toBe(false)
    const ceiling = Sandbox.callLimit(Sandbox.defaultLimits.callMs, {
      input: { command: "sleep 570", timeoutSeconds: 600 },
    })
    expect(ceiling).toBe(1_200_000)
    expect(LIMITS.pauseTotalMsFor).toEqual(["sandbox/run"])
  })
})

describe("the agent's seats", () => {
  test("are the model endpoint's agent and plan roles, and resolve no other seat", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* SeatResolver.SeatResolver
        return [
          yield* resolver.resolve(AGENT_SEAT),
          yield* resolver.resolve(PLAN_SEAT),
          yield* Effect.flip(resolver.resolve("anthropic:other")),
        ] as const
      }).pipe(Effect.provide(seats("http://chat.test")), Effect.provide(FetchHttpClient.layer)),
    )

    expect(resolved[0]).toMatchObject({ id: "agent", modelId: "agent" })
    expect(await Effect.runPromise(resolved[0].route.prepare(probe))).toMatchObject({
      url: "http://chat.test/api/model/agent",
    })
    // Drafting a flow is a plan: its calls go to the `plan` role, which the endpoint answers on the `hard` tier.
    expect(resolved[1]).toMatchObject({ id: "plan", modelId: "plan" })
    expect(await Effect.runPromise(resolved[1].route.prepare(probe))).toMatchObject({
      url: "http://chat.test/api/model/plan",
    })
    expect(resolved[2]).toMatchObject({ seat: "anthropic:other" })
  })
})
