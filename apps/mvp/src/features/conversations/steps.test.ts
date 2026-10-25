// Your conversations' client and steps (docs/features/conversations.md#flows) over an injected `fetch`, for the answers
// ChatApi's routes never give a valid request: no network, a stalled answer, a body it can't read, and each refusal
// (test.faults-by-injection). The routes themselves are worker/branch/ConversationPeople.test.ts; the flows on a device,
// conversations.test.ts. New-conversation requests execute the real durable child flow on the compose Postgres.
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { RealmFlow } from "@smthrs/harness"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Logger, Metric, Schema, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { CONVERSATION_NAMESPACE } from "../branch/contract"
import { BranchClient } from "../branch/api"
import { BranchTrackRefused, BranchTrackUnavailable, TrackFailure } from "../branch/flows"
import * as Creation from "../branch/creationSteps"
import { CREATION } from "../../plugins/builtinFlows"
import { runFlow } from "../../../worker/test/flowHost.ts"
import { Made } from "./schema"
import { BranchStore } from "../branch/store"
import { persistenceOn } from "../../test/deviceFixture"
import { ArchiveNotTaken, ConversationsClient } from "./api"
import { NEW_BRANCH_PREFIX } from "./contract"
import { ArchiveRefused, ArchiveUnsent } from "./flows"
import { archives, news } from "./metrics"
import { pinBranch, pinRepository } from "./pin"
import { failureOf, requestArchive, requestNew, stamp } from "./steps"

const ID = "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f"

/** The services the steps reach ChatApi through, over `fetch`, giving up after 50 ms. */
const clients = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(
    ConversationsClient.layer({ origin: "http://chat.test", within: "50 millis" }),
    BranchClient.layer({ origin: "http://chat.test", within: "50 millis" }),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))

