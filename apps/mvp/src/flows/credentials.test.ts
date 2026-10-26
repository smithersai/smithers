import { FlowRegistry } from "./registry"
// Run credentials on the device (src/flows/credentials.ts, decision 0017 slice 0), on the Node host's durable engine
// over the compose Postgres (`pnpm db:up`), against ChatApi's real runs routes: the person's own press goes in their
// session; an agent's run and every run nested in it, a run nobody pressed and a run whose tab is gone each go with a
// credential the server minted for that run and no cookie; a person-only call inside an agent's run is refused by the
// server before it is sent. The steps here are test flows named as the registry's, so their marks are the registry's.
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { TabChannel } from "@smthrs/platform-browser"
import { Node } from "@smthrs/plan"
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import type { Actor } from "../../worker/Actor.ts"
import { build } from "../../worker/test/flowHost.ts"
import { harness, testFile } from "../../worker/test/harness.ts"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { AuthStore, SESSION, signedOut } from "../features/auth/store"
import { credentialRoute, DOORS } from "./contract"
import * as RunCredentials from "./credentials"
import { tabDoors } from "./doors"
import { TabRequests } from "./requests"

const runtime = testFile("device_credentials")
const ORIGIN = "http://chat.test"
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

/** What a step's request got back: its status and the route's code. */
const Got = Schema.Struct({ status: Schema.Number, code: Schema.optional(Schema.String) })

/** A step that sends one request, as its run: `POST <path>` with `body`, or a transport failure as status 0. */
const Send = Action.make("test/send", {
  payload: { path: Schema.String, body: Schema.Unknown },
  success: Got,
  tier: "sealed",
})

/**
 * The client this device's steps send through, as the app's step clients hold theirs (`RunsClient` and the rest): the
 * one the engine's run credentials provide, taken when the registration is built.
 */
class Sender extends Context.Service<Sender, HttpClient.HttpClient>()("test/credentials/Sender") {}

