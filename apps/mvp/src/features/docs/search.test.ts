// `app/docs/search` (docs/features/docs.md#the-flow): its steps on the Node host's engine (worker/test/flowHost.ts)
// against ChatApi's real docs routes and views route on this file's schema of the compose Postgres (`pnpm db:up`); the
// agent's call from a cell (src/test/agent.ts); and the docs client's own failures. GitHub and the docs site are the
// outside web (worker/test/pages.ts): GitHub is offline, so each repository's docs come from its curated home. Faults
// are injected as test implementations of Effect services: a client that fails once.
import { Action, FlowRuntime } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric, Scope, Stream, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import type { CuratedFile } from "../../../worker/home/Curated.ts"
import { tracked } from "../../../worker/test/branch.ts"
import { build } from "../../../worker/test/flowHost.ts"
import { contents, harness, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { markdown, outsideWeb, type Page } from "../../../worker/test/pages.ts"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { answerRow, cell, type Engine, openAgent } from "../../test/agent"
import { COMMANDS } from "../commands/catalog"
import { ViewRefused, ViewsClient } from "../views/api"
import { DocsClient, DocsRefused } from "./api"
import { AGENT_TEXT_BYTES, DOCS_TELEMETRY } from "./contract"
import { DocsForbidden, DocsSearchRefused, SearchDocs } from "./flows"
import { searches, shown } from "./metrics"
import { registration } from "./steps"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

const runtime = testFile("docs_search")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

/** An agent's call of the flow, as the catalog names it: a child of the answer's run. */
const agentCall = (n: number) => `answer-${n}/chat/Respond@abc:1/call/1.0`

const WITHIN = 90_000

const INDEX = "https://docs.example/llms.txt"
const SENTINEL = "quokka-sentinel"
const RETRYING = `# Retrying\n\nUse \`retry\` with a ${SENTINEL}.\n`
const SCHEDULE = "# Schedule\n\nSchedules drive retry and repeat.\n"

const SITE: Record<string, Page> = {
  [INDEX]: markdown([
    "# Example",
    "- [Retrying](/guide/retrying.md): Retry a failing effect.",
    "- [Schedule](/reference/schedule.md): Schedules for retry and repeat.",
    "- [Retry gone](/guide/gone.md): A retry page the site lost.",
    "- [Retry later](/guide/later.md): Retry, later.",
  ].join("\n")),
  "https://docs.example/guide/retrying.md": markdown(RETRYING),
  "https://docs.example/reference/schedule.md": markdown(SCHEDULE),
  "https://docs.example/guide/later.md": markdown(`# Retry later\n\n${"word ".repeat(4_000)}`),
  "https://docs.example/guide/gone.md": { status: 404 },
  // GitHub, as far as the about read must reach it: a repository whose home names no docs.
  "https://api.github.com/repos/acme/plain": {
    headers: { "content-type": "application/json" },
    html: JSON.stringify({
      full_name: "acme/plain",
      stargazers_count: 0,
      forks_count: 0,
      watchers_count: 0,
      default_branch: "main",
    }),
  },
}

const curated = (repository: string, docs?: string): CuratedFile => ({
  repository,
  defaultBranch: "main",
  home: { ...(docs === undefined ? {} : { docs }), blocks: [{ type: "text", text: "Curated" }] },
})

const HOMES = [curated("acme/widgets", INDEX), curated("acme/plain")]

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly template: string; readonly props: Record<string, unknown>; readonly conversationId: string }>`
      SELECT id::text AS id, template, props, conversation_id::text AS "conversationId" FROM views ORDER BY position`))

/**
 * `app/docs/search` on the Node host's engine, reading docs and adding views through ChatApi's real routes as `actor`
 * (a Member unless `null`), with `docs` and `views` in place of the real clients when set.
 */
const openEngine = async (options: {
  readonly actor?: Actor | null
  readonly docs?: (real: Layer.Layer<DocsClient>) => Layer.Layer<DocsClient>
  readonly views?: (real: Layer.Layer<ViewsClient>) => Layer.Layer<ViewsClient>
} = {}) => {
  const h = await harness(runtime, () => Stream.empty, {
    fetch: outsideWeb(SITE),
    homes: HOMES,
    ...(options.actor === null ? {} : { actor: options.actor ?? member }),
  })
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }
  const http = Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))
  const realDocs = DocsClient.layer({ origin: "http://chat.test" }).pipe(Layer.provide(http))
  const realViews = ViewsClient.layer({ origin: "http://chat.test" }).pipe(Layer.provide(http))
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
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
            Layer.provide(options.docs === undefined ? realDocs : options.docs(realDocs)),
            Layer.provide(options.views === undefined ? realViews : options.views(realViews)),
          ),
        ),
      ),
    ),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  const value = (metric: typeof searches, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return {
    search: (
      executionId: string,
      payload: { readonly repository: string; readonly query: string; readonly pages?: number; readonly conversationId?: string },
    ) => Effect.runPromise(observed(Effect.exit(flows.execute(SearchDocs, { executionId, payload })))),
    count: (attributes: Record<string, string>) => value(searches, attributes),
    shown: (attributes: Record<string, string>) => value(shown, attributes),
    lines: () => logs.filter((log) => log.message === "docs.search"),
    spans: () => spans.filter((span) => span.name === "docs.search"),
    h,
  }
}

