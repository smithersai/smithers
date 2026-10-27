// Publish's and Update branch's steps on a device engine (src/features/branch/publishSteps.ts,
// docs/features/branch-publish.md): the first-party flows run in the real realm, their host action sent to a ChatApi
// stand-in on a real socket through the real HTTP clients, and the registry's `branch/publish`, `branch/update` and
// `branch/resync` run to their write on the Node host's engine.
import { digestSync } from "@smthrs/crypto"
import { Action, FlowRuntime, Graph } from "@smthrs/flow"
import { RealmFlow } from "@smthrs/harness"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { runFlow } from "../../../worker/test/flowHost.ts"
import publishFlow from "../../../plugins/branches/src/publish"
import updateFlow from "../../../plugins/branches/src/update"
import { BRANCH_FLOWS } from "../../plugins/builtinFlows"
import { BranchWrites, TrackRefused } from "./api"
import type { CreationSelection } from "./creation"
import type { RealmRequest } from "./creationFlows"
import { BranchTrackRefused, BranchTrackUnavailable } from "./flows"
import { BranchPublish, BranchResync, BranchUpdate, type OperationRequest } from "./publishFlows"
import { call, evaluate, registrationAt, run, select, writeFailure } from "./publishSteps"

const BRANCH = "6b9f3e2a-1c4d-4e5f-8a7b-9c0d1e2f3a4b"
const WRITE = "0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b"

const selection = (operation: "publish" | "update", source: string = BRANCH_FLOWS[operation].source): CreationSelection => ({
  owner: "octo",
  name: "hello",
  tag: BRANCH_FLOWS[operation].tag,
  source,
  digest: digestSync(source),
  revision: "a".repeat(40),
  runtime: RealmFlow.version,
  allowed: [operation === "publish" ? "branches/github-publish" : "branches/github-update"],
  operation,
})

const request = (operation: "publish" | "update"): OperationRequest => ({
  owner: "octo",
  name: "hello",
  branchId: BRANCH,
  operation,
  ...(operation === "publish" ? { title: "Add a line", body: "Why" } : {}),
  request: WRITE,
})