const send = ({ path, body }: { readonly path: string; readonly body: unknown }) =>
  Effect.gen(function* () {
    const response = yield* (yield* Sender).execute(
      HttpClientRequest.post(path.startsWith("http") ? path : `${ORIGIN}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    const json = yield* response.json.pipe(Effect.orElseSucceed(() => ({})))
    const code = typeof json === "object" && json !== null && "code" in json ? String(json.code) : undefined
    return { status: response.status, ...(code === undefined ? {} : { code }) }
  }).pipe(Effect.orElseSucceed(() => ({ status: 0 })))

/** A test flow named `tag` whose one step sends its payload's request. */
const sending = (tag: string, capabilities?: ReadonlyArray<string>) =>
  Flow.make(tag, {
    payload: { path: Schema.String, body: Schema.Unknown },
    success: Got,
    ...(capabilities === undefined ? {} : { capabilities }),
    body: Node.capture({ send: Send.name }, (payload) => Send.call(payload)),
  })

// The registry's names, so the registry's marks: `run/answer` the person's and person-only, `watch/set` the person's,
// `chat/Answer` an agent.
const Answer = sending("run/answer")
const Watch = sending("watch/set")
const Plugin = sending("repo/read", ["fs:read:src/**"])
/** A flow the engine runs but wasn't given among its declarations: it declares nothing to the server. */
const Unlisted = sending("repo/tree", ["fs:read:src/**"])

/** A step that reads its run's credential, as a write the tab sends for it does: none, one, or why not. */
const Bearer = Action.make("test/bearer", { payload: {}, success: Schema.String, tier: "sealed" })
const bearing = (tag: string) =>
  Flow.make(tag, { payload: {}, success: Schema.String, body: Node.capture({ bearer: Bearer.name }, () => Bearer.call({})) })
const bearer = () =>
  Effect.flatMap(RunCredentials.RunCredentials, (credentials) => credentials.bearer).pipe(
    Effect.map(Option.match({ onNone: () => "none", onSome: () => "token" })),
    Effect.catchTag("CredentialUnavailable", (error) => Effect.succeed(`refused ${error.reason}`)),
  )
const Write = bearing("issue/create")
const Commit = bearing("todo/commit")

/** `chat/Answer` as a test flow: reports through its own step, then calls `run/answer` nested, as an agent's cell would. */
const Nest = Action.make("test/nest", {
  payload: { answerId: Schema.String },
  success: Schema.Struct({ report: Got, nested: Got }),
  tier: "sealed",
})
const Agent = Flow.make("chat/Answer", {
  payload: { answerId: Schema.String },
  success: Schema.Struct({ report: Got, nested: Got }),
  body: Node.capture({ nest: Nest.name }, (payload) => Nest.call(payload)),
})
const nest = ({ answerId }: { readonly answerId: string }) =>
  Effect.gen(function* () {
    const report = yield* send({ path: `/api/runs/${answerId}`, body: { status: "working" } })
    const runtime = yield* FlowRuntime.FlowRuntime
    const nested = yield* runtime.execute(Answer, {
      executionId: `${answerId}/call/0.1`,
      payload: { path: `/api/runs/${answerId}/answer`, body: { version: 1, value: "main" } },
    }).pipe(Effect.orElseSucceed(() => ({ status: -1 })))
    return { report, nested }
  })

/** `flow/run` as a test flow: the person's press of their own flow, which runs `watch/set` nested. */
const Inner = Action.make("test/inner", { payload: { path: Schema.String, body: Schema.Unknown }, success: Got, tier: "sealed" })
const Outer = Flow.make("flow/run", {
  payload: { path: Schema.String, body: Schema.Unknown },
  success: Got,
  body: Node.capture({ inner: Inner.name }, (payload) => Inner.call(payload)),
})
const inner = (payload: { readonly path: string; readonly body: unknown }) =>
  Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
    runtime.execute(Watch, { executionId: `${crypto.randomUUID()}-inner`, payload }).pipe(
      Effect.orElseSucceed(() => ({ status: -1 })),
    ))

/** One request as the transport saw it: its path, whether it carried a credential, and its cookie policy. */
interface Seen {
  readonly path: string
  readonly bearer: boolean
  readonly credentials: RequestCredentials | undefined
}

const engines: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of engines.splice(0)) await close()
})

/**
 * A device for `actor` (signed out when `null`): ChatApi's real routes, every request this engine sends recorded, and
 * this engine's tab, which remembers the doors `doors` names. `fault` answers a request in place of ChatApi.
 */
const device = async (
  actor: Actor | null,
  options: {
    readonly fault?: (path: string) => Response | "unreachable" | undefined
    readonly inspection?: boolean
    /** The tab's sign-in row says nobody is signed in, as a visitor's does once ChatApi said so. */
    readonly tabSignedOut?: boolean
  } = {},
) => {
  const h = await harness(runtime, () => Stream.empty, actor === null ? {} : { actor })
  const seen: Array<Seen> = []
  // The host's transport, as the browser's fetch client is: it reads the fetch options a request runs with
  // (`FetchHttpClient.RequestInit`, where a run leaves the cookie off), and hands the request to ChatApi in process.
  const transport = HttpClient.make((request, url, _signal, fiber) =>
    Effect.gen(function* () {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)
      seen.push({ path: url.pathname, bearer: "authorization" in request.headers, credentials: init?.credentials })
      const body = request.body._tag === "Uint8Array" ? new Blob([new Uint8Array(request.body.body)]) : undefined
      const faulty = options.fault?.(url.pathname)
      if (faulty === "unreachable") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }),
        )
      }
      const response = faulty ?? (yield* Effect.promise(() =>
        h.fetch(`${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body })
      ))
      return HttpClientResponse.fromWeb(request, response)
    })
  )
  const name = `credentials-${crypto.randomUUID()}`
  const requests = TabRequests.layer()
  const flows = [Answer, Watch, Plugin, Agent, Write, Commit, Outer]
  const registration = Layer.mergeAll(
    Interpreter.layerWithImplementations(Answer, Send.toLayer(send)),
    Interpreter.layerWithImplementations(Watch, Send.toLayer(send)),
    Interpreter.layerWithImplementations(Plugin, Send.toLayer(send)),
    Interpreter.layerWithImplementations(Unlisted, Send.toLayer(send)),
    Interpreter.layerWithImplementations(Outer, Inner.toLayer(inner)),
    Interpreter.layerWithImplementations(Agent, Nest.toLayer(nest)),
    Interpreter.layerWithImplementations(Write, Bearer.toLayer(bearer)),
    Interpreter.layerWithImplementations(Commit, Bearer.toLayer(bearer)),
    options.tabSignedOut === true
      ? tabDoors({ name, signedOut }).pipe(Layer.provide(
        Layer.effectDiscard(Effect.flatMap(Effect.service(AuthStore), (auth) =>
          Effect.orDie(auth.session.update(SESSION, (row) => void (row.status = "signed_out"))))).pipe(
            Layer.provideMerge(AuthStore.layer),
            Layer.provide(Persistence.memory),
          ),
      ))
      : tabDoors({ name }),
  ).pipe(
    Layer.provideMerge(Layer.effect(Sender, HttpClient.HttpClient)),
    Layer.provideMerge(RunCredentials.layer({ origin: ORIGIN, name, flows }).pipe(Layer.provide(FlowRegistry.layer))),
    Layer.provideMerge(requests),
    Layer.provide(TabChannel.layer),
    Layer.provide(
      options.inspection === false
        ? Layer.succeed(
          EngineStore.RunInspection.RunInspection,
          // A store that can't say a run's lineage: every read fails.
          { inspect: () => Effect.fail({ _tag: "RunStoreError" }) } as never,
        )
        : EngineStore.RunInspection.layer,
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
  )
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(Scope.provide(scope)(build(registration)))
  engines.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const flowRuntime = Context.get(built.context, FlowRuntime.FlowRuntime)
  const tab = Context.get(built.context, TabRequests)
  const credentials = Context.get(built.context, RunCredentials.RunCredentials)
  const sender = Context.get(built.context, Sender)
  return {
    h,
    seen,
    credentials,
    /** Sends `path` through this engine's client outside any run, as host code would. */
    sendOutside: (path: string, body: unknown) => Effect.runPromise(send({ path, body }).pipe(Effect.provideService(Sender, sender))),
    /** Runs `flow` as `executionId`, started by the tab through `door`, or by nobody, and answers its value. */
    run: async (flow: Flow.Any, executionId: string, payload: unknown, door?: (typeof DOORS)[number]) => {
      if (door !== undefined) await Effect.runPromise(tab.add(executionId, door))
      return Effect.runPromise(flowRuntime.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown>)
    },
    /** The requests the transport saw to `path`. */
    seenFor: (path: string) => seen.filter((request) => request.path === path),
  }
}

