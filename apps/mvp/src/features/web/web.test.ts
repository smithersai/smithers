// `app/web/open` (docs/features/web-pages.md): its steps on the Node host's engine (worker/test/flowHost.ts) against
// ChatApi's real page check and views route on this file's schema of the compose Postgres (`pnpm db:up`); the agent's
// call from a cell (src/test/agent.ts); the clients' own failures; and a person's door, whose gesture rules run without a
// browser. Outside pages answer from worker/test/pages.ts. The whole app, with `/web` and the views syncing to every tab,
// is src/features/views/views.test.ts. Faults are injected as test implementations of Effect services: a client that
// fails once, and a fetch that fails.
import { Action, FlowRuntime } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Logger, Metric, Option, Scope, Stream, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { build } from "../../../worker/test/flowHost.ts"
import { tracked } from "../../../worker/test/branch.ts"
import { contents, harness, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { framable, outsideWeb, type Page, refusing } from "../../../worker/test/pages.ts"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { answerRow, cell, type Engine, openAgent } from "../../test/agent"
import { COMMANDS } from "../commands/catalog"
import { ViewRefused, ViewsClient } from "../views/api"
import { DispatchFailed, type Dispatched, FlowDispatch } from "../../flows/dispatch"
import { dispatchOpen, openFromGesture, refusedPage, WebTab } from "./actions"
import { PreviewClient, PreviewRefused } from "./api"
import { WEB_TELEMETRY } from "./contract"
import { OpenWebPage, WebPageForbidden, WebPageRefused, WebPageUnavailable } from "./flows"
import { pagesOpened } from "./metrics"
import { registration, WebPolicy } from "./steps"

const runtime = testFile("web")

/** The app's origin under the dev server: the policy's own. */
const APP = "http://localhost:1337"

/** An agent's call of the flow, as the catalog names it: a child of the answer's run. */
const agentCall = (n: number) => `answer-${n}/chat/Respond@abc:1/call/1.0`

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const scopes: Array<Scope.Closeable> = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** A test's budget: flows on a fresh engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

/** The views Postgres holds, in the conversation's order. */
const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly template: string; readonly props: Record<string, string> }>`
      SELECT id::text AS id, template, props FROM views ORDER BY position`))

/** The conversation of every view Postgres holds, in the conversation's order. */
const conversationsOfViews = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly conversationId: string }>`SELECT conversation_id::text AS "conversationId" FROM views ORDER BY position`))
    .then((rows) => rows.map(({ conversationId }) => conversationId))

/**
 * `app/web/open` on the Node host's engine, adding views through ChatApi's real route as `actor` (a Member unless
 * `null`), with the policy of an app on `APP` (`localHttp` as set), and `views` in place of the real client when set.
 * Every log line, span and count is kept.
 */
/** The outside web these tests reach: pages that allow framing, and one that refuses it. */
const PAGES: Record<string, Page> = {
  "https://example.com/": framable("Example"),
  "https://example.com/docs": framable("Example docs"),
  "https://refuses.example/": refusing("Refuses"),
}