describe("the flow", () => {
  test("shows the best page in the conversation and answers it with its text to answer from", async () => {
    const engine = await openEngine()

    const exit = await engine.search(agentCall(1), { repository: "acme/widgets", query: "retry" })

    const [view] = await rows()
    expect(exit).toEqual(Exit.succeed({
      pages: [{
        title: "Retrying",
        path: "/guide/retrying.md",
        url: "https://docs.example/guide/retrying.md",
        viewId: view!.id,
      }],
      text: `# Retrying\n\n${RETRYING}`,
    }))
    expect(view).toMatchObject({
      template: "docs",
      props: {
        url: "https://docs.example/guide/retrying.md",
        title: "Retrying",
        repository: "acme/widgets",
        path: "/guide/retrying.md",
        text: RETRYING,
      },
    })
    expect(engine.count({ door: "agent", outcome: "shown" })).toBe(1)
    expect(engine.shown({ door: "agent" })).toBe(1)
    expect(engine.lines().map((line) => line.annotations)).toEqual([
      expect.objectContaining({ door: "agent", outcome: "shown", results: 1, shown: 1, feature: "docs" }),
    ])
    expect(engine.spans().length).toBeGreaterThanOrEqual(3)
  }, WITHIN)

  test("shows up to three pages, best first, leaves out one the site lost, and bounds each page's text", async () => {
    const engine = await openEngine()

    const exit = await engine.search("docs-person-1", { repository: "acme/widgets", query: "retry", pages: 3 })

    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    // "Retry gone" is in the index but the site doesn't have it: ChatApi can't read it, so it isn't shown.
    expect(exit.value.pages.map((page) => page.title)).toEqual(["Retrying", "Retry later"])
    expect((await rows()).map((row) => row.props.title)).toEqual(["Retrying", "Retry later"])
    const later = exit.value.text!.split("\n\n---\n\n")[1]!
    expect(new TextEncoder().encode(later).length).toBeLessThanOrEqual(AGENT_TEXT_BYTES + "# Retry later\n\n".length)
    expect(engine.count({ door: "person", outcome: "shown" })).toBe(1)
  }, WITHIN)

  test("a query nothing matches shows nothing and says so; no docs, no repository and a bad name are refused", async () => {
    const engine = await openEngine()
    expect(await engine.search(agentCall(1), { repository: "acme/widgets", query: "zzz" })).toEqual(
      Exit.succeed({ pages: [] }),
    )
    // The site lost the only match: the index lists it, ChatApi can't read it.
    expect(await engine.search(agentCall(2), { repository: "acme/widgets", query: "gone" })).toEqual(
      Exit.succeed({ pages: [] }),
    )
    expect(failureOf(await engine.search(agentCall(3), { repository: "acme/plain", query: "retry" }))).toEqual(
      new DocsSearchRefused({ reason: "no_docs" }),
    )
    for (const [n, repository] of ["acme", "acme/widgets/extra", "app/widgets", "a b/c"].entries()) {
      expect(failureOf(await engine.search(agentCall(4 + n), { repository, query: "retry" }))).toEqual(
        new DocsSearchRefused({ reason: "invalid" }),
      )
    }
    expect(await rows()).toEqual([])
    expect(engine.count({ door: "agent", outcome: "none" })).toBe(2)
    expect(engine.count({ door: "agent", outcome: "refused" })).toBe(5)
    expect(engine.lines().filter((line) => line.annotations.outcome === "refused").map((line) => line.annotations.reason))
      .toEqual(["no_docs", "invalid", "invalid", "invalid", "invalid"])
  }, WITHIN)

  test("ChatApi refusing the repository, the search or the person fails the call; a passing failure is tried again", async () => {
    let failures = 0
    let busy = 0
    const engine = await openEngine({
      docs: (real) =>
        Layer.effect(
          DocsClient,
          Effect.map(Effect.service(DocsClient), (client) =>
            DocsClient.of({
              search: (owner, name, query) =>
                query === "flaky" && failures++ === 0
                  ? Effect.fail(new DocsRefused({ status: 502, code: "docs_unreachable", reason: "timeout" }))
                  : query === "busy" && busy++ === 0
                  ? Effect.fail(new DocsRefused({ status: 502, code: "docs_unreachable", reason: "busy" }))
                  : query === "missing"
                  ? Effect.fail(new DocsRefused({ status: 404, code: "not_found" }))
                  : query === "bad"
                  ? Effect.fail(new DocsRefused({ status: 400, code: "invalid" }))
                  : query === "moved"
                  ? Effect.fail(new DocsRefused({ status: 502, code: "docs_unreachable", reason: "status" }))
                  : client.search(owner, name, query === "flaky" || query === "busy" ? "retry" : query),
              page: (owner, name, path) =>
                path === "/reference/schedule.md"
                  ? Effect.fail(new DocsRefused({ status: 400, code: "invalid" }))
                  : client.page(owner, name, path),
            })),
        ).pipe(Layer.provide(real)),
    })

    expect(Exit.isSuccess(await engine.search(agentCall(1), { repository: "acme/widgets", query: "flaky" }))).toBe(true)
    expect(failureOf(await engine.search(agentCall(2), { repository: "acme/widgets", query: "missing" }))).toEqual(
      new DocsSearchRefused({ reason: "not_found" }),
    )
    expect(failureOf(await engine.search(agentCall(3), { repository: "acme/widgets", query: "bad" }))).toEqual(
      new DocsSearchRefused({ reason: "invalid" }),
    )
    expect(failureOf(await engine.search(agentCall(4), { repository: "acme/widgets", query: "schedules" }))).toEqual(
      new DocsSearchRefused({ reason: "invalid" }),
    )
    expect(failureOf(await engine.search(agentCall(5), { repository: "acme/widgets", query: "moved" }))).toEqual(
      new DocsSearchRefused({ reason: "unreadable" }),
    )
    // A busy docs site (429 or 5xx) passes too: tried again, it answers.
    expect(Exit.isSuccess(await engine.search(agentCall(6), { repository: "acme/widgets", query: "busy" }))).toBe(true)
    expect(engine.count({ door: "agent", outcome: "unavailable" })).toBe(2)
    expect((await rows()).map((row) => row.props.title)).toEqual(["Retrying", "Retrying"])

    const signedOut = await openEngine({ actor: null })
    expect(failureOf(await signedOut.search(agentCall(5), { repository: "acme/widgets", query: "retry" }))).toEqual(
      new DocsForbidden(),
    )
    expect(signedOut.count({ door: "agent", outcome: "forbidden" })).toBe(1)
  }, WITHIN)

  test("a view ChatApi can't add is tried again, and added once; one it refuses fails the call", async () => {
    let failures = 0
    const engine = await openEngine({
      views: (real) =>
        Layer.effect(
          ViewsClient,
          Effect.map(Effect.service(ViewsClient), (client) =>
            ViewsClient.of({
              ...client,
              add: (write) =>
                write.template === "docs" && write.props.path === "/reference/schedule.md"
                  ? Effect.fail(new ViewRefused({ status: 400, code: "refused" }))
                  : failures++ === 0
                  ? Effect.fail(new ViewRefused({ status: 503 }))
                  : client.add(write),
            })),
        ).pipe(Layer.provide(real)),
    })

    expect(Exit.isSuccess(await engine.search(agentCall(1), { repository: "acme/widgets", query: "retry" }))).toBe(true)
    expect(await rows()).toHaveLength(1)
    expect(failureOf(await engine.search(agentCall(2), { repository: "acme/widgets", query: "schedules" }))).toEqual(
      new DocsSearchRefused({ reason: "invalid" }),
    )
    expect(engine.count({ door: "agent", outcome: "unavailable" })).toBe(1)
    expect(engine.count({ door: "agent", outcome: "shown" })).toBe(1)
  }, WITHIN)

  test("a person's run adds its views to the conversation it names; an agent's to its answer's", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, "github/octo/hello", `feature/${crypto.randomUUID()}`)
    expect(Exit.isSuccess(await engine.search("docs-branch-1", {
      repository: "acme/widgets",
      query: "retry",
      conversationId: branch.conversationId.toUpperCase(),
    }))).toBe(true)

    const other = await tracked(runtime, "github/octo/hello", `feature/${crypto.randomUUID()}`)
    const ids = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
    const asked = await engine.h.fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ids, text: "How do I retry?", conversationId: other.conversationId }),
    })
    expect(asked.status).toBe(202)
    expect(Exit.isSuccess(await engine.search(`${ids.answerId.toUpperCase()}/chat/Respond@abc:1/call/1.0`, {
      repository: "acme/widgets",
      query: "schedules",
    }))).toBe(true)

    expect((await rows()).map((row) => row.conversationId)).toEqual([branch.conversationId, other.conversationId])
  }, WITHIN)

  test("records carry who asked and how it went, never the query, a path, a URL, a title or a text", async () => {
    const engine = await openEngine()
    await engine.search(agentCall(1), { repository: "acme/widgets", query: `retry ${SENTINEL}` })
    await engine.search(agentCall(2), { repository: "acme/plain", query: SENTINEL })
    const records = JSON.stringify({
      logs: engine.lines(),
      spans: engine.spans().map((span) => Object.fromEntries(span.attributes)),
    })
    for (const secret of [SENTINEL, "docs.example", "/guide/", "Retrying"]) expect(records).not.toContain(secret)
    for (const log of engine.lines()) {
      for (const field of Object.keys(log.annotations)) expect(BROWSER_TELEMETRY.fields).toContain(field)
    }
    expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...DOCS_TELEMETRY.records]))
  }, WITHIN)
})

