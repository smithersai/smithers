// `BugsClient` against every answer ChatApi's bug routes give (worker/bugs/Api.ts), through the host's `fetch`: the
// browser's own capability, given here as a function answering the request it is handed. The steps that call it
// (`app/bug/report/send`, `app/bug/list/read`) run on the Node host's engine over a client that answers as told.
import { Action, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, Effect, Exit, Layer, Logger, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { runFlow } from "../../../worker/test/flowHost"
import { BugsClient, BugsNotTaken } from "./api"
import { BugRefused, BugTabs, BugUnsent, ListBugs, READ_RETRY, ReportBug, SEND_RETRY } from "./flows"
import type { BugReport, ReportRequest } from "./schema"
import { UNANSWERED } from "./context"
import { capture, contexts, failureOf, list, lists, registration, reports, send } from "./steps"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request, index: number) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request, seen.length - 1)
  }
  const layer = BugsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: BugsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(BugsClient, effect).pipe(Effect.provide(layer))))
  return { run, seen, layer }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as BugsNotTaken) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const ID = "8d0f6c1e-2b7a-4c55-9f0e-0123456789ab"
const SECRET_WORDS = `the composer ate my words ${crypto.randomUUID()}`

const report: ReportRequest = {
  id: ID,
  what: SECRET_WORDS,
  route: "/octocat/Spoon-Knife/issues",
  repo: "octocat/Spoon-Knife",
  build: "38569d55ad79",
  traces: ["0123456789abcdef0123456789abcdef"],
  runs: ["run-1"],
  failures: [{ flow: "app/web/open", code: "refused" }],
  errors: [{ at: "2026-10-25T20:00:00.000Z", kind: "http", name: "GET /api/runs", code: "503", traceId: null }],
  browser: "Test/1.0",
  viewport: "1280x800",
}

const row: BugReport = {
  ...report,
  reporterId: "p-1",
  reporterLogin: "codeplanesmithers",
  reporterRole: "member",
  actedBy: null,
  createdAt: "2026-10-25T20:00:00.000Z",
}

describe("BugsClient", () => {
  test("files a report at POST /api/bugs and answers what ChatApi filed", async () => {
    const { run, seen } = client(() => json({ id: ID, txid: 41 }))
    expect(await run((c) => c.file(report))).toEqual(Exit.succeed({ id: ID, txid: 41 }))
    expect(seen).toEqual([{ method: "POST", url: "http://chat.test/api/bugs", body: JSON.stringify(report) }])
  })

  test("reads the latest reports at GET /api/bugs, with the limit when one is asked", async () => {
    const { run, seen } = client(() => json({ reports: [row] }))
    expect(await run((c) => c.list(undefined))).toEqual(Exit.succeed({ reports: [row] }))
    expect(await run((c) => c.list(5))).toEqual(Exit.succeed({ reports: [row] }))
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET http://chat.test/api/bugs",
      "GET http://chat.test/api/bugs?limit=5",
    ])
  })

  test("a refusal carries its status and the route's code, or its status alone without one", async () => {
    expect(refusalOf(await client(() => json({ code: "forbidden" }, 403)).run((c) => c.list(undefined)))).toEqual({
      _tag: "BugsNotTaken",
      status: 403,
      code: "forbidden",
    })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.file(report))))
      .toEqual({ _tag: "BugsNotTaken", status: 503 })
  })

  test("a 200 whose body isn't the answer, no network, or no whole answer in time is not taken", async () => {
    expect(refusalOf(await client(() => json({ nope: true })).run((c) => c.file(report)))).toEqual({
      _tag: "BugsNotTaken",
      status: 200,
    })
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.file(report)))).toEqual({
      _tag: "BugsNotTaken",
    })
    expect(refusalOf(await client(() => new Promise(() => {}), "50 millis").run((c) => c.list(undefined)))).toEqual({
      _tag: "BugsNotTaken",
    })
  })
})

