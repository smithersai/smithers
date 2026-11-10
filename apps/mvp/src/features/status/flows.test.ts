// Agent status's flows on the Node host (src/test/agent.ts): `chat/Answer` with a scripted model that calls
// `app/agent/ask`, the real runs and answer routes on the compose Postgres (`pnpm db:up`), and the engine the browser's
// worker runs. The model is the only scripted seam. Proves decision 0015 §2 to §4: the run reports its status as it
// goes, the question parks the run durably, and an answer resumes it, from this device or another.
import { Cause, Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import { contents, eventually, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { answerRow, cell, type Engine, openAgent } from "../../test/agent"
import { AnswerNotOpen, AnswerRun, Ask, answerOf, Deliver } from "./flows"
import { requesterOf } from "../../flows/requests"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const runtime = testFile("status")

/** A test that drives an engine through model calls and the routes: seconds each, more on a loaded machine. */
const ENGINE_WITHIN = 90_000

const engines: Array<Engine> = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.kill()
})

interface RunRow {
  readonly status: string
  readonly waiting: string | null
  readonly wait: { readonly execution: string; readonly kind: string; readonly prompt: string; readonly options: ReadonlyArray<string> } | null
  readonly version: number
  readonly answer: { readonly value: unknown } | null
  readonly flow: string
}

const runRow = async (runId: string) => {
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<RunRow>`SELECT status, waiting, wait, version, answer, flow FROM runs WHERE id = ${runId}`))
  return row
}

const statusOf = async (runId: string) => (await runRow(runId))?.status

/**
 * A model that asks with `ask` until its cell has printed what it heard, then finishes with `done`, and remembers what
 * each call saw. A request `finishes` accepts (the whole request, the question in its system context included) finishes
 * at once.
 */
const asking = (ask: string, done: string, finishes: (text: string) => boolean = () => false) => {
  const seen: Array<string> = []
  const script = (request: Parameters<Parameters<typeof openAgent>[1]>[0]) => {
    const text = contents(request).join("\n")
    seen.push(text)
    const source = text.includes(`"answered"`) || finishes(JSON.stringify(request))
      ? done
      : `const heard = await ctx.call("app/agent/ask", ${ask})\nconsole.log(JSON.stringify(heard))`
    return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
  }
  return { script, seen }
}

const execute = <A>(engine: Engine, effect: (flows: Engine["flows"]) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.exit(effect(engine.flows)))