const state = (operation: "publish" | "update", selected = selection(operation)) => ({ selection: selected, request: request(operation), receipts: [] as Array<never> })
const drive = (value: Parameters<typeof evaluate>[0]) => evaluate(value).pipe(Effect.provide(RealmFlow.layerDefaultVariant))
const outcome = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  return Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause)
}
const receipt = (asked: typeof RealmRequest.Type, value: unknown = { writeId: WRITE, branchId: BRANCH }) => ({
  ...asked,
  outcome: { _tag: "Success" as const, value },
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

/** A ChatApi stand-in on a real socket: every request recorded with its body, answered by `respond`. */
const serve = async (respond: (request: IncomingMessage, body: string, response: ServerResponse) => void) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const server = createServer((incoming, response) => {
    let body = ""
    incoming.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
    incoming.on("end", () => {
      seen.push({ method: incoming.method!, url: incoming.url!, body })
      respond(incoming, body, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}
const answer = (response: ServerResponse, status: number, body: unknown = {}) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const writesLayer = (origin: string) => BranchWrites.layer({ origin }).pipe(Layer.provide(FetchHttpClient.layer))

describe("the first-party flows in the realm", () => {
  test("the compiled defaults declare exactly their public host actions", () => {
    expect(Graph.build(publishFlow, { title: "Add a line", body: "Why" }).diagnostics).toEqual([])
    expect(Graph.inspect(publishFlow).steps.map((step) => step.label)).toEqual(["branches/github-publish"])
    expect(Graph.build(updateFlow, {}).diagnostics).toEqual([])
    expect(Graph.inspect(updateFlow).steps.map((step) => step.label)).toEqual(["branches/github-update"])
  })

  test("Publish asks its host action with the person's title and body, and completes only with the matching receipt", async () => {
    const initial = state("publish")
    const asked = await outcome(drive(initial))
    expect(asked).toMatchObject({ _tag: "Action", name: "branches/github-publish", payload: { title: "Add a line", body: "Why" } })
    const done = await outcome(drive({ ...initial, receipts: [receipt(asked as typeof RealmRequest.Type)] }))
    expect(done).toEqual({ _tag: "Complete", value: { writeId: WRITE, branchId: BRANCH } })
  })

  test("Publish without a title or a body asks with empty ones, which the host call refuses", async () => {
    const bare = { ...state("publish"), request: { ...request("publish"), title: undefined, body: undefined } } as never
    expect(await outcome(drive(bare))).toMatchObject({ _tag: "Action", payload: { title: "", body: "" } })
  })

  test("Update asks for a merge, GitHub's default", async () => {
    expect(await outcome(drive(state("update")))).toMatchObject({ _tag: "Action", name: "branches/github-update", payload: { method: "merge" } })
  })

  test("a changed source or runtime, a second receipt, a failed receipt or another write's receipt is refused", async () => {
    const asked = (await outcome(drive(state("publish")))) as typeof RealmRequest.Type
    const invalid = new BranchTrackRefused({ reason: "invalid" })
    expect(await outcome(drive({ ...state("publish"), selection: { ...selection("publish"), digest: "changed" } }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), selection: { ...selection("publish"), runtime: "changed" } }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), receipts: [receipt(asked), receipt({ ...asked, key: "other" })] as never }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), receipts: [{ ...asked, outcome: { _tag: "Failure", error: {} } }] as never }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), receipts: [receipt(asked, { writeId: "other", branchId: BRANCH })] as never }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), receipts: [receipt(asked, { writeId: WRITE, branchId: "other" })] as never }))).toEqual(invalid)
    expect(await outcome(drive({ ...state("publish"), receipts: [receipt(asked, { nope: true })] as never }))).toEqual(invalid)
    // A source asks its own first write; each case below answers that write's receipt.
    const firstOf = async (source: string) => (await outcome(drive(state("publish", selection("publish", source))))) as typeof RealmRequest.Type
    const twice = BRANCH_FLOWS.publish.source.replace(
      "Publish.call({ title, body })",
      "Publish.call({ title, body }).pipe(Node.bindPlanned(Node.capture({ publish: Publish.name }, () => Publish.call({ title: 'again', body: '' }))))",
    )
    const first = await firstOf(twice)
    expect(first, "the source asks its first write").toMatchObject({ _tag: "Action", name: "branches/github-publish" })
    const realm = (source: string, receipts: ReadonlyArray<unknown>) =>
      outcome(RealmFlow.step({ source, expectedTag: "branches/publish", payload: { title: "Add a line", body: "Why" }, allowedActions: ["branches/github-publish"], receipts: receipts as never })
        .pipe(Effect.provide(RealmFlow.layerDefaultVariant)))
    expect(await realm(twice, [receipt(first)]), "the realm asks a second write").toMatchObject({ _tag: "Action" })
    expect(await outcome(drive({ ...state("publish", selection("publish", twice)), receipts: [receipt(first)] as never }))).toEqual(invalid)
    const fabricated = `import {Flow} from '@smthrs/flow';import {Node} from '@smthrs/plan';import {Schema} from 'effect';
      export default Flow.make('branches/publish',{payload:{title:Schema.String,body:Schema.String},success:Schema.Unknown,
      body:Node.capture({},()=>Node.succeed(${JSON.stringify({ writeId: WRITE, branchId: BRANCH })}))});`
    expect(await outcome(drive(state("publish", selection("publish", fabricated))))).toEqual(invalid)
    for (const forged of [{ writeId: "forged", branchId: BRANCH }, { writeId: WRITE, branchId: "forged" }, { nope: true }]) {
      const lying = BRANCH_FLOWS.publish.source.replace(
        "Publish.call({ title, body })",
        `Publish.call({ title, body }).pipe(Node.map(Node.capture({}, () => (${JSON.stringify(forged)}))))`,
      )
      const asked_ = await firstOf(lying)
      expect(asked_, "the source asks its first write").toMatchObject({ _tag: "Action" })
      expect(await realm(lying, [receipt(asked_)]), "the realm completes with the forged value").toEqual({ _tag: "Complete", value: forged })
      expect(await outcome(drive({ ...state("publish", selection("publish", lying)), receipts: [receipt(asked_)] as never }))).toEqual(invalid)
    }
  })
})