const openEngine = async (options: {
  readonly actor?: Actor | null
  readonly localHttp?: boolean
  readonly views?: (real: Layer.Layer<ViewsClient>) => Layer.Layer<ViewsClient>
  readonly previews?: (real: Layer.Layer<PreviewClient>) => Layer.Layer<PreviewClient>
  readonly pages?: Record<string, Page>
} = {}) => {
  const h = await harness(runtime, () => Stream.empty, {
    fetch: outsideWeb(options.pages ?? PAGES),
    ...(options.actor === null ? {} : { actor: options.actor ?? member }),
  })
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }
  const real = ViewsClient.layer({ origin: "http://chat.test" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const realPreviews = PreviewClient.layer({ origin: "http://chat.test" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
  // The engine runs a step with the services it was built with, so the records go where the build's did.
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span: (o) => {
            const span = new Tracer.NativeSpan(o)
            spans.push(span)
            return span
          },
        }),
      ),
      Effect.provideService(Metric.MetricRegistry, registry),
    )
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const { context } = await Effect.runPromise(
    observed(
      Scope.provide(scope)(
        build(
          registration.pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provide(options.views === undefined ? real : options.views(real)),
            Layer.provide(options.previews === undefined ? realPreviews : options.previews(realPreviews)),
            Layer.provide(WebPolicy.layer({ localHttp: options.localHttp ?? false, appOrigin: APP })),
          ),
        ),
      ),
    ),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  return {
    open: (
      executionId: string,
      payload: { readonly url: string; readonly mode?: "embed" | "tab"; readonly conversationId?: string },
    ) =>
      Effect.runPromise(observed(Effect.exit(flows.execute(OpenWebPage, { executionId, payload })))),
    count: (attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(pagesOpened, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    lines: () => logs.filter((log) => log.message === "web.page.open"),
    spans: () => spans.filter((span) => span.name === "web.page.open"),
    h,
  }
}

describe("the flow", () => {
  test("embed of a page that allows framing adds a webpage view with its preview, and answers that the page shows", async () => {
    const engine = await openEngine()

    const exit = await engine.open("web-1", { url: "https://example.com/docs" })

    const [view] = await rows()
    expect(exit).toEqual(
      Exit.succeed({
        viewId: view!.id,
        origin: "https://example.com",
        mode: "embed",
        shown: "page",
        framing: "allowed",
        title: "Example docs",
      }),
    )
    expect(view).toMatchObject({
      template: "webpage",
      props: {
        url: "https://example.com/docs",
        title: "Example docs",
        description: "A page that lets others frame it.",
        icon: "https://example.com/icon.png",
      },
    })
    // A person's dispatch is counted by the tab that knows their door, not here.
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "embedded" })).toBe(0)
    expect(engine.lines()).toEqual([])
    expect(Object.fromEntries(engine.spans().at(-1)!.attributes)).toMatchObject({
      "smithers.web.mode": "embed",
      "smithers.web.outcome": "embedded",
    })
  }, WITHIN)

  test("tab adds a link card; the agent's opening is counted and logged by its door and outcome", async () => {
    const engine = await openEngine()

    const exit = await engine.open(agentCall(1), { url: "https://example.com/", mode: "tab" })

    expect(exit).toEqual(
      Exit.succeed({
        viewId: expect.any(String),
        origin: "https://example.com",
        mode: "tab",
        shown: "card",
        framing: "allowed",
        title: "Example",
      }),
    )
    expect((await rows()).map((row) => [row.template, row.props.title])).toEqual([["link", "Example"]])
    expect(engine.count({ web_mode: "tab", door: "agent", outcome: "card", web_framing: "allowed" })).toBe(1)
    expect(engine.lines()).toEqual([
      expect.objectContaining({
        level: "INFO",
        annotations: expect.objectContaining({ web_mode: "tab", door: "agent", outcome: "card", web_framing: "allowed" }),
      }),
    ])
  }, WITHIN)

  test("embed of a page that refuses framing, or can't be checked, adds a card, and answers that a card shows instead", async () => {
    const engine = await openEngine()

    const refused = await engine.open(agentCall(1), { url: "https://refuses.example/" })
    const offline = await engine.open(agentCall(2), { url: "https://offline.example/" })

    const [card, unchecked] = await rows()
    expect(refused).toEqual(
      Exit.succeed({
        viewId: card!.id,
        origin: "https://refuses.example",
        mode: "embed",
        shown: "card",
        framing: "refused",
        title: "Refuses",
      }),
    )
    expect(card).toMatchObject({
      template: "link",
      props: {
        url: "https://refuses.example/",
        title: "Refuses",
        description: "A page that never shows in a frame.",
        icon: "https://refuses.example/favicon.ico",
      },
    })
    expect(offline).toEqual(
      Exit.succeed({
        viewId: unchecked!.id,
        origin: "https://offline.example",
        mode: "embed",
        shown: "card",
        framing: "unknown",
      }),
    )
    expect(unchecked).toMatchObject({ template: "link", props: { url: "https://offline.example/" } })
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "card", web_framing: "refused" })).toBe(1)
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "card", web_framing: "unknown" })).toBe(1)
    expect(Object.fromEntries(engine.spans().at(-1)!.attributes)).toMatchObject({
      "smithers.web.outcome": "card",
      "smithers.web.framing": "unknown",
    })
  }, WITHIN)

  test("refuses javascript:, data:, file: and blob: pages, the app's own origin and an embed of its site", async () => {
    const engine = await openEngine({ localHttp: true })
    const refused = [
      ["javascript:alert(document.cookie)", "embed", "scheme"],
      ["data:text/html,<script>alert(1)</script>", "tab", "scheme"],
      ["file:///etc/passwd", "embed", "scheme"],
      ["blob:https://example.com/4b1d", "tab", "scheme"],
      // The app itself on :1337: a frame of it is refused before anything else, and a tab of it is app/navigate's.
      [`${APP}/app`, "embed", "insecure"],
      ["https://localhost:1337/app", "embed", "same_origin"],
      [`${APP}/app`, "tab", "same_origin"],
      ["https://localhost:4000/", "embed", "same_site"],
      ["http://localhost:4000/", "embed", "insecure"],
    ] as const
    for (const [index, [url, mode, reason]] of refused.entries()) {
      expect([url, mode, await engine.open(agentCall(index), { url, mode })]).toEqual([
        url,
        mode,
        Exit.fail(new WebPageRefused({ reason })),
      ])
    }
    expect(await rows()).toEqual([])
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "refused" })).toBe(6)
    expect(engine.count({ web_mode: "tab", door: "agent", outcome: "refused" })).toBe(3)
    expect(engine.lines().at(-1)).toMatchObject({ level: "WARN", annotations: { outcome: "refused", reason: "insecure" } })
  }, WITHIN)

  test("a page ChatApi won't keep is refused; a person who may not add views is forbidden", async () => {
    // The device's policy allows its own http://localhost; this ChatApi, configured as a deployment, does not.
    const engine = await openEngine({ localHttp: true })
    expect(await engine.open(agentCall(1), { url: "http://localhost:4000/", mode: "tab" })).toEqual(
      Exit.fail(new WebPageRefused({ reason: "invalid" })),
    )
    const signedOut = await openEngine({ actor: null })
    expect(await signedOut.open(agentCall(2), { url: "https://example.com/" })).toEqual(Exit.fail(new WebPageForbidden()))
    expect(signedOut.count({ web_mode: "embed", door: "agent", outcome: "forbidden" })).toBe(1)
    expect(await rows()).toEqual([])
  }, WITHIN)

  test("ChatApi failing is tried again by the step's retry policy, and the view is added once", async () => {
    let failures = 0
    const engine = await openEngine({
      views: (real) =>
        Layer.effect(
          ViewsClient,
          Effect.map(Effect.service(ViewsClient), (client) =>
            ViewsClient.of({
              ...client,
              add: (write) => failures++ === 0 ? Effect.fail(new ViewRefused({ status: 503 })) : client.add(write),
            })),
        ).pipe(Layer.provide(real)),
    })

    const exit = await engine.open(agentCall(1), { url: "https://example.com/" })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await rows()).toHaveLength(1)
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "unavailable", web_framing: "allowed" })).toBe(1)
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "embedded", web_framing: "allowed" })).toBe(1)
  }, WITHIN)

  test("a check ChatApi can't answer is tried again by the step's retry policy; one it refuses fails the call", async () => {
    let failures = 0
    const engine = await openEngine({
      previews: (real) =>
        Layer.effect(
          PreviewClient,
          Effect.map(Effect.service(PreviewClient), (client) =>
            PreviewClient.of({
              check: (page) =>
                page.url === "https://example.com/" && failures++ === 0
                  ? Effect.fail(new PreviewRefused({ status: 503 }))
                  : page.url === "https://refuses.example/"
                  ? Effect.fail(new PreviewRefused({ status: 400 }))
                  : page.url === "https://example.com/docs"
                  ? Effect.fail(new PreviewRefused({ status: 403 }))
                  : client.check(page),
            })),
        ).pipe(Layer.provide(real)),
    })

    expect(Exit.isSuccess(await engine.open(agentCall(1), { url: "https://example.com/" }))).toBe(true)
    expect(await engine.open(agentCall(2), { url: "https://refuses.example/" })).toEqual(
      Exit.fail(new WebPageRefused({ reason: "invalid" })),
    )
    expect(await engine.open(agentCall(3), { url: "https://example.com/docs" })).toEqual(Exit.fail(new WebPageForbidden()))
    expect((await rows()).map((row) => row.template)).toEqual(["webpage"])
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "unavailable" })).toBe(1)
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "refused" })).toBe(1)
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "forbidden" })).toBe(1)
  }, WITHIN)

  test("a person's run adds the view to the conversation its payload names, as a run resumed from its journal does", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, "github/octo/hello", `feature/${crypto.randomUUID()}`)

    // The payload as the person's tab pinned it when they sent `/web`, in any case: the steps read only the payload,
    // never a tab, so a run resumed after its tab closed decides the same.
    const exit = await engine.open("web-branch-1", {
      url: "https://example.com/",
      conversationId: branch.conversationId.toUpperCase(),
    })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await conversationsOfViews()).toEqual([branch.conversationId])
  }, WITHIN)

  test("an agent's call adds the view to its answer's conversation, whatever its payload names", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, "github/octo/hello", `feature/${crypto.randomUUID()}`)
    const ids = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
    const asked = await engine.h.fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ids, text: "Show me example.com", conversationId: branch.conversationId }),
    })
    expect(asked.status).toBe(202)

    // A child of the answer's run, in upper case as a host may print it; its payload names the home conversation.
    const exit = await engine.open(`${ids.answerId.toUpperCase()}/chat/Respond@abc:1/call/1.0`, {
      url: "https://example.com/",
    })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await conversationsOfViews()).toEqual([branch.conversationId])
    expect(engine.count({ web_mode: "embed", door: "agent", outcome: "embedded", web_framing: "allowed" })).toBe(1)
  }, WITHIN)

  test("records carry the mode, door and outcome, never the page", async () => {
    const engine = await openEngine()
    const sentinel = "sentinel-5e6f7a"

    const pages = { [`https://example.com/${sentinel}?q=${sentinel}`]: refusing(sentinel) }
    const sentinelEngine = await openEngine({ pages })
    await sentinelEngine.open(agentCall(1), { url: `https://example.com/${sentinel}?q=${sentinel}` })
    await sentinelEngine.open(agentCall(2), { url: `javascript:${sentinel}` })
    expect(sentinelEngine.lines().map((line) => line.annotations.outcome)).toEqual(["card", "refused"])
    await engine.open(agentCall(3), { url: `https://example.com/${sentinel}` })

    const records = JSON.stringify({
      logs: [...engine.lines(), ...sentinelEngine.lines()],
      spans: [...engine.spans(), ...sentinelEngine.spans()].map((span) => Object.fromEntries(span.attributes)),
    })
    expect(records).not.toContain(sentinel)
    expect(records).not.toContain("example.com")
    for (const log of [...engine.lines(), ...sentinelEngine.lines()]) {
      for (const field of Object.keys(log.annotations)) expect(BROWSER_TELEMETRY.fields).toContain(field)
    }
    expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...WEB_TELEMETRY.records]))
  }, WITHIN)
})

