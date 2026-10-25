// The views flows' failure paths (docs/features/views.md#the-flows): `ui/form`, `ui/render` and `view/set-state` on the
// Node host's engine (worker/test/flowHost.ts) against ChatApi's real views routes on this file's schema of the compose
// Postgres (`pnpm db:up`), with faults injected as test implementations of their services: a views client that refuses
// or fails, and a renderer whose model fails. The happy paths, with the agent calling them, are agentViews.test.ts.
import { Action, FlowRuntime } from "@smthrs/flow"
import { Model, ModelError } from "@smthrs/model"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { build } from "../../../worker/test/flowHost.ts"
import { harness, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { ViewRefused, ViewsClient } from "./api"
import { AskWithForm, RenderView, SetViewState, ShowIssues, ShowRepo } from "./flows"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "./renderer"
import { registration, RendererSeat } from "./steps"

const runtime = testFile("views-steps")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

const WITHIN = 90_000

const CLONE_FORM = {
  title: "Which repository?",
  schema: { type: "object", properties: { url: { type: "string", title: "Repository URL" } }, required: ["url"] },
  submitLabel: "Clone",
}

/** A renderer that writes the tic-tac-toe module. */
const writesBoard = Model.make({
  stream: () =>
    Stream.make(
      {
        type: "text-delta" as const,
        id: "t",
        text: "```json\n" + JSON.stringify({ title: "Tic-tac-toe", state: TIC_TAC_TOE_STATE }) + "\n```\n```tsx\n" +
          TIC_TAC_TOE + "\n```",
      },
      usage,
      stop,
    ),
})

/** A renderer whose every call fails with `code`. */
const failing = (code: "no_route" | "unknown") =>
  Model.make({ stream: () => Stream.fail(new ModelError.ModelError({ code, message: "failed" })) })

/**
 * The three flows on a fresh engine, adding views through ChatApi's real routes as a Member, with `views` around the
 * real client and `model` as the renderer when set.
 */
const openEngine = async (options: {
  readonly views?: (real: ViewsClient["Service"]) => ViewsClient["Service"]
  readonly model?: Model.Model
  readonly maxTokens?: number
} = {}) => {
  const h = await harness(runtime, () => Stream.empty, { actor: member })
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }
  const real = ViewsClient.layer({ origin: "http://chat.test" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const views = options.views === undefined
    ? real
    : Layer.effect(ViewsClient, Effect.map(Effect.service(ViewsClient), options.views)).pipe(Layer.provide(real))
  const seat = RendererSeat.layer("http://chat.test", options.model ?? writesBoard, options.maxTokens)
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const { context } = await Effect.runPromise(
    Scope.provide(scope)(
      build(registration.pipe(Layer.provideMerge(Action.layerImplementations), Layer.provide(views), Layer.provide(seat))),
    ),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  return {
    h,
    form: (payload: Record<string, unknown> = CLONE_FORM) =>
      Effect.runPromise(Effect.exit(flows.execute(AskWithForm, { executionId: crypto.randomUUID(), payload: payload as never }))),
    render: (data?: Record<string, unknown>) =>
      Effect.runPromise(Effect.exit(flows.execute(RenderView, {
        executionId: crypto.randomUUID(),
        payload: { description: "A tic-tac-toe board", ...(data === undefined ? {} : { data }) },
      }))),
    move: (viewId: string, revision = 0) =>
      Effect.runPromise(Effect.exit(flows.execute(SetViewState, {
        executionId: crypto.randomUUID(),
        payload: { viewId, revision, event: { name: "cell", arg: "4" } },
      }))),
    repo: (payload: Record<string, unknown>) =>
      Effect.runPromise(Effect.exit(flows.execute(ShowRepo, { executionId: crypto.randomUUID(), payload: payload as never }))),
    issues: (payload: Record<string, unknown>) =>
      Effect.runPromise(Effect.exit(flows.execute(ShowIssues, { executionId: crypto.randomUUID(), payload: payload as never }))),
  }
}

/** A client that answers every `add` or `setState` with `status`, and otherwise is `real`. */
const refusing = (status: number, method: "add" | "setState", times = Infinity) => (real: ViewsClient["Service"]) => {
  let left = times
  return ViewsClient.of({
    add: (write) => method === "add" && left-- > 0 ? Effect.fail(new ViewRefused({ status })) : real.add(write),
    setState: (viewId, write) =>
      method === "setState" && left-- > 0 ? Effect.fail(new ViewRefused({ status })) : real.setState(viewId, write),
  })
}

/** The failure's tag, for an exit that failed. */
const tagOf = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit).match(/"_tag":"(@smthrs\/mvp\/views\/\w+)"/)?.[1]

describe("ui/form", () => {
  test("ChatApi refusing the person is ViewForbidden; refusing the form is FormRefused; failing once is tried again", async () => {
    expect(tagOf(await (await openEngine({ views: refusing(403, "add") })).form())).toBe("@smthrs/mvp/views/ViewForbidden")
    expect(tagOf(await (await openEngine({ views: refusing(400, "add") })).form())).toBe("@smthrs/mvp/views/FormRefused")
    const flaky = await openEngine({ views: refusing(503, "add", 1) })
    expect(await flaky.form()).toEqual(Exit.succeed({ viewId: expect.any(String), shown: "form" }))
  }, WITHIN)

  test("a form with no submit label is sent with Send", async () => {
    const engine = await openEngine()
    const { submitLabel: _label, ...unlabelled } = CLONE_FORM
    expect(Exit.isSuccess(await engine.form(unlabelled))).toBe(true)
    expect(engine.h.only("chat.view.add").annotations).toMatchObject({ status: 202, template: "form" })
  }, WITHIN)

  test("a schema with no field the form renders is refused before anything is sent", async () => {
    const engine = await openEngine()
    const exit = await engine.form({ ...CLONE_FORM, schema: { type: "string" } })
    expect(tagOf(exit)).toBe("@smthrs/mvp/views/FormRefused")
    expect(engine.h.line("chat.view.add")).toEqual([])
  }, WITHIN)
})

describe("ui/render", () => {
  test("the renderer uses its seat's output allowance for every attempt", async () => {
    const allowances: Array<number | undefined> = []
    const model = Model.make({ stream: (request) => {
      allowances.push(request.params.maxTokens)
      // The first malformed reply exercises a correction with the same configured allowance.
      return allowances.length === 1 ? Stream.make(usage, stop) : writesBoard.stream(request)
    } })
    expect(Exit.isSuccess(await (await openEngine({ model, maxTokens: 6_000 })).render())).toBe(true)
    expect(allowances).toEqual([6_000, 6_000])
  }, WITHIN)

  test("a renderer with no model for its role is ViewNotRendered unconfigured; one that fails, unavailable", async () => {
    expect(JSON.stringify(await (await openEngine({ model: failing("no_route") })).render())).toContain('"unconfigured"')
    expect(JSON.stringify(await (await openEngine({ model: failing("unknown") })).render())).toContain('"unavailable"')
  }, WITHIN)

  test("ChatApi refusing the person is ViewForbidden", async () => {
    expect(tagOf(await (await openEngine({ views: refusing(403, "add") })).render())).toBe("@smthrs/mvp/views/ViewForbidden")
  }, WITHIN)

  test("a view ChatApi took without naming its events answers none; its data goes to ChatApi as props", async () => {
    const quiet = (real: ViewsClient["Service"]) =>
      ViewsClient.of({ ...real, add: (write) => Effect.as(real.add(write), { txid: null }) })
    const exit = await (await openEngine({ views: quiet })).render({ cells: 9 })
    expect(Exit.isSuccess(exit) && exit.value.interactions).toEqual({})
  }, WITHIN)

  test("answers the module's declared events, which the agent moves by", async () => {
    const exit = await (await openEngine()).render()
    expect(exit).toEqual(Exit.succeed({
      viewId: expect.any(String),
      title: "Tic-tac-toe",
      size: "inline",
      revision: 0,
      interactions: { cell: { kind: "state" }, reset: { kind: "state" } },
    }))
  }, WITHIN)
})

describe("view/set-state", () => {
  test("a move ChatApi won't make is MoveRefused, a person it refuses ViewForbidden, and a failure tried again", async () => {
    const engine = await openEngine()
    expect(tagOf(await engine.move(crypto.randomUUID()))).toBe("@smthrs/mvp/views/MoveRefused")
    const board = await engine.render()
    const viewId = Exit.isSuccess(board) ? board.value.viewId : ""
    expect(tagOf(await (await openEngine({ views: refusing(403, "setState") })).move(viewId))).toBe(
      "@smthrs/mvp/views/ViewForbidden",
    )
    const flaky = await openEngine({ views: refusing(503, "setState", 1) })
    expect(await flaky.move(viewId)).toEqual(Exit.succeed({ viewId, revision: 1 }))
  }, WITHIN)
})

describe("ui/repo and ui/issues", () => {
  test("add the repository's view with what it opens, and its issues view, to the conversation", async () => {
    const engine = await openEngine()
    const repo = await engine.repo({ repo: "octocat/Spoon-Knife", ref: "main", path: "README.md", kind: "blob" })
    expect(repo).toEqual(Exit.succeed({ viewId: expect.any(String), shown: "repo" }))
    expect(await engine.issues({ repo: "octocat/Spoon-Knife" })).toEqual(
      Exit.succeed({ viewId: expect.any(String), shown: "issues" }),
    )
    expect(engine.h.line("chat.view.add").map((line) => [line.annotations.status, line.annotations.template])).toEqual([
      [202, "repo"],
      [202, "issues"],
    ])
    const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly props: unknown }>`SELECT props FROM views WHERE id = ${Exit.isSuccess(repo) ? repo.value.viewId : ""}`))
    expect(row?.props).toEqual({ repo: "octocat/Spoon-Knife", ref: "main", path: "README.md", kind: "blob" })
  }, WITHIN)

  test("a view ChatApi won't keep is TemplateRefused; a person it refuses ViewForbidden; a failure is tried again", async () => {
    // No such conversation: 404, final.
    const engine = await openEngine()
    expect(tagOf(await engine.repo({ repo: "octocat/Spoon-Knife", conversationId: crypto.randomUUID() }))).toBe(
      "@smthrs/mvp/views/TemplateRefused",
    )
    for (const status of [400, 409]) {
      expect(tagOf(await (await openEngine({ views: refusing(status, "add") })).issues({ repo: "octocat/Spoon-Knife" })))
        .toBe("@smthrs/mvp/views/TemplateRefused")
    }
    expect(tagOf(await (await openEngine({ views: refusing(403, "add") })).repo({ repo: "octocat/Spoon-Knife" }))).toBe(
      "@smthrs/mvp/views/ViewForbidden",
    )
    const flaky = await openEngine({ views: refusing(503, "add", 1) })
    expect(await flaky.issues({ repo: "octocat/Spoon-Knife" })).toEqual(
      Exit.succeed({ viewId: expect.any(String), shown: "issues" }),
    )
    expect(flaky.h.line("chat.view.add").map((line) => line.annotations.status)).toEqual([202])
  }, WITHIN)

  test("a repository GitHub couldn't have never reaches ChatApi", async () => {
    const engine = await openEngine()
    expect(Exit.isFailure(await engine.repo({ repo: "app/widgets" }))).toBe(true)
    expect(Exit.isFailure(await engine.repo({ repo: "octocat/Spoon-Knife", path: "../up" }))).toBe(true)
    expect(engine.h.line("chat.view.add")).toEqual([])
  }, WITHIN)
})