describe("the host call", () => {
  test("sends the write under the run's id to the branch's repository, and answers its receipt", async () => {
    const server = await serve((_, __, response) => answer(response, 202, { txid: 1, writeId: WRITE }))
    const asked = (await outcome(drive(state("publish")))) as typeof RealmRequest.Type
    const got = await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(writesLayer(server.origin))))
    expect(got).toEqual({ ...asked, outcome: { _tag: "Success", value: { writeId: WRITE, branchId: BRANCH } } })
    expect(server.seen.map(({ method, url, body }) => [method, url, JSON.parse(body)])).toEqual([[
      "POST",
      "/api/repos/octo/hello/writes",
      { writeId: WRITE, op: "branch/publish", branchId: BRANCH, title: "Add a line", body: "Why" },
    ]])
    const update = (await outcome(drive(state("update")))) as typeof RealmRequest.Type
    await outcome(call({ state: state("update"), call: update }).pipe(Effect.provide(writesLayer(server.origin))))
    expect(JSON.parse(server.seen[1]!.body)).toEqual({ writeId: WRITE, op: "branch/update", branchId: BRANCH, method: "merge" })
  })

  test.each<readonly [number, unknown, string | null]>([
    [200, { status: "pending" }, null],
    [401, { code: "authentication" }, "sign_in"],
    [403, { code: "forbidden" }, "forbidden"],
    [404, { code: "not_found" }, "not_found"],
    [400, { code: "invalid" }, "invalid"],
    [413, { code: "too_large" }, "invalid"],
    [409, { code: "conflict" }, "exists"],
    [503, { code: "not_configured" }, "not_configured"],
  ])("ChatApi's %i is %s", async (status, body, reason) => {
    const server = await serve((_, __, response) => answer(response, status, body))
    const asked = (await outcome(drive(state("publish")))) as typeof RealmRequest.Type
    const got = await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(writesLayer(server.origin))))
    if (reason === null) expect(got).toMatchObject({ outcome: { _tag: "Success" } })
    else expect(got).toEqual(new BranchTrackRefused({ reason: reason as BranchTrackRefused["reason"] }))
  })

  test("ChatApi unavailable, unreachable or slower than the deadline is tried again", async () => {
    const server = await serve((_, __, response) => answer(response, 503, { code: "unavailable" }))
    const asked = (await outcome(drive(state("publish")))) as typeof RealmRequest.Type
    expect(await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(writesLayer(server.origin)))))
      .toEqual(new BranchTrackUnavailable())
    expect(await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(writesLayer("http://127.0.0.1:1")))))
      .toEqual(new BranchTrackUnavailable())
    const silent = await serve(() => undefined)
    const slow = BranchWrites.layer({ origin: silent.origin, within: "50 millis" }).pipe(Layer.provide(FetchHttpClient.layer))
    expect(await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(slow)))).toEqual(new BranchTrackUnavailable())
    const garbled = await serve((_, __, response) => {
      response.writeHead(503)
      response.end("not json")
    })
    expect(await outcome(call({ state: state("publish"), call: asked }).pipe(Effect.provide(writesLayer(garbled.origin)))))
      .toEqual(new BranchTrackUnavailable())
  })

  test("an unreadable refusal body keeps the HTTP status without inventing a refusal code", async () => {
    const faulty = HttpClient.make(() => Effect.succeed({
      status: 503,
      text: Effect.fail(new Error("response body interrupted")),
    } as never))
    const got = await outcome(Effect.flatMap(BranchWrites, (writes) => writes.send("octo", "hello", {
      writeId: WRITE, op: "branch/update", branchId: BRANCH, method: "merge",
    })).pipe(Effect.provide(BranchWrites.layer({ origin: "http://unreachable.test" }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, faulty)),
    ))))
    expect(got).toEqual(new TrackRefused({ status: 503 }))
    expect(writeFailure(got as TrackRefused)).toEqual(new BranchTrackUnavailable())
  })

  test("an action outside the operation, one the selection doesn't allow, or a payload that isn't one is refused before sending", async () => {
    const server = await serve((_, __, response) => answer(response, 202))
    const asked = (await outcome(drive(state("publish")))) as typeof RealmRequest.Type
    const invalid = new BranchTrackRefused({ reason: "invalid" })
    const send = (operation: "publish" | "update", made: typeof RealmRequest.Type, selected = selection(operation)) =>
      outcome(call({ state: state(operation, selected), call: made }).pipe(Effect.provide(writesLayer(server.origin))))
    expect(await send("update", asked, { ...selection("update"), allowed: ["branches/github-publish"] })).toEqual(invalid)
    expect(await send("publish", { ...asked, name: "branches/github-update" })).toEqual(invalid)
    expect(await send("publish", { ...asked, payload: { title: "   ", body: "" } })).toEqual(invalid)
    expect(await send("update", { ...asked, name: "branches/github-update", payload: { method: "squash" } })).toEqual(invalid)
    expect(server.seen).toEqual([])
  })

  test("a refusal's status means the same as the writes route's", () => {
    expect(writeFailure(new TrackRefused({ status: 503 }))).toEqual(new BranchTrackUnavailable())
    expect(writeFailure(new TrackRefused({}))).toEqual(new BranchTrackUnavailable())
  })
})