/** `effect` over `fetch`: how it ended, its log lines, and a counter's count by attributes. */
const run = async <A, E>(effect: Effect.Effect<A, E, ConversationsClient | BranchClient>, fetch: typeof globalThis.fetch) => {
  const registry: Metric.MetricRegistry = new Map()
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  const exit = await Effect.runPromise(
    effect.pipe(
      Effect.match({ onSuccess: (done) => ({ done }), onFailure: (failed) => ({ failed }) }),
      Effect.provide(clients(fetch)),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const count = (metric: typeof archives, attributes: Record<string, string>) =>
    Effect.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
      .count
  return { exit, logs, count }
}

const archiveOf = (fetch: typeof globalThis.fetch) =>
  run(Effect.flatMap(ConversationsClient, (client) => client.archive({ conversationId: ID, archived: true, at: 5 })), fetch)

describe("the archive client", () => {
  test("posts the act; a 200 took it, whatever its body says; anything else is ArchiveNotTaken", async () => {
    const posted: Array<{ readonly url: string; readonly body: unknown }> = []
    const recording: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      posted.push({ url: request.url, body: await request.json() })
      return Response.json({ archived: true, txid: 7 })
    }
    expect((await archiveOf(recording)).exit).toEqual({ done: { archived: true } })
    expect(posted).toEqual([
      { url: "http://chat.test/api/conversations/archive", body: { conversationId: ID, archived: true, at: 5 } },
    ])

    // A 200 whose body can't be read still took the act: logged, never sent again.
    const malformed = await archiveOf(async () => new Response("ok"))
    expect(malformed.exit).toEqual({ done: { archived: true } })
    expect(malformed.logs.map((line) => line.message)).toContain("conversation.archive.malformed")

    expect((await archiveOf(() => Promise.reject(new TypeError("offline")))).exit)
      .toEqual({ failed: new ArchiveNotTaken({ reason: "unreachable" }) })
    expect((await archiveOf(() => new Promise(() => {}))).exit).toEqual({ failed: new ArchiveNotTaken({ reason: "timeout" }) })
    expect((await archiveOf(async () => Response.json({ code: "forbidden" }, { status: 403 }))).exit)
      .toEqual({ failed: new ArchiveNotTaken({ status: 403, code: "forbidden" }) })
    expect((await archiveOf(async () => new Response("busy", { status: 503 }))).exit)
      .toEqual({ failed: new ArchiveNotTaken({ status: 503 }) })
  })
})

describe("conversation/archive/request", () => {
  test.each<[number | undefined, ArchiveRefused | ArchiveUnsent]>([
    [400, new ArchiveRefused({ status: 400 })],
    [404, new ArchiveRefused({ status: 404 })],
    [499, new ArchiveRefused({ status: 499 })],
    [408, new ArchiveUnsent()],
    [429, new ArchiveUnsent()],
    [500, new ArchiveUnsent()],
    [399, new ArchiveUnsent()],
    [undefined, new ArchiveUnsent()],
  ])("ChatApi's %s is %s: a 4xx but 408 and 429 is final, anything else is tried again", (status, failure) => {
    expect(failureOf(new ArchiveNotTaken(status === undefined ? {} : { status }))).toEqual(failure)
  })

  /** The step for `request`, run as `executionId`: a person's press, or, `<answer id>/…`, the agent's call. */
  const archiveStep = (
    request: { readonly conversationId?: string; readonly archived: boolean; readonly at: number },
    fetch: typeof globalThis.fetch,
    executionId = "press-1",
  ) =>
    run(
      requestArchive(request).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
      ),
      fetch,
    )

  test("the conversation named; for the agent's call naming none, the one its answer is in; a person's naming none, nothing", async () => {
    const posted: Array<unknown> = []
    const recording: typeof globalThis.fetch = async (input, init) => {
      posted.push(await new Request(input, init).json())
      return Response.json({ archived: true, txid: 1 })
    }
    const answerId = "0B5D7D1C-6F1D-4A65-9D7E-2C1A9C2F4B11"
    expect((await archiveStep({ archived: true, at: 2 }, recording, `${answerId}/call/0`)).exit)
      .toEqual({ done: { archived: true } })
    expect((await archiveStep({ conversationId: ID.toUpperCase(), archived: true, at: 3 }, recording, `${answerId}/call/1`)).exit)
      .toEqual({ done: { archived: true } })
    expect(posted).toEqual([
      { answerId: answerId.toLowerCase(), archived: true, at: 2 },
      { conversationId: ID, archived: true, at: 3 },
    ])
    const none = await archiveStep({ archived: true, at: 4 }, recording)
    expect(none.exit).toEqual({ failed: new ArchiveRefused({ status: 400 }) })
    expect(posted).toHaveLength(2)
  })

  test("sent, refused and unsent are counted and logged by archived and outcome, with ChatApi's status", async () => {
    const step = (fetch: typeof globalThis.fetch) => archiveStep({ conversationId: ID, archived: false, at: 9 }, fetch)
    const sent = await step(async () => Response.json({ archived: false, txid: null }))
    expect(sent.exit).toEqual({ done: { archived: false } })
    expect(sent.count(archives, { archived: "false", outcome: "sent" })).toBe(1)
    expect(sent.logs[0]).toMatchObject({ level: "INFO", message: "conversation.archive", annotations: { conversationId: ID, outcome: "sent" } })

    const refused = await step(async () => Response.json({ code: "not_found" }, { status: 404 }))
    expect(refused.exit).toEqual({ failed: new ArchiveRefused({ status: 404 }) })
    expect(refused.count(archives, { archived: "false", outcome: "refused" })).toBe(1)
    expect(refused.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "refused", status: 404 } })

    const unsent = await step(() => Promise.reject(new TypeError("offline")))
    expect(unsent.exit).toEqual({ failed: new ArchiveUnsent() })
    expect(unsent.count(archives, { archived: "false", outcome: "unsent" })).toBe(1)
    expect(unsent.logs[0]!.annotations).not.toHaveProperty("status")
  })
})