describe("the agent", () => {
  const engines: Array<Engine> = []
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.kill()
  })

  test("a cell's ctx.call shows a docs page as a journaled step, and the agent hears its text", async () => {
    const cells = [
      `const found = await ctx.call("app/docs/search", { repository: "acme/widgets", query: "retry" })\n` +
      `console.log(JSON.stringify(found))`,
      `ctx.done("Use retry with a schedule.")`,
    ]
    let calls = 0
    const agent = await openAgent(
      runtime,
      () => Stream.make({ type: "text-delta" as const, id: "t", text: cell(cells[Math.min(calls++, 1)]!) }, usage, stop),
      { fetch: outsideWeb(SITE), homes: HOMES },
    )
    const engine = await agent.engine()
    engines.push(engine)
    const answerId = await agent.ask("How do I retry in acme/widgets?")

    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))

    expect((await rows()).map(({ template, props }) => [template, props.path])).toEqual([["docs", "/guide/retrying.md"]])
    const answer = await answerRow(runtime, answerId)
    expect(answer.parts).toEqual([{ id: "0.0", kind: "step", flow: "app/docs/search", status: "done" }])
    // The call's answer, the page's text included, is in the model's next request.
    expect(contents(agent.h.requests.at(-1)!).join("\n")).toContain(SENTINEL)
  }, WITHIN)
})