describe("the agent", () => {
  const engines: Array<Engine> = []
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.kill()
  })

  test("a cell's ctx.call opens a page as a journaled step; a refused page is a failed call, and nothing is added", async () => {
    const cells = [
      `await ctx.call("app/web/open", { url: "https://example.com/" })\n` +
      `const bad = await ctx.call("app/web/open", { url: "javascript:alert(1)" })\nconsole.log(JSON.stringify(bad))`,
      `ctx.done("Opened example.com.")`,
    ]
    let calls = 0
    const agent = await openAgent(
      runtime,
      () => Stream.make({ type: "text-delta" as const, id: "t", text: cell(cells[Math.min(calls++, 1)]!) }, usage, stop),
      { fetch: outsideWeb(PAGES) },
    )
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Show me example.com")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))

    expect((await rows()).map(({ template, props }) => [template, props.url])).toEqual([["webpage", "https://example.com/"]])
    const answer = await answerRow(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Opened example.com." })
    expect(answer.parts).toEqual([
      { id: "0.0", kind: "step", flow: "app/web/open", status: "done" },
      { id: "0.1", kind: "step", flow: "app/web/open", status: "failed" },
    ])
  }, WITHIN)

  test("the agent asked to embed a page that refuses framing hears that a card shows instead, and says so", async () => {
    const cells = [
      `const opened = await ctx.call("app/web/open", { url: "https://refuses.example/" })\nconsole.log(JSON.stringify(opened))`,
      `ctx.done("Added a card that opens it in a new tab.")`,
    ]
    let calls = 0
    const agent = await openAgent(
      runtime,
      () => Stream.make({ type: "text-delta" as const, id: "t", text: cell(cells[Math.min(calls++, 1)]!) }, usage, stop),
      { fetch: outsideWeb(PAGES) },
    )
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("Show me refuses.example in the chat")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))

    expect((await rows()).map(({ template, props }) => [template, props.url])).toEqual([["link", "https://refuses.example/"]])
    // The cell's output, the call's answer, is in the model's next request.
    const after = contents(agent.h.requests.at(-1)!).join("\n")
    expect(after).toContain('"shown":"card"')
    expect(after).toContain('"framing":"refused"')
  }, WITHIN)
})