describe("conversation/new/request", () => {
  const made = {
    branchId: "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11",
    conversationId: ID,
    repoId: "github/octo/hello",
    name: "topic",
    mode: "open",
    access: "owner",
    shared: false,
  }
  const payload = { repo: Schema.optional(Schema.String), branch: Schema.optional(Schema.String), at: Schema.Number }
  const NewAction = Action.make("test/conversation/new/request", { payload, success: Made, error: TrackFailure })
  const New = Flow.make("test/conversation/new", {
    payload, success: Made, error: TrackFailure,
    body: Node.capture({ request: NewAction.name }, (value) => NewAction.call(value)),
  })
  const Occupied = Flow.make("test/creation/occupied", { payload: {}, success: Schema.Null, body: Node.capture({}, () => Node.succeed(null)) })
  const step = async (
    request: { readonly repo?: string; readonly branch?: string },
    fetch: typeof globalThis.fetch,
    executionId = "run-1",
    occupied = false,
  ) => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    } })
    const selection: typeof globalThis.fetch = (input, init) => {
      const outgoing = new globalThis.Request(input, init)
      const url = new URL(outgoing.url)
      if (url.pathname !== "/api/branches/creation") return fetch(input, init)
      expect(outgoing.method).toBe("GET")
      return Promise.resolve(Response.json({
        owner: url.searchParams.get("owner") ?? "smithersai", name: url.searchParams.get("name") ?? "smithers",
        tag: CREATION.tag, source: CREATION.source, digest: digestSync(CREATION.source), revision: "builtin",
        runtime: RealmFlow.version, allowed: ["branches/ephemeral"],
      }))
    }
    const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, selection)))
    const monitoredClient = Layer.effect(BranchClient, Effect.map(BranchClient, (client) => BranchClient.of({
      track: (branch) => client.track(branch).pipe(Effect.provideService(Tracer.Tracer, tracer)),
    }))).pipe(Layer.provide(clients(selection)))
    const registration = Layer.mergeAll(
      Interpreter.layerWithImplementations(New, NewAction.toLayer((payload) => Effect.gen(function* () {
        if (occupied) {
          const { executionId } = yield* FlowRuntime.FlowInstance
          const id = yield* Uuid.v5(CONVERSATION_NAMESPACE, executionId).pipe(Effect.orDie)
          yield* (yield* FlowRuntime.FlowRuntime).execute(Occupied, { executionId: `branch-creation:${id}`, payload: {} }).pipe(Effect.orDie)
        }
        return yield* requestNew(payload)
      }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.provideService(Tracer.Tracer, tracer),
      ))), Interpreter.layer(Occupied), Creation.registration("http://chat.test"),
    ).pipe(
      Layer.provide(monitoredClient), Layer.provide(http), Layer.provide(WebCrypto.layer),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(Logger.CurrentLoggers, new Set([logger]))),
      Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
      Layer.provideMerge(Layer.succeed(Tracer.Tracer, tracer)),
    )
    const ran = await runFlow(New, { ...request, at: 77 }, registration, { executionId })
    const exit = Exit.isSuccess(ran.exit) ? { done: ran.exit.value } : { failed: Cause.squash(ran.exit.cause) }
    const count = (metric: typeof news, attributes: Record<string, string>) => Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
    return { exit, count, logs, spans }
  }

  test("asks for the branch named, in the repository named as the person typed it, and answers its page's path", async () => {
    const posted: Array<unknown> = []
    const answer = await step({ repo: "Octo/Hello", branch: "topic" }, async (input, init) => {
      posted.push(await new Request(input, init).json())
      return Response.json(made, { status: 201 })
    })
    expect(posted).toEqual([
      { owner: "Octo", name: "Hello", ref: "topic", create: true, request: expect.any(String), openedAt: 77 },
    ])
    expect(answer.exit).toEqual({ done: { ...made, path: "/Octo/Hello/tree/topic" } })
    expect(answer.count(news, { outcome: "made" })).toBe(1)
    expect(answer.logs.find((line) => line.message === "conversation.new")).toMatchObject({ level: "INFO", annotations: { conversationId: ID } })
    expect(JSON.stringify(answer.logs)).not.toContain("topic")
  })

  test("without a repository or a name: the deployment's own, named for the run, the same name every time it runs", async () => {
    const asked: Array<{ readonly ref: string }> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = await new Request(input, init).json() as { readonly ref: string }
      asked.push(body)
      return Response.json({ ...made, repoId: "github/smithersai/smithers", name: body.ref }, { status: 201 })
    }
    const first = await step({}, fetch, "run-7")
    await step({}, fetch, "run-7")
    await step({}, fetch, "run-8")
    expect(asked[0]).toEqual({
      owner: "smithersai", name: "smithers",
      ref: expect.stringMatching(new RegExp(`^${NEW_BRANCH_PREFIX}[0-9a-f]{6}$`)),
      create: true,
      request: expect.stringMatching(/^[0-9a-f-]{36}$/),
      openedAt: 77,
    })
    // The run's request is the same every time it runs, and its name its first six hex digits.
    expect((asked[1] as { readonly request?: string }).request).toBe((asked[0] as { readonly request?: string }).request)
    expect(asked[1]!.ref).toBe(asked[0]!.ref)
    expect(asked[2]!.ref).not.toBe(asked[0]!.ref)
    expect(first.exit).toEqual({ done: expect.objectContaining({ path: `/smithersai/smithers/tree/${asked[0]!.ref}` }) })
  })

  test("a refusal retains its reason, count and provider status", async () => {
    const exists = await step({ branch: "taken" }, async () => Response.json({ code: "exists" }, { status: 409 }))
    expect(exists.exit).toEqual({ failed: new BranchTrackRefused({ reason: "exists" }) })
    expect(exists.count(news, { outcome: "exists" })).toBe(1)
    expect(exists.logs.find((line) => line.message === "conversation.new")).toMatchObject({ level: "WARN", annotations: { outcome: "exists" } })
    expect(exists.spans.find((span) => span.name === "branch.track.post")?.attributes.get("http.response.status_code")).toBe(409)
  })

  test("an offline provider recovers with the same durable request identity", async () => {
    const attempts: Array<string> = []
    const down = await step({ branch: "topic" }, async (input, init) => {
      const body = await new Request(input, init).json() as { readonly request: string }
      attempts.push(body.request)
      if (attempts.length === 1) throw new TypeError("offline")
      return Response.json(made, { status: 201 })
    })
    expect(down.exit).toEqual({ done: { ...made, path: "/octo/hello/tree/topic" } })
    expect(down.count(news, { outcome: "made" })).toBe(1)
    expect(attempts.length).toBeGreaterThan(1)
    expect(new Set(attempts).size).toBe(1)
  }, 60_000)

  test("a foreign execution occupying the child identity is unavailable and never accepted as creation", async () => {
    let posts = 0
    const answer = await step({ branch: "topic" }, async () => {
      posts++
      return Response.json(made, { status: 201 })
    }, "occupied", true)
    expect(answer.exit).toEqual({ failed: new BranchTrackUnavailable() })
    expect(answer.count(news, { outcome: "unavailable" })).toBe(1)
    expect(posts).toBe(0)
  })
})