describe("the docs client", () => {
  const run = <A>(effect: (client: DocsClient["Service"]) => Effect.Effect<A, DocsRefused>, fetch: typeof globalThis.fetch, within?: "50 millis") =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(DocsClient), effect).pipe(
        Effect.match({ onSuccess: (value) => value as unknown, onFailure: (refused) => refused }),
        Effect.provide(
          DocsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
    )
  const answering = (status: number, body: string): typeof globalThis.fetch => () => Promise.resolve(new Response(body, { status }))

  test("answers the routes' bodies; no network, no whole answer in time, a refusal and a body outside the contract are each DocsRefused", async () => {
    const listing = { title: "Example", pages: [{ title: "A", path: "/a.md" }] }
    expect(await run((client) => client.search("acme", "widgets", "a"), answering(200, JSON.stringify(listing)))).toEqual(listing)
    const page = { title: "A", path: "/a.md", url: "https://docs.example/a.md", text: "# A" }
    expect(await run((client) => client.page("acme", "widgets", "/a.md"), answering(200, JSON.stringify(page)))).toEqual(page)
    expect(await run((client) => client.search("acme", "widgets", ""), () => Promise.reject(new TypeError("offline"))))
      .toEqual(new DocsRefused({}))
    expect(await run((client) => client.search("acme", "widgets", ""), () => new Promise<Response>(() => {}), "50 millis"))
      .toEqual(new DocsRefused({}))
    expect(await run((client) => client.search("acme", "widgets", ""), answering(502, JSON.stringify({ code: "docs_unreachable", reason: "timeout" }))))
      .toEqual(new DocsRefused({ status: 502, code: "docs_unreachable", reason: "timeout" }))
    expect(await run((client) => client.search("acme", "widgets", ""), answering(500, "not json"))).toEqual(new DocsRefused({ status: 500 }))
    expect(await run((client) => client.page("acme", "widgets", "/a.md"), answering(200, "{}"))).toEqual(new DocsRefused({ status: 200 }))
    // A refusal whose body breaks off is still the refusal, by its status.
    const broken: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(new ReadableStream({ start: (controller) => controller.error(new Error("cut")) }), { status: 503 }))
    expect(await run((client) => client.search("acme", "widgets", ""), broken)).toEqual(new DocsRefused({ status: 503 }))
  })

  test("/docs <owner/name> <query> is a Member's command over the flow's own arguments", () => {
    const docs = COMMANDS.find((command) => command.name === "docs")
    expect(docs).toMatchObject({ flow: "app/docs/search", minimum: "member" })
  })
})