describe("app/agent/ask", { timeout: ENGINE_WITHIN }, () => {
  test("the run reports working, then needs you with the question; an answer resumes it and it settles done", async () => {
    const model = asking(
      `{ kind: "question", prompt: "Which branch should I deploy?", options: ["main", "docs-v2"] }`,
      `ctx.done("Deploying docs-v2.")`,
    )
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Deploy the docs preview")

    const running = agent.start(engine, answerId)
    await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
    const open = (await runRow(answerId))!
    expect(open).toMatchObject({
      flow: "chat/Answer",
      waiting: "input",
      version: 1,
      answer: null,
      wait: { kind: "question", prompt: "Which branch should I deploy?", options: ["main", "docs-v2"] },
    })
    expect(requesterOf(open.wait!.execution)).toBe(answerId)
    expect((await answerRow(runtime, answerId)).status).toBe("streaming")
    expect(model.seen).toHaveLength(1)

    const answered = await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-${answerId}`,
        payload: { runId: answerId, version: 1, execution: open.wait!.execution, value: "docs-v2" },
      }))
    expect(answered).toEqual(Exit.succeed({ delivered: true }))

    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(await runRow(answerId)).toMatchObject({ status: "done", waiting: null, answer: { value: "docs-v2" } })
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "done", text: "Deploying docs-v2." })
    // The agent heard the answer, in its cell's printed output.
    expect(model.seen[1]).toContain(`{"answered":true,"answer":"docs-v2"}`)
    // The step shows as a part of the answer, like any flow call.
    expect((await answerRow(runtime, answerId)).parts).toEqual([{ id: "0.0", kind: "step", flow: "app/agent/ask", status: "done" }])
    // The server saw each status once, in order, and no line carries the question or the answer.
    expect(agent.h.line("agent.status.report").map((line) => [line.annotations.report, line.annotations.status])).toEqual([
      ["working", 200],
      ["needs_you", 200],
      ["working", 200],
      ["done", 200],
    ])
    expect(JSON.stringify(agent.h.logs)).not.toMatch(/Which branch|docs-v2/)
  })

  test("an approval takes Approve as true", async () => {
    const model = asking(`{ kind: "approval", prompt: "Delete the stale preview?" }`, `ctx.done("Deleted.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Clean up old previews")
    const running = agent.start(engine, answerId)
    await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
    const open = (await runRow(answerId))!
    expect(open).toMatchObject({ waiting: "approval", wait: { kind: "approval", options: [] } })
    // A question's words don't answer an approval.
    const refused = await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-words-${answerId}`,
        payload: { runId: answerId, version: 1, execution: open.wait!.execution, value: "yes" },
      }))
    expect(Exit.isFailure(refused)).toBe(true)
    expect(JSON.stringify(refused)).toContain("AnswerRefused")

    await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-${answerId}`,
        payload: { runId: answerId, version: 1, execution: open.wait!.execution, value: true },
      }))
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(model.seen[1]).toContain(`{"answered":true,"approved":true}`)
  })

  test("an approval's note reaches the agent, trimmed; an empty one is left out", async () => {
    for (const [value, heard] of [
      [{ approved: false, note: "  Keep the logs. " }, `{"answered":true,"approved":false,"note":"Keep the logs."}`],
      [{ approved: true, note: "  " }, `{"answered":true,"approved":true}`],
    ] as const) {
      const model = asking(`{ kind: "approval", prompt: "Delete the stale preview?" }`, `ctx.done("Done.")`)
      const agent = await openAgent(runtime, model.script)
      const engine = await agent.engine()
      engines.push(engine)
      const answerId = await agent.ask("Clean up old previews")
      const running = agent.start(engine, answerId)
      await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
      const open = (await runRow(answerId))!
      await execute(engine, (flows) =>
        flows.execute(AnswerRun, {
          executionId: `answer-${answerId}`,
          payload: { runId: answerId, version: 1, execution: open.wait!.execution, value },
        }))
      expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
      // The agent reads what it heard in the request after the ask, wherever the harness puts the cell's output in it.
      expect(model.seen.find((text) => text.includes(`"answered"`))).toContain(heard)
      expect((await runRow(answerId))!.answer).toEqual({ value: { approved: value.approved, note: value.note.trim() } })
    }
  })

  test("an answer recorded on another device reaches the run through run/deliver; a device without the run delivers nothing", async () => {
    const model = asking(`{ kind: "question", prompt: "Which branch?" }`, `ctx.done("Done.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    const elsewhere = await agent.engine()
    engines.push(engine, elsewhere)
    const answerId = await agent.ask("Deploy")
    const running = agent.start(engine, answerId)
    await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
    const { wait } = (await runRow(answerId))!

    // Another device answers: it records the answer, and its own engine holds no such run.
    const there = await execute(elsewhere, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-${answerId}`,
        payload: { runId: answerId, version: 1, execution: wait!.execution, value: "main" },
      }))
    expect(there).toEqual(Exit.succeed({ delivered: false }))
    expect(await statusOf(answerId)).toBe("needs_you")

    // This device sees the recorded answer and delivers it to the run it holds.
    const here = await execute(engine, (flows) =>
      flows.execute(Deliver, { executionId: `deliver-${answerId}-1`, payload: { execution: wait!.execution, value: "main" } }))
    expect(here).toEqual(Exit.succeed({ delivered: true }))
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(model.seen[1]).toContain(`"answer":"main"`)

    // Delivered again, nothing waits any more.
    const again = await execute(engine, (flows) =>
      flows.execute(Deliver, { executionId: `deliver-${answerId}-again`, payload: { execution: wait!.execution, value: "main" } }))
    expect(again).toEqual(Exit.succeed({ delivered: false }))
  })

  test("a second answer to an answered question is not open", async () => {
    const model = asking(`{ kind: "question", prompt: "Which branch?" }`, `ctx.done("Done.")`)
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Deploy")
    const running = agent.start(engine, answerId)
    await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
    const { wait } = (await runRow(answerId))!
    await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-1-${answerId}`,
        payload: { runId: answerId, version: 1, execution: wait!.execution, value: "main" },
      }))
    await running.done
    const late = await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-2-${answerId}`,
        payload: { runId: answerId, version: 1, execution: wait!.execution, value: "docs-v2" },
      }))
    expect(failureOf(late)).toEqual(new AnswerNotOpen())
  })

  test("a question that can't be shown isn't asked: the agent hears it wasn't answered", async () => {
    const agent = await openAgent(runtime, () => Stream.empty)
    const engine = await agent.engine()
    engines.push(engine)
    // No answer has this id, so the runs route refuses the question.
    const exit = await execute(engine, (flows) =>
      flows.execute(Ask, { executionId: `${crypto.randomUUID()}/call/0.0`, payload: { kind: "question", prompt: "Which?" } }))
    expect(exit).toEqual(Exit.succeed({ answered: false }))
    expect(agent.h.line("agent.status.report").map((line) => [line.annotations.report, line.annotations.status])).toEqual([
      ["needs_you", 404],
      ["working", 404],
    ])
  })

  test("a run killed while it needs you asks again when the next tab resumes it, and the answer finishes it", async () => {
    const model = asking(`{ kind: "question", prompt: "Which branch?" }`, `ctx.done("Resumed.")`)
    const agent = await openAgent(runtime, model.script)
    const first = await agent.engine()
    const answerId = await agent.ask("Deploy")
    const running = agent.start(first, answerId)
    await eventually(async () => (await statusOf(answerId)) === "needs_you", 60_000)
    const { wait } = (await runRow(answerId))!
    // The tab dies while the run waits: its engine records nothing more, and the next tab's engine takes the run over.
    await first.crash()
    await running.stop()
    await first.kill()
    const next = await agent.engine(first.schema)
    engines.push(next)
    const resumed = agent.resume(next, answerId)
    expect((await runRow(answerId))!).toMatchObject({ status: "needs_you", version: 1, wait })
    // Delivered once the resumed run parks on its question again.
    await eventually(async () =>
      Exit.isSuccess(await execute(next, (flows) =>
        flows.execute(Deliver, {
          executionId: `deliver-${crypto.randomUUID()}`,
          payload: { execution: wait!.execution, value: "main" },
        }).pipe(Effect.filterOrFail((result) => result.delivered)))), 60_000)
    expect(await resumed).toEqual(Exit.succeed({ status: "done" }))
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "done", text: "Resumed." })
    // The frame that asked was in flight when the tab died, so the next tab asked its model again; its call joined the
    // question already parked.
    expect(model.seen).toHaveLength(3)
    expect(await statusOf(answerId)).toBe("done")
  })
})