describe("what a refusal means to a flow", () => {
  test("a 4xx but 408 and 429 is final; the rest are tried again", () => {
    expect(failureOf(new BugsNotTaken({ status: 400, code: "invalid" }))).toEqual(new BugRefused({ status: 400, code: "invalid" }))
    expect(failureOf(new BugsNotTaken({ status: 401 }))).toEqual(new BugRefused({ status: 401 }))
    for (const status of [408, 429, 500, 503, undefined]) {
      expect(failureOf(new BugsNotTaken(status === undefined ? {} : { status }))).toEqual(new BugUnsent())
    }
  })

  test("sending is tried for an hour and reading a few times, a refusal never again", () => {
    expect(SEND_RETRY).toEqual(RetryPolicy.make({
      initialMs: 500,
      factor: 2,
      maxMs: 30_000,
      expirationMs: 3_600_000,
      nonRetryable: ["@smthrs/mvp/bugs/BugRefused"],
    }))
    expect(READ_RETRY.maxAttempts).toBe(4)
    expect(READ_RETRY.nonRetryable).toEqual(["@smthrs/mvp/bugs/BugRefused"])
  })
})

/** The flows' registration over `fetch`'s answers, with a bug channel no tab listens on: the tab that asked is gone. */
const steps = (respond: (request: Request, index: number) => Promise<Response>) => {
  const c = client(respond)
  const layer = registration.pipe(
    Layer.provide(c.layer),
    Layer.provide(BugTabs.layerChannel({ name: `bugs-${crypto.randomUUID()}`, within: "50 millis" })),
    Layer.provide(TabChannel.layer),
    Layer.provideMerge(Action.layerImplementations),
  )
  return { layer, seen: c.seen }
}

/** Runs a step's `effect` as run `executionId` over `layer`, keeping its log lines and metrics. */
const observed = async <A, E>(
  effect: Effect.Effect<A, E, BugsClient | BugTabs | FlowRuntime.FlowInstance>,
  layer: Layer.Layer<BugsClient | BugTabs>,
  executionId = "run-1",
) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(layer),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const count = (metric: typeof reports, attributes: Record<string, string>) =>
    Effect.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count
  return { exit, logs, count }
}

/** What an exit failed with, its trace annotations aside. */
const squashed = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : "succeeded")

/** A client over `respond` and a bug channel no tab listens on, as the steps' services. */
const services = (respond: (request: Request, index: number) => Promise<Response>) =>
  Layer.merge(
    client(respond).layer,
    BugTabs.layerChannel({ name: `bugs-${crypto.randomUUID()}`, within: "50 millis" }).pipe(Layer.provide(TabChannel.layer)),
  )

describe("the steps' records", () => {
  test("a context whose tab is gone, a report filed, by the agent's door; never what the person wrote", async () => {
    const agentRun = "answer-1/chat/Respond@1/call/0.1"
    const context = await observed(capture({ what: SECRET_WORDS, id: ID }), services(() => json({})), agentRun)
    expect(context.exit).toEqual(Exit.succeed({ id: ID, what: SECRET_WORDS, ...UNANSWERED }))
    expect(context.logs.find((log) => log.message === "bug.context")).toMatchObject({
      level: "WARN",
      annotations: { outcome: "gone", door: "agent", traces: 0, runs: 0, failures: 0 },
    })
    expect(context.count(contexts, { outcome: "gone" })).toBe(1)
    const sent = await observed(send(report), services(() => json({ id: ID, txid: 3 })), agentRun)
    expect(Exit.isSuccess(sent.exit)).toBe(true)
    expect(sent.logs.find((log) => log.message === "bug.report")).toMatchObject({
      level: "INFO",
      annotations: { outcome: "filed", door: "agent" },
    })
    expect(sent.count(reports, { door: "agent", outcome: "filed" })).toBe(1)
    expect(JSON.stringify([context.logs, sent.logs])).not.toContain(SECRET_WORDS)
  })

  test("a refusal and an unsent report are Warn lines with ChatApi's status and code", async () => {
    const refused = await observed(send(report), services(() => json({ code: "invalid" }, 400)))
    expect(squashed(refused.exit)).toEqual(new BugRefused({ status: 400, code: "invalid" }))
    expect(refused.logs.find((log) => log.message === "bug.report")).toMatchObject({
      level: "WARN",
      annotations: { outcome: "refused", door: "tab", status: 400, code: "invalid" },
    })
    const unsent = await observed(send(report), services(() => Promise.reject(new TypeError("offline"))))
    expect(squashed(unsent.exit)).toEqual(new BugUnsent())
    expect(unsent.count(reports, { door: "tab", outcome: "unsent" })).toBe(1)
  })

  test("a read counts how many reports came, or the refusal's status", async () => {
    const read = await observed(list({ limit: 2 }), services(() => json({ reports: [row, row] })))
    expect(read.logs.find((log) => log.message === "bug.list")).toMatchObject({ level: "INFO", annotations: { outcome: "read", count: 2 } })
    expect(read.count(lists, { outcome: "read" })).toBe(1)
    const refused = await observed(list({}), services(() => json({ code: "forbidden" }, 403)))
    expect(refused.logs.find((log) => log.message === "bug.list")).toMatchObject({
      level: "WARN",
      annotations: { outcome: "refused", status: 403 },
    })
    const unsent = await observed(list({}), services(() => Promise.reject(new TypeError("offline"))))
    expect(squashed(unsent.exit)).toEqual(new BugUnsent())
    expect(unsent.count(lists, { outcome: "unsent" })).toBe(1)
  })
})