describe("an act's time", () => {
  test("is the payload's when it has one, else the clock's now, as the stamp step records it once", async () => {
    expect(await Effect.runPromise(stamp({ archived: true, at: 5 }))).toEqual({ archived: true, at: 5 })
    const now = await Effect.runPromise(stamp({ repo: "octo/hello" }))
    expect(now).toEqual({ repo: "octo/hello", at: expect.any(Number) })
    expect(Math.abs(now.at - Date.now())).toBeLessThan(5_000)
  })
})

describe("/new's repository", () => {
  const pin = (payload: Record<string, unknown>, current?: { readonly owner: string; readonly repo: string }) =>
    Effect.runPromise(
      current === undefined
        ? pinRepository(payload)
        : Effect.gen(function* () {
          const { current: row } = yield* BranchStore
          yield* Effect.orDie(row.update("current", (draft) => void Object.assign(draft, current)))
          return yield* pinRepository(payload)
        }).pipe(
          Effect.provide(BranchStore.layer),
          // The branch store keeps a row on the device, in a store of this test's own.
          Effect.provide(persistenceOn(join(tmpdir(), `pin-${crypto.randomUUID()}.sqlite`))),
        ),
    )

  test("the branch the tab shows names it; home, or a payload naming one, keeps the payload", async () => {
    expect(await pin({ branch: "x" }, { owner: "octo", repo: "hello" })).toEqual({ branch: "x", repo: "octo/hello" })
    expect(await pin({ repo: "a/b" }, { owner: "octo", repo: "hello" })).toEqual({ repo: "a/b" })
    // Home: the branch store's row names no branch.
    expect(await pin({}, { owner: "", repo: "" })).toEqual({})
    // No branch store at all, as in a frontend without the workspace.
    expect(await pin({}, { owner: "", repo: "hello" })).toEqual({})
    expect(await pin({})).toEqual({})
  })
})

describe("/publish's and /branch.update's branch", () => {
  const pin = (payload: Record<string, unknown>, current?: { readonly owner: string; readonly repo: string; readonly name: string }) =>
    Effect.runPromise(
      current === undefined
        ? pinBranch(payload)
        : Effect.gen(function* () {
          const { current: row } = yield* BranchStore
          yield* Effect.orDie(row.update("current", (draft) => void Object.assign(draft, current)))
          return yield* pinBranch(payload)
        }).pipe(
          Effect.provide(BranchStore.layer),
          Effect.provide(persistenceOn(join(tmpdir(), `pin-${crypto.randomUUID()}.sqlite`))),
        ),
    )

  test("the branch the tab shows names both; a payload naming both, a page with no branch, or no workspace keeps it", async () => {
    expect(await pin({ title: "t" }, { owner: "octo", repo: "hello", name: "try-1" })).toEqual({ title: "t", repo: "octo/hello", branch: "try-1" })
    expect(await pin({ repo: "a/b", branch: "c" }, { owner: "octo", repo: "hello", name: "try-1" })).toEqual({ repo: "a/b", branch: "c" })
    expect(await pin({ title: "t" }, { owner: "", repo: "", name: "" })).toEqual({ title: "t" })
    expect(await pin({ title: "t" }, { owner: "octo", repo: "", name: "x" })).toEqual({ title: "t" })
    expect(await pin({ title: "t" }, { owner: "octo", repo: "hello", name: "" })).toEqual({ title: "t" })
    expect(await pin({ title: "t" })).toEqual({ title: "t" })
  })
})