describe("the operation's child run", () => {
  test.each<readonly [string, Effect.Effect<never, unknown>, unknown]>([
    ["its own refusal passes through", Effect.fail(new BranchTrackRefused({ reason: "forbidden" })), new BranchTrackRefused({ reason: "forbidden" })],
    ["another failure is unavailable", Effect.fail(new Error("private-runtime-error")), new BranchTrackUnavailable()],
    ["a defect is unavailable", Effect.die("private-runtime-defect"), new BranchTrackUnavailable()],
  ])("%s", async (_, failing, expected) => {
    const faulty = FlowRuntime.FlowRuntime.of(new Proxy({}, { get: () => () => failing }) as FlowRuntime.FlowRuntime["Service"])
    expect(await outcome(run(request("publish")).pipe(Effect.provideService(FlowRuntime.FlowRuntime, faulty)))).toEqual(expected)
  })
})

describe("the selection", () => {
  test("asks for the operation's flow, and refuses one answered for another operation", async () => {
    // ChatApi answers Publish's selection whatever it is asked.
    const server = await serve((_, __, response) => answer(response, 200, selection("publish")))
    const select_ = (operation: "publish" | "update") =>
      outcome(select(server.origin)(request(operation)).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(await select_("publish")).toEqual(selection("publish"))
    expect(await select_("update")).toEqual(new BranchTrackRefused({ reason: "invalid" }))
    expect(server.seen.map((seen) => seen.url)).toEqual([
      "/api/branches/creation?owner=octo&name=hello&operation=publish",
      "/api/branches/creation?owner=octo&name=hello&operation=update",
    ])
  })
})

describe("branch/publish, branch/update and branch/resync on the engine", { timeout: 60_000 }, () => {
  /** ChatApi: the branch tracked, the operation's first-party flow selected, the write taken. */
  const chatApi = () =>
    serve((incoming, _, response) => {
      const url = new URL(incoming.url!, "http://x")
      if (url.pathname === "/api/branches") {
        return answer(response, 200, { branchId: BRANCH, conversationId: "c", repoId: "github/octo/hello", name: "try-1", mode: "open", access: "owner", shared: false })
      }
      if (url.pathname === "/api/branches/creation") return answer(response, 200, selection(url.searchParams.get("operation") as "publish" | "update"))
      return answer(response, 202, {})
    })

  test("a person's Publish sends one write, under an id the run keeps, to the branch's repository", async () => {
    const server = await chatApi()
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchPublish, { repo: "octo/hello", branch: "try-1", title: "Add a line" }, registration, { executionId: "publish-1", maxConnections: 2 })
    expect(Exit.isSuccess(ran.exit) && ran.exit.value.branchId).toBe(BRANCH)
    const writes = server.seen.filter((seen) => seen.url.endsWith("/writes")).map((seen) => JSON.parse(seen.body))
    expect(writes).toEqual([{ writeId: Exit.isSuccess(ran.exit) && ran.exit.value.writeId, op: "branch/publish", branchId: BRANCH, title: "Add a line", body: "" }])
    const again = await runFlow(BranchPublish, { repo: "octo/hello", branch: "try-1", title: "Add a line" }, registration, { executionId: "publish-1", maxConnections: 2 })
    expect(Exit.isSuccess(again.exit) && again.exit.value.writeId).toBe(Exit.isSuccess(ran.exit) && ran.exit.value.writeId)
  })

  test("Update branch sends the repository flow's merge", async () => {
    const server = await chatApi()
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchUpdate, { repo: "octo/hello", branch: "try-1" }, registration, { maxConnections: 2 })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(server.seen.filter((seen) => seen.url.endsWith("/writes")).map((seen) => JSON.parse(seen.body).method)).toEqual(["merge"])
  })

  test("Resync sends one write, under an id the run keeps, with no flow selected", async () => {
    const server = await chatApi()
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchResync, { repo: "octo/hello", branch: "try-1" }, registration, { executionId: "resync-1", maxConnections: 2 })
    const writeId = Exit.isSuccess(ran.exit) ? ran.exit.value.writeId : undefined
    expect(Exit.isSuccess(ran.exit) && ran.exit.value.branchId).toBe(BRANCH)
    expect(server.seen.filter((seen) => seen.url.endsWith("/writes")).map((seen) => JSON.parse(seen.body)))
      .toEqual([{ writeId, op: "branch/resync", branchId: BRANCH }])
    expect(server.seen.filter((seen) => seen.url.startsWith("/api/branches/creation"))).toEqual([])
    const again = await runFlow(BranchResync, { repo: "octo/hello", branch: "try-1" }, registration, { executionId: "resync-1", maxConnections: 2 })
    expect(Exit.isSuccess(again.exit) && again.exit.value.writeId).toBe(writeId)
  })

  test("a Resync while ChatApi can't answer is sent again under the same id", async () => {
    let sends = 0
    const server = await serve((incoming, _, response) => {
      if (new URL(incoming.url!, "http://x").pathname === "/api/branches") {
        return answer(response, 200, { branchId: BRANCH, conversationId: "c", repoId: "github/octo/hello", name: "try-1", mode: "open", access: "owner", shared: false })
      }
      return ++sends === 1 ? answer(response, 503, { code: "unavailable" }) : answer(response, 202, {})
    })
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchResync, { repo: "octo/hello", branch: "try-1" }, registration, { maxConnections: 2 })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const sent = server.seen.filter((seen) => seen.url.endsWith("/writes")).map((seen) => JSON.parse(seen.body).writeId)
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(1)
  })

  test("a Resync the writes route refuses says why: one on its way is exists", async () => {
    const server = await serve((incoming, _, response) =>
      new URL(incoming.url!, "http://x").pathname === "/api/branches"
        ? answer(response, 200, { branchId: BRANCH, conversationId: "c", repoId: "github/octo/hello", name: "try-1", mode: "open", access: "owner", shared: false })
        : answer(response, 409, { code: "conflict" }))
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchResync, { repo: "octo/hello", branch: "try-1" }, registration, { maxConnections: 2 })
    expect(Exit.isFailure(ran.exit) && Cause.squash(ran.exit.cause)).toEqual(new BranchTrackRefused({ reason: "exists" }))
  })

  test("a branch the person may not open is refused before any selection or write", async () => {
    const server = await serve((_, __, response) => answer(response, 403, { code: "forbidden" }))
    const registration = registrationAt(server.origin).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Action.layerImplementations))
    const ran = await runFlow(BranchUpdate, { repo: "octo/hello", branch: "try-1" }, registration, { maxConnections: 2 })
    expect(Exit.isFailure(ran.exit) && Cause.squash(ran.exit.cause)).toEqual(new BranchTrackRefused({ reason: "forbidden" }))
    expect(server.seen.map((seen) => seen.url)).toEqual(["/api/branches?optional=true"])
  })
})