const asked = async (h: Awaited<ReturnType<typeof harness>>) => {
  const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Deploy the docs preview" }
  expect((await h.ask(question)).status).toBe(202)
  return question.answerId
}
const waiting = { execution: "x/call/0.0", kind: "question", prompt: "Which branch?", options: ["main", "docs-v2"] }

describe("who a run's requests go as", () => {
  test("the agent's run goes with its credential; its nested run/answer is refused before anything is sent", async () => {
    const d = await device(member)
    const answerId = await asked(d.h)
    const ran = await d.run(Agent, answerId, { answerId })
    expect(ran).toEqual({ report: { status: 200 }, nested: { status: 403, code: "person_only" } })
    // The report went with the agent's credential and no cookie; the nested answer never reached its route.
    expect(d.seenFor(`/api/runs/${answerId}`)).toEqual([{ path: `/api/runs/${answerId}`, bearer: true, credentials: "omit" }])
    expect(d.seenFor(`/api/runs/${answerId}/answer`)).toEqual([])
    // One credential for the run, asked for in the person's session; one refused for the nested call, under it.
    expect(d.seen.filter((request) => request.path.endsWith("/credential")).map(({ bearer, credentials }) => ({ bearer, credentials })))
      .toEqual([{ bearer: false, credentials: undefined }, { bearer: true, credentials: "omit" }])
  })

  test("the person's own press goes in their session; the same flow through another door is refused", async () => {
    const d = await device(member)
    const answerId = await asked(d.h)
    expect((await d.h.fetch(`/api/runs/${answerId}`, { method: "POST", body: JSON.stringify({ status: "needs_you", wait: waiting }) })).status)
      .toBe(200)
    const answer = { path: `/api/runs/${answerId}/answer`, body: { version: 1, value: "main" } }
    // A door that isn't the person's (a page's own `view`).
    expect(await d.run(Answer, crypto.randomUUID(), answer, "view")).toEqual({ status: 403, code: "person_only" })
    expect(d.seenFor(answer.path)).toEqual([])
    // The person's press.
    expect(await d.run(Answer, crypto.randomUUID(), answer, "button")).toEqual({ status: 200 })
    expect(d.seenFor(answer.path)).toEqual([{ path: answer.path, bearer: false, credentials: undefined }])
    // The person's key on the host's action strip (decision 0017) is their press too: the same answer again is taken.
    expect(await d.run(Answer, crypto.randomUUID(), answer, "key")).toEqual({ status: 200 })
    expect(d.seenFor(answer.path)).toEqual([
      { path: answer.path, bearer: false, credentials: undefined },
      { path: answer.path, bearer: false, credentials: undefined },
    ])
  })

  test("a person's press of a flow only they run goes in their session when its tab doesn't answer", async () => {
    const d = await device(member)
    const answerId = await asked(d.h)
    expect((await d.h.fetch(`/api/runs/${answerId}`, { method: "POST", body: JSON.stringify({ status: "needs_you", wait: waiting }) })).status)
      .toBe(200)
    const answer = { path: `/api/runs/${answerId}/answer`, body: { version: 1, value: "main" } }
    // No tab answers: busy past the wait, or reloaded while the engine resumed the run. Dispatch starts run/answer only
    // through a person door (src/flows/dispatch.ts), so it is the person's press; a credential would be refused.
    expect(await d.run(Answer, `retry:${crypto.randomUUID()}:1`, answer)).toEqual({ status: 200 })
    expect(d.seenFor(answer.path)).toEqual([{ path: answer.path, bearer: false, credentials: undefined }])
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toEqual([])
    // Any other person's flow whose tab is silent still gets a credential, and the wait is a record.
    const watchRun = crypto.randomUUID()
    expect(await d.run(Watch, watchRun, { path: "/api/watches", body: { conversationId: null } }))
      .toMatchObject({ status: 200 })
    expect(d.seenFor("/api/watches")).toEqual([{ path: "/api/watches", bearer: true, credentials: "omit" }])
    expect(d.seen.filter((request) => request.path.endsWith("/credential")).map((request) => request.path)).toEqual([credentialRoute(watchRun)])
  })

  test("a run nested in the person's press asks for its credential in their session", async () => {
    const d = await device(member)
    const watch = { path: "/api/watches", body: { conversationId: null } }
    expect(await d.run(Outer, crypto.randomUUID(), watch, "button")).toMatchObject({ status: 200 })
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toEqual([
      expect.objectContaining({ bearer: false, credentials: undefined }),
    ])
    expect(d.seenFor("/api/watches")).toEqual([{ path: "/api/watches", bearer: true, credentials: "omit" }])
  })

  test("a run nobody pressed goes with a flow's credential, minted once however many requests it sends", async () => {
    const d = await device(member)
    const executionId = crypto.randomUUID()
    const watch = { path: "/api/watches", body: { conversationId: null } }
    await d.run(Watch, executionId, watch, "view")
    await d.run(Watch, executionId, watch, "view")
    const minted = d.seen.filter((request) => request.path === `/api/runs/${encodeURIComponent(executionId)}/credential`)
    expect(minted).toHaveLength(1)
    expect(d.seenFor("/api/watches").every((request) => request.bearer && request.credentials === "omit")).toBe(true)
  })

  test("a run with no recorded parent is nested in the run it is named after, when this engine holds one", async () => {
    const d = await device(member)
    const answerId = await asked(d.h)
    await d.run(Agent, answerId, { answerId })
    const watch = { path: "/api/watches", body: { conversationId: null } }
    // `<answer>/…`, as an answer's close is named: the agent's chain, one deeper.
    expect(await d.run(Watch, `${answerId}/close`, watch)).toMatchObject({ status: 200 })
    expect(d.h.line("auth.credential").at(-1)).toMatchObject({ annotations: { flow: "watch/set", act: "agent", depth: 2 } })
    // `ack/…` names no run: a root of its own, here pressed by nobody.
    expect(await d.run(Watch, `ack/${crypto.randomUUID()}`, watch, "view")).toMatchObject({ status: 200 })
    expect(d.h.line("auth.credential").at(-1)).toMatchObject({ annotations: { flow: "watch/set", act: "flow", depth: 1 } })
  })

  test("a credential the server no longer reads is asked for again, once", async () => {
    let stale = 1
    const d = await device(member, {
      fault: (path) => (path === "/api/watches" && stale-- > 0 ? new Response("{}", { status: 401 }) : undefined),
    })
    expect(await d.run(Watch, crypto.randomUUID(), { path: "/api/watches", body: { conversationId: null } }, "view"))
      .toMatchObject({ status: 200 })
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toHaveLength(2)
    expect(d.seenFor("/api/watches")).toHaveLength(2)
  })

  test("a flow that declares a ceiling asks with it, and the server narrows its chain to it", async () => {
    const d = await device(member)
    expect(await d.run(Plugin, crypto.randomUUID(), { path: "/api/watches", body: { conversationId: null } }, "view"))
      .toMatchObject({ status: 200 })
    expect(d.h.line("auth.credential").at(-1)).toMatchObject({ annotations: { flow: "repo/read", act: "flow", status: 200 } })
    expect(await d.run(Unlisted, crypto.randomUUID(), { path: "/api/watches", body: { conversationId: null } }, "view"))
      .toMatchObject({ status: 200 })
  })

  test("signed out, a run's requests go with no credential and no cookie, its nested runs' too", async () => {
    const d = await device(null)
    const watch = { path: "/api/watches", body: { conversationId: null } }
    expect(await d.run(Watch, crypto.randomUUID(), watch, "view")).toMatchObject({ status: 401 })
    expect(d.seenFor("/api/watches")).toEqual([{ path: "/api/watches", bearer: false, credentials: "omit" }])
    const answerId = crypto.randomUUID()
    expect(await d.run(Agent, answerId, { answerId })).toMatchObject({ report: { status: 401 }, nested: { status: 401 } })
    expect(d.seenFor(`/api/runs/${answerId}/answer`)).toEqual([
      { path: `/api/runs/${answerId}/answer`, bearer: false, credentials: "omit" },
    ])
  })

  test("from a tab where nobody is signed in, a run nobody pressed asks for no credential; the person's press goes as theirs", async () => {
    const d = await device(null, { tabSignedOut: true })
    const watch = { path: "/api/watches", body: { conversationId: null } }
    expect(await d.run(Watch, crypto.randomUUID(), watch, "view")).toMatchObject({ status: 401 })
    // The route's own 401 is the run's answer; no credential request came back 401 first.
    expect(d.seenFor("/api/watches")).toEqual([{ path: "/api/watches", bearer: false, credentials: "omit" }])
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toEqual([])
    expect(await d.run(Watch, crypto.randomUUID(), watch, "button")).toMatchObject({ status: 401 })
    expect(d.seenFor("/api/watches").at(-1)).toEqual({ path: "/api/watches", bearer: false, credentials: undefined })
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toEqual([])
  })

  test("a signed-out tab's agent root and nested runs ask for no credentials", async () => {
    const d = await device(null, { tabSignedOut: true })
    const answerId = crypto.randomUUID()
    expect(await d.run(Agent, answerId, { answerId }, "view")).toMatchObject({ report: { status: 401 }, nested: { status: 401 } })
    expect(d.seen.filter((request) => request.path.endsWith("/credential"))).toEqual([])
    expect(d.seenFor(`/api/runs/${answerId}`)).toEqual([
      { path: `/api/runs/${answerId}`, bearer: false, credentials: "omit" },
    ])
  })

  test("a credential the server can't mint, or a lineage the engine can't read, sends nothing", async () => {
    const d = await device(member, {
      fault: (path) => (path.endsWith("/credential") ? new Response("{}", { status: 503 }) : undefined),
    })
    expect(await d.run(Watch, crypto.randomUUID(), { path: "/api/watches", body: {} }, "view")).toEqual({ status: 0 })
    expect(d.seenFor("/api/watches")).toEqual([])
    // A mint that never reaches ChatApi, or answers what isn't a credential.
    for (const fault of ["unreachable", () => new Response("not json", { status: 200 })] as const) {
      const faulty = await device(member, {
        fault: (path) => (!path.endsWith("/credential") ? undefined : fault === "unreachable" ? fault : fault()),
      })
      expect(await faulty.run(Watch, crypto.randomUUID(), { path: "/api/watches", body: {} }, "view")).toEqual({ status: 0 })
      expect(faulty.seenFor("/api/watches")).toEqual([])
    }
    // A refusal with no code is still a refusal, and its answer.
    const refusing = await device(member, {
      fault: (path) => (path.endsWith("/credential") ? new Response("{}", { status: 409 }) : undefined),
    })
    expect(await refusing.run(Watch, crypto.randomUUID(), { path: "/api/watches", body: {} }, "view"))
      .toEqual({ status: 409, code: "refused" })
    const lost = await device(member, { inspection: false })
    expect(await lost.run(Watch, crypto.randomUUID(), { path: "/api/watches", body: {} }, "view")).toEqual({ status: 0 })
    expect(lost.seenFor("/api/watches")).toEqual([])
  })

  test("a run's credential, for a request the tab sends for it: none for the person's press, else one, or why not", async () => {
    const d = await device(member)
    expect(await d.run(Write, crypto.randomUUID(), {}, "button")).toBe("none")
    expect(await d.run(Write, crypto.randomUUID(), {}, "view")).toBe("token")
    expect(await d.run(Commit, crypto.randomUUID(), {}, "sync")).toBe("refused person_only")
    const signedOut = await device(null)
    expect(await signedOut.run(Write, crypto.randomUUID(), {}, "view")).toBe("refused signed_out")
  })

  test("outside a run, and to anywhere but ChatApi's API, a request goes as the host sends it", async () => {
    const d = await device(member)
    expect(await Effect.runPromise(d.credentials.bearer)).toEqual(Option.none())
    expect(await d.sendOutside("/api/watches", { conversationId: null })).toMatchObject({ status: 200 })
    expect(await d.run(Watch, crypto.randomUUID(), { path: "http://elsewhere.test/api/watches", body: {} }, "view"))
      .toMatchObject({ status: expect.any(Number) })
    expect(d.seenFor("/api/watches")).toEqual([
      { path: "/api/watches", bearer: false, credentials: undefined },
      { path: "/api/watches", bearer: false, credentials: undefined },
    ])
  })
})