/** A flow's value, failing the test when it didn't succeed. */
const valueOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`the flow failed: ${String(Cause.squash(exit.cause))}`)
  return exit.value
}

describe("app/bug/report on the Node host", () => {
  test("a tab that is gone leaves the report with what the step knows, and it is filed anyway with GitHub's form", async () => {
    const { layer, seen } = steps(() => json({ id: ID, txid: 3 }))
    const ran = await runFlow(ReportBug, { what: SECRET_WORDS, id: ID }, layer)
    const value = valueOf(ran.exit)
    expect(value.id).toBe(ID)
    expect(new URL(value.github).pathname).toBe("/smithersai/smithers/issues/new")
    expect(JSON.parse(seen[0]!.body)).toEqual({
      id: ID,
      what: SECRET_WORDS,
      route: null,
      repo: null,
      build: "unknown",
      traces: [],
      runs: [],
      failures: [],
      errors: [],
      browser: "unknown",
      viewport: "unknown",
    })
  })

  test("without an id from its door, the step picks one, and a run again files the same report", async () => {
    const { layer, seen } = steps(() => json({ id: "x", txid: null }))
    const ran = await runFlow(ReportBug, { what: "no id" }, layer)
    const id = valueOf(ran.exit).id
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(seen[0]!.body).id).toBe(id)
  })

  test("a refusal is final: one request, BugRefused with ChatApi's status and code", async () => {
    const { layer, seen } = steps(() => json({ code: "invalid" }, 400))
    const ran = await runFlow(ReportBug, { what: "x", id: ID }, layer)
    expect(squashed(ran.exit)).toEqual(new BugRefused({ status: 400, code: "invalid" }))
    expect(seen).toHaveLength(1)
  })

  test("while ChatApi can't take it, the step is tried again until it lands", async () => {
    const { layer, seen } = steps((_request, index) =>
      index === 0 ? Promise.reject(new TypeError("offline")) : json({ id: ID, txid: 9 })
    )
    const ran = await runFlow(ReportBug, { what: "x", id: ID }, layer)
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(seen).toHaveLength(2)
  })
})

describe("app/bug/list on the Node host", () => {
  test("answers the latest reports, counted with how many came", async () => {
    const { layer, seen } = steps(() => json({ reports: [row] }))
    const ran = await runFlow(ListBugs, { limit: 3 }, layer)
    expect(ran.exit).toEqual(Exit.succeed({ reports: [row] }))
    expect(seen[0]!.url).toBe("http://chat.test/api/bugs?limit=3")
  })

  test("a Member's read is refused for good; a read ChatApi can't answer fails after its few tries", async () => {
    const refused = steps(() => json({ code: "forbidden" }, 403))
    expect(squashed((await runFlow(ListBugs, {}, refused.layer)).exit)).toEqual(new BugRefused({ status: 403, code: "forbidden" }))
    expect(refused.seen).toHaveLength(1)
    const down = steps(() => Promise.resolve(new Response("", { status: 503 })))
    expect(squashed((await runFlow(ListBugs, {}, down.layer)).exit)).toEqual(new BugUnsent())
    expect(down.seen).toHaveLength(4)
  }, 60_000)
})
