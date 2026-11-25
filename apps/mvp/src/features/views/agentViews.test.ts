import { Model, type ModelRequest } from "@smthrs/model"
import { Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import { stop, testFile, usage } from "../../../worker/test/harness.ts"
import { type Engine, openFlowHost } from "../../test/flowHost"
import { AskWithForm, RenderView, SetViewState } from "./flows"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "./renderer"

const runtime = testFile("agent-views-flow")

const engines: Array<Engine> = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.kill()
})

/** A test's budget: an agent run on a fresh engine, on a loaded machine. */
const WITHIN = 90_000

const textOf = (request: ModelRequest.ModelRequest) =>
  [...request.system.map((part) => part.text), ...request.messages.flatMap((message) =>
    message.content.map((part) => ("text" in part ? part.text : "")))].join("\n")

const reply = (text: string) => Stream.make({ type: "text-delta" as const, id: "t", text }, usage, stop)

/** The renderer's reply: a title and first state, and the module. */
const written = (code: string, state: unknown = TIC_TAC_TOE_STATE) =>
  "```json\n" + JSON.stringify({ title: "Tic-tac-toe", state }) + "\n```\n```tsx\n" + code + "\n```"

const CLONE_FORM = {
  title: "Which repository?",
  schema: { type: "object", properties: { url: { type: "string", title: "Repository URL" } }, required: ["url"] },
  submitLabel: "Clone",
}

const views = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly id: string
      readonly template: string
      readonly props: Record<string, unknown>
      readonly state: unknown
      readonly html: string | null
      readonly revision: number
    }>`SELECT id::text AS id, template, props, state, html, revision FROM views ORDER BY position`))

const host = async (renderer?: Model.Model) => {
  const opened = await openFlowHost(runtime, () => Stream.empty, renderer === undefined ? {} : { rendererModel: renderer })
  const engine = await opened.engine()
  engines.push(engine)
  return { ...opened, engine }
}

describe("ui/form", () => {
  test("adds a form and stores the person's submission as their next question", async () => {
    const { h, engine } = await host()
    const result = await Effect.runPromise(engine.flows.execute(AskWithForm, { executionId: crypto.randomUUID(), payload: CLONE_FORM }))
    const [form] = await views()
    expect(form).toMatchObject({ id: result.viewId, template: "form", props: CLONE_FORM, state: { submitted: false } })

    const submission = {
      id: crypto.randomUUID(),
      answerId: crypto.randomUUID(),
      text: "Clone",
      source: { viewId: form!.id, event: "submit" },
      data: { url: "https://github.com/octocat/Spoon-Knife" },
    }
    expect((await h.ask(submission)).status).toBe(202)
    expect((await views())[0]).toMatchObject({ state: { submitted: true, values: submission.data }, revision: 1 })
  }, WITHIN)

  test("a form that asks for a secret is refused before anything is added", async () => {
    const secret = { ...CLONE_FORM, schema: { type: "object", properties: { token: { type: "string", writeOnly: true } } } }
    const { engine } = await host()
    const result = await Effect.runPromise(Effect.exit(engine.flows.execute(AskWithForm, { executionId: crypto.randomUUID(), payload: secret })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(await views()).toEqual([])
  }, WITHIN)
})

describe("ui/render", () => {
  test("returns an invalid module to the renderer once and saves the corrected board", async () => {
    const renderer: Array<string> = []
    const { h, engine } = await host(Model.make({
      stream: (request) => {
        renderer.push(textOf(request))
        return reply(written(renderer.length === 1 ? `export default function View() { return <script>{"x"}</script> }` : TIC_TAC_TOE))
      },
    }))
    const result = await Effect.runPromise(engine.flows.execute(RenderView, {
      executionId: crypto.randomUUID(),
      payload: { description: "A tic-tac-toe board" },
    }))
    expect(renderer).toHaveLength(2)
    expect(renderer[1]).toContain("That view failed:")
    const [board] = await views()
    expect(board).toMatchObject({ id: result.viewId, template: "generated", state: TIC_TAC_TOE_STATE, revision: 0 })
    expect(board!.html).toContain(`data-event="cell:8"`)
    expect(h.line("chat.view.add").map((line) => line.annotations.status)).toEqual([422, 202])

    const move = (revision: number, arg: string) =>
      Effect.runPromise(Effect.exit(engine.flows.execute(SetViewState, {
        executionId: crypto.randomUUID(),
        payload: { viewId: board!.id, revision, event: { name: "cell", arg } },
      })))
    expect(await move(0, "4")).toEqual(Exit.succeed({ viewId: board!.id, revision: 1 }))
    expect((await views())[0]).toMatchObject({ state: { cells: ["", "", "", "", "X", "", "", "", ""] }, revision: 1 })
    const stale = await move(0, "0")
    expect(Exit.isFailure(stale)).toBe(true)
    expect(JSON.stringify(stale)).toContain("ViewStale")
  }, WITHIN)

  test("a renderer that never writes a module that renders fails ViewNotRendered after two corrections", async () => {
    let calls = 0
    const { engine } = await host(Model.make({
      stream: () => {
        calls++
        return reply("I can't do that.")
      },
    }))
    const result = await Effect.runPromise(Effect.exit(engine.flows.execute(RenderView, {
      executionId: crypto.randomUUID(),
      payload: { description: "A board" },
    })))
    expect(JSON.stringify(result)).toContain("ViewNotRendered")
    expect(calls).toBe(3)
    expect(await views()).toEqual([])
  }, WITHIN)
})