describe("the views client", () => {
  /** What one add answers through `fetch`: `"added"`, or the refusal. */
  const client = (fetch: typeof globalThis.fetch, within?: "50 millis") =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(ViewsClient), (views) =>
        views.add({ id: crypto.randomUUID(), template: "webpage", props: { url: "https://example.com/" } })).pipe(
          Effect.match({ onSuccess: () => "added", onFailure: (refused) => refused }),
          Effect.provide(
            ViewsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
            ),
          ),
        ),
    )

  test("no network, no whole answer in time, a refusal and a body outside the contract are each ViewRefused", async () => {
    expect(await client(() => Promise.reject(new TypeError("offline")))).toEqual(new ViewRefused({}))
    expect(await client(() => new Promise(() => {}), "50 millis")).toEqual(new ViewRefused({}))
    expect(await client(async () => new Response("busy", { status: 503 }))).toEqual(new ViewRefused({ status: 503 }))
    expect(await client(async () => Response.json({ code: "id_taken" }, { status: 409 }))).toEqual(
      new ViewRefused({ status: 409, code: "id_taken" }),
    )
    expect(await client(async () => Response.json({ added: true }, { status: 202 }))).toEqual(
      new ViewRefused({ status: 202 }),
    )
    expect(await client(async () => Response.json({ txid: null }, { status: 200 }))).toBe("added")
    // A refusal whose body breaks off is still a refusal, by its status.
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    expect(await client(async () => new Response(cut, { status: 502 }))).toEqual(new ViewRefused({ status: 502 }))
  })
})