describe("chat/Answer's own reports", { timeout: ENGINE_WITHIN }, () => {
  test("an answer that waits for its turn reports waiting once, then working, then how it settled", async () => {
    // Select the complete question: matching "Second" also matches the real
    // catalog's timeoutSeconds field and incorrectly finishes First at once.
    const secondQuestion = "Second queued question for status ordering"
    const model = asking(`{ kind: "question", prompt: "Which branch?" }`, `ctx.done("Done.")`, (text) => text.includes(secondQuestion))
    const agent = await openAgent(runtime, model.script)
    const engine = await agent.engine()
    engines.push(engine)
    const first = await agent.ask("First")
    const second = await agent.ask(secondQuestion)
    const one = agent.start(engine, first)
    await expect.poll(() => statusOf(first), { timeout: 60_000 }).toBe("needs_you")
    expect((await answerRow(runtime, first)).status).toBe("streaming")
    expect(model.seen).toHaveLength(1)
    const two = agent.start(engine, second)
    await expect.poll(() => statusOf(second), { timeout: 60_000 }).toBe("waiting")
    expect((await runRow(second))!.waiting).toBe("turn")
    // It keeps asking for its turn, and reports waiting once.
    const refusedTurns = () =>
      agent.h.line("chat.answer.turn").filter((line) => line.annotations.answerId === second && line.annotations.status === 409)
    await expect.poll(() => refusedTurns().length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3)
    const waits = agent.h.line("agent.status.report").filter((line) =>
      line.annotations.runId === second && line.annotations.report === "waiting"
    )
    expect(waits).toHaveLength(1)

    const { wait } = (await runRow(first))!
    await execute(engine, (flows) =>
      flows.execute(AnswerRun, {
        executionId: `answer-${first}`,
        payload: { runId: first, version: 1, execution: wait!.execution, value: "main" },
      }))
    expect(await one.done).toEqual(Exit.succeed({ status: "done" }))
    expect(await two.done).toEqual(Exit.succeed({ status: "done" }))
    expect(await statusOf(second)).toBe("done")
  })

  test("a failed answer reports failed", async () => {
    const agent = await openAgent(runtime, () => Stream.make({ type: "text-delta" as const, id: "t", text: cell(`ctx.done("")`) }, usage, stop))
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Say nothing")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "failed" }))
    expect(await statusOf(answerId)).toBe("failed")
  })
})

describe("answerOf", { timeout: ENGINE_WITHIN }, () => {
  test("keeps words, decisions and decisions with a note, and nothing else", () => {
    expect(answerOf("main")).toBe("main")
    expect(answerOf(false)).toBe(false)
    expect(answerOf({ approved: true, note: "Go." })).toEqual({ approved: true, note: "Go." })
    for (const value of [null, 1, {}, [], { approved: true }, { approved: "yes", note: "" }, { approved: true, note: 1 }]) {
      expect(answerOf(value)).toBeNull()
    }
  })
})