describe("the preview client", () => {
  /** What one check answers through `fetch`: the page's answer, or the refusal. */
  const client = (fetch: typeof globalThis.fetch, within?: "50 millis") =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(PreviewClient), (previews) => previews.check({ url: "https://example.com/", mode: "embed" })).pipe(
        Effect.match({ onSuccess: (checked) => checked, onFailure: (refused) => refused }),
        Effect.provide(
          PreviewClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
    )

  test("no network, no whole answer in time, a refusal and a body outside the contract are each PreviewRefused", async () => {
    expect(await client(() => Promise.reject(new TypeError("offline")))).toEqual(new PreviewRefused({}))
    expect(await client(() => new Promise(() => {}), "50 millis")).toEqual(new PreviewRefused({}))
    expect(await client(async () => new Response("busy", { status: 503 }))).toEqual(new PreviewRefused({ status: 503 }))
    expect(await client(async () => Response.json({ framing: "maybe" }))).toEqual(new PreviewRefused({ status: 200 }))
    expect(await client(async () => Response.json({ framing: "refused", reason: "x_frame_options", status: 200 }))).toEqual({
      framing: "refused",
      reason: "x_frame_options",
      status: 200,
    })
  })
})

describe("a person's door", () => {
  test("counts how the flow answered a person's dispatch: shown, its declared failure, or never run", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const answering = (answer: Effect.Effect<Dispatched<"app/web/open">, DispatchFailed>) =>
      Effect.runPromise(
        dispatchOpen({ url: "https://example.com/", mode: "embed" }, "button").pipe(
          Effect.provideService(FlowDispatch, FlowDispatch.of({ dispatch: () => answer as never })),
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      )
    const count = (outcome: string, framing?: string) =>
      Effect.runSync(
        Metric.value(
          Metric.withAttributes(pagesOpened, {
            web_mode: "embed",
            door: "button",
            outcome,
            ...(framing === undefined ? {} : { web_framing: framing }),
          }),
        ).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count
    const opened = { viewId: "v", origin: "https://example.com", mode: "embed" } as const
    await answering(Effect.succeed({ _tag: "Done", value: { ...opened, shown: "page", framing: "allowed" } }))
    await answering(Effect.succeed({ _tag: "Done", value: { ...opened, shown: "card", framing: "refused" } }))
    for (const error of [new WebPageRefused({ reason: "scheme" }), new WebPageForbidden(), new WebPageUnavailable()]) {
      await answering(Effect.succeed({ _tag: "Failed", error }))
    }
    await answering(Effect.fail(new DispatchFailed({ flow: "app/web/open", reason: "invalid" })))
    await answering(Effect.fail(new DispatchFailed({ flow: "app/web/open", reason: "unavailable" })))
    expect(["refused", "forbidden", "unavailable"].map((outcome) => count(outcome))).toEqual([2, 1, 2])
    expect(count("embedded", "allowed")).toBe(1)
    expect(count("card", "refused")).toBe(1)
  })

  test("/web <url> [embed|tab] is a Member's command over the flow's own arguments", () => {
    const command = COMMANDS.find(({ flow }) => flow === "app/web/open")
    expect(command).toMatchObject({
      name: "web",
      minimum: "member",
      description: "Open a web page",
    })
    expect(command!.fields.map(({ name, required }) => [name, required])).toEqual([["url", true], ["mode", false]])
  })

  test("a page opens straight from a gesture only for tab, a gesture's door, an allowed URL and a browser that did", () => {
    const opened: Array<string> = []
    const run = (page: { url: string; mode: "embed" | "tab" }, door: "slash" | "view" | "agent", answer = true) =>
      Effect.runSync(
        openFromGesture(page, door).pipe(
          Effect.provideService(WebTab, {
            policy: { localHttp: false, appOrigin: APP },
            openTab: (href) => {
              opened.push(href)
              return answer
            },
          }),
        ),
      )
    expect(run({ url: "https://example.com/a", mode: "tab" }, "slash")).toBe(true)
    expect(run({ url: "https://example.com/b", mode: "tab" }, "slash", false)).toBe(false)
    expect(run({ url: "https://example.com/c", mode: "embed" }, "slash")).toBe(false)
    expect(run({ url: "https://example.com/d", mode: "tab" }, "view")).toBe(false)
    expect(run({ url: "https://example.com/e", mode: "tab" }, "agent")).toBe(false)
    expect(run({ url: "javascript:alert(1)", mode: "tab" }, "slash")).toBe(false)
    expect(opened).toEqual(["https://example.com/a", "https://example.com/b"])
    // A host with no browser to ask opens nothing, and leaves the check to the flow.
    expect(Effect.runSync(openFromGesture({ url: "https://example.com/", mode: "tab" }, "slash"))).toBe(false)
    expect(Effect.runSync(refusedPage({ url: "javascript:alert(1)" }, "slash"))).toEqual(Option.none())
  })
})
