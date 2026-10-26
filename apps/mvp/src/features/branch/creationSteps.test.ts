import { digestSync, WebCrypto } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { RealmFlow } from "@smthrs/harness"
import { Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Logger, References, Schema, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, onTestFailed, test } from "vitest"
import { CREATION } from "../../plugins/builtinFlows"
import { BranchClient, TrackRefused } from "./api"
import { type CreationSelection } from "./creation"
import { CreationRequest, CreationStart, type RealmRequest, type State } from "./creationFlows"
import { call, evaluate, registration, run, select } from "./creationSteps"
import { BranchTrackRefused, BranchTrackUnavailable, TrackFailure } from "./flows"
import { Tracked } from "./schema"
import { Node } from "@smthrs/plan"
import { NEW_RETRY } from "../conversations/flows"
import { build } from "../../../worker/test/flowHost.ts"

const made: Tracked = {
  branchId: "branch",
  conversationId: "conversation",
  repoId: "github/octo/hello",
  name: "topic",
  mode: "open",
  access: "owner",
  shared: false
}
const request = { owner: "octo", name: "hello", ref: "topic", request: "b56e9ad0-4e67-4b4b-9952-0fbdb119174e" }
const selection = (source = CREATION.source, allowed = ["branches/ephemeral"]): CreationSelection => ({
  owner: "octo",
  name: "hello",
  tag: CREATION.tag,
  source,
  digest: digestSync(source),
  revision: "a".repeat(40),
  runtime: RealmFlow.version,
  allowed
})
const state = (selected = selection()): typeof State.Type => ({ selection: selected, request, receipts: [] })
const drive = (value: typeof State.Type) => evaluate(value).pipe(Effect.provide(RealmFlow.layerDefaultVariant))
const action = async (value = state()) => {
  const result = await Effect.runPromise(drive(value))
  if (result._tag !== "Action") throw Error("Expected a real realm action request")
  return result
}
const receipt = (call: typeof RealmRequest.Type, value: unknown = made) => ({
  ...call,
  outcome: { _tag: "Success" as const, value }
})
const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Expected a refusal")
  return result.failure
}
const refused = (error: unknown, reason: string) => {
  expect(error).toBeInstanceOf(BranchTrackRefused)
  expect((error as BranchTrackRefused).reason).toBe(reason)
}
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})
// Real sockets and the real HTTP/BranchClient layers exercise their transport
// boundaries. The worker's provider/storage behavior is covered in worker tests.
const serve = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    respond(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths }
}
const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

describe("pinned branch creation realm admission", () => {
  test("executes the pinned SDK flow and accepts only the matching host receipt", async () => {
    const initial = state()
    const requested = await action(initial)
    expect(requested.name).toBe("branches/ephemeral")
    expect(requested.payload).toEqual({ ref: "topic" })
    expect(await Effect.runPromise(drive({ ...initial, receipts: [receipt(requested)] }))).toEqual({
      _tag: "Complete",
      value: made
    })
  })
  test("refuses changed runtime/source digests and multiple stored writes before executing code", async () => {
    const requested = await action()
    for (const selected of [{ ...selection(), runtime: "changed" }, { ...selection(), digest: "changed" }]) {
      refused(await failure(drive(state(selected))), "invalid")
    }
    refused(
      await failure(drive({ ...state(), receipts: [receipt(requested), receipt({ ...requested, key: "other" })] })),
      "invalid"
    )
  })
  test("rejects fabricated completion without any host write and realm/source errors", async () => {
    const fake = `import {Flow} from '@smthrs/flow';import {Node} from '@smthrs/plan';import {Schema} from 'effect';
      export default Flow.make('branches/create',{payload:{ref:Schema.String},success:Schema.Unknown,
      body:Node.capture({},()=>Node.succeed(${JSON.stringify(made)}))});`
    for (
      const source of [fake, "throw Error('private source')", CREATION.source.replace("branches/create", "wrong/tag")]
    ) {
      refused(await failure(drive(state(selection(source)))), "invalid")
    }
  })
  test("rejects a second requested write even when the first has a valid receipt", async () => {
    const source = CREATION.source.replace(
      "Create.call({ ref })",
      "Create.call({ ref }).pipe(Node.bindPlanned(Node.capture({}, () => Create.call({ref}))))"
    )
    const initial = state(selection(source))
    const first = await action(initial)
    refused(await failure(drive({ ...initial, receipts: [receipt(first)] })), "invalid")
  })
  test("rejects an invalid recorded branch, malformed completion, and a changed result field", async () => {
    const initial = state()
    const first = await action(initial)
    refused(await failure(drive({ ...initial, receipts: [receipt(first, { branchId: "only" })] })), "invalid")
    for (const value of [{ branchId: "only" }, { ...made, name: "other" }]) {
      const source = CREATION.source.replace(
        "Create.call({ ref })",
        `Create.call({ ref }).pipe(Node.map(Node.capture({}, () => (${JSON.stringify(value)}))))`
      )
      const selected = state(selection(source))
      const requested = await action(selected)
      refused(await failure(drive({ ...selected, receipts: [receipt(requested)] })), "invalid")
    }
  })
  test("refuses a completed flow recovered from a failed action receipt", async () => {
    const source = CREATION.source.replace("success: Schema.Unknown,", "success: Schema.Unknown, error:Schema.String,")
      .replace(
        "Create.call({ ref })",
        `Create.call({ ref }).pipe(Node.catch({onFailure:Node.capture({},()=>Node.succeed(${JSON.stringify(made)}))}))`
      )
    const initial = state(selection(source))
    const first = await action(initial)
    refused(
      await failure(drive({ ...initial, receipts: [{ ...first, outcome: { _tag: "Failure", error: "failed" } }] })),
      "invalid"
    )
  })
})

describe("creation selection HTTP boundary", () => {
  test("selects a pinned repository or the home default through real GET requests", async () => {
    const selected = selection()
    const server = await serve(json(200, selected))
    for (const input of [request, { ref: "topic", request: request.request }]) {
      expect(await Effect.runPromise(select(server.origin)(input).pipe(Effect.provide(FetchHttpClient.layer)))).toEqual(
        selected
      )
    }
    expect(server.paths).toEqual(["GET /api/branches/creation?owner=octo&name=hello", "GET /api/branches/creation"])
  })
  test.each([[400, "invalid"], [401, "sign_in"], [403, "forbidden"], [404, "not_found"], [413, "invalid"], [429, null], [503, null]] as const)(
    "handles HTTP %s",
    async (status, reason) => {
      const server = await serve(json(status, {}))
      const error = await failure(select(server.origin)(request).pipe(Effect.provide(FetchHttpClient.layer)))
      if (reason === null) expect(error).toBeInstanceOf(BranchTrackUnavailable)
      else refused(error, reason)
    }
  )
  test("refuses unreachable, invalid JSON, and out-of-contract selection answers", async () => {
    const malformed = await serve((_, response) => {
      response.writeHead(200)
      response.end("not json")
    })
    const invalid = await serve(json(200, { source: "missing fields" }))
    for (const origin of ["http://127.0.0.1:1", malformed.origin, invalid.origin]) {
      expect(await failure(select(origin)(request).pipe(Effect.provide(FetchHttpClient.layer)))).toBeInstanceOf(
        BranchTrackUnavailable
      )
    }
  })
  test.each(["request", "body"] as const)(
    "times out an unresolved %s through the injected faulty HTTP service",
    async (phase) => {
      const faulty = HttpClient.make(() =>
        phase === "request" ? Effect.never : Effect.succeed({ status: 200, json: Effect.never } as never)
      )
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const pending = yield* Effect.forkChild(Effect.result(
            select("http://unreachable.test")(request).pipe(
              Effect.provideService(HttpClient.HttpClient, faulty)
            )
          ))
          yield* TestClock.adjust("20 seconds")
          return yield* Fiber.join(pending)
        }).pipe(Effect.provide(TestClock.layer()))
      )
      expect(error).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/branch/BranchTrackUnavailable" } })
    }
  )
})

describe("creation provider authority", () => {
  test.each(
    ["branches/ephemeral", "branches/github"].flatMap((name) =>
      [undefined, 123].map((openedAt) => ({ name, openedAt }))
    )
  )("fixes repository/request identity for $name ($openedAt) using the real client", async ({ name, openedAt }) => {
    const posted: unknown[] = []
    const server = await serve((req, res) => {
      let body = ""
      req.on("data", (chunk) => {
        body += String(chunk)
      })
      req.on("end", () => {
        posted.push(JSON.parse(body))
        json(201, made)(req, res)
      })
    })
    const initial = {
      ...state(selection(CREATION.source, [name])),
      request: { ...request, owner: "attacker", name: "wrong", ...(openedAt === undefined ? {} : { openedAt }) }
    }
    const requested = {
      _tag: "Action" as const,
      key: "canonical",
      name,
      payload: { ref: "adjusted", owner: "attacker", provider: "github" }
    }
    expect(
      await Effect.runPromise(
        call({ state: initial, call: requested }).pipe(Effect.provide(
          BranchClient.layer({ origin: server.origin }).pipe(Layer.provide(FetchHttpClient.layer))
        ))
      )
    ).toEqual({ ...requested, outcome: { _tag: "Success", value: made } })
    expect(posted).toEqual([{
      owner: "octo",
      name: "hello",
      ref: "adjusted",
      create: true,
      request: request.request,
      ...(name === "branches/github" ? { provider: "github" } : {}),
      ...(openedAt === undefined ? {} : { openedAt })
    }])
  })
  test("rejects invalid names, payloads, undeclared actions, and arbitrary admitted names before provider dispatch", async () => {
    const requested = {
      _tag: "Action" as const,
      key: "canonical",
      name: "branches/ephemeral",
      payload: { ref: "topic" }
    }
    const faulty = BranchClient.of({ track: () => Effect.die("The authority guard must refuse before dispatch") })
    for (
      const changed of [
        { payload: {} },
        { payload: { ref: 3 } },
        { payload: { ref: "bad..ref" } },
        { name: "branches/github" },
        { name: "other/action" }
      ]
    ) {
      refused(
        await failure(
          call({ state: state(), call: { ...requested, ...changed } }).pipe(Effect.provideService(BranchClient, faulty))
        ),
        "invalid"
      )
    }
    refused(
      await failure(
        call({
          state: state(selection(CREATION.source, ["other/action"])),
          call: { ...requested, name: "other/action" }
        })
          .pipe(Effect.provideService(BranchClient, faulty))
      ),
      "invalid"
    )
  })
  test.each(
    [[403, "forbidden"], [404, "not_found"], [401, "sign_in"], [409, "exists"], [400, "invalid"], [413, "invalid"], [
      503,
      null
    ]] as const
  )("maps provider HTTP %s", async (status, reason) => {
    const faulty = BranchClient.of({ track: () => Effect.fail(new TrackRefused({ status })) })
    const error = await failure(
      call({
        state: state(),
        call: { _tag: "Action", key: "canonical", name: "branches/ephemeral", payload: { ref: "topic" } }
      })
        .pipe(Effect.provideService(BranchClient, faulty))
    )
    if (reason === null) expect(error).toBeInstanceOf(BranchTrackUnavailable)
    else refused(error, reason)
  })
  test("maps an unconfigured provider distinctly from an unavailable transport", async () => {
    for (const code of ["not_configured", undefined] as const) {
      const faulty = BranchClient.of({ track: () => Effect.fail(new TrackRefused(code === undefined ? {} : { code })) })
      const error = await failure(
        call({
          state: state(),
          call: { _tag: "Action", key: "canonical", name: "branches/ephemeral", payload: { ref: "topic" } }
        })
          .pipe(Effect.provideService(BranchClient, faulty))
      )
      if (code === undefined) expect(error).toBeInstanceOf(BranchTrackUnavailable)
      else refused(error, "not_configured")
    }
  })
})

test("run preserves domain refusals and sanitizes a faulty child runtime's foreign failure", async () => {
  for (
    const error of [
      new BranchTrackRefused({ reason: "forbidden" }),
      new BranchTrackUnavailable(),
      new Error("private-runtime-error")
    ]
  ) {
    const instance = FlowRuntime.FlowInstance.of({
      executionId: "caller",
      lineageId: "caller",
      flow: CreationStart,
      scope: Scope.makeUnsafe(),
      suspended: false,
      interrupted: false,
      waiting: undefined,
      handoff: undefined,
      cause: undefined,
      actionState: {
        count: 0,
        latch: Latch.makeUnsafe(),
        nextOrdinal: () => 1,
        snapshots: new Map(),
        keylessInFlight: new Set()
      }
    })
    // The deliberately faulty runtime refuses every operation. No alternate
    // graph/dispatch implementation participates in this boundary test.
    const faulty = FlowRuntime.FlowRuntime.of(
      new Proxy({}, { get: () => () => Effect.fail(error) }) as FlowRuntime.FlowRuntime["Service"]
    )
    const actual = await failure(
      run(request).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, faulty),
        Effect.provide(WebCrypto.layer)
      )
    )
    if (error instanceof BranchTrackRefused || error instanceof BranchTrackUnavailable) expect(actual).toBe(error)
    else {
      expect(actual).toBeInstanceOf(BranchTrackUnavailable)
      expect(JSON.stringify(actual)).not.toContain("private-runtime-error")
    }
    await Effect.runPromise(Scope.close(instance.scope, Exit.void))
  }
})


test("run logs a faulty child runtime's defect once at Error by its name and answers unavailable", async () => {
  const instance = FlowRuntime.FlowInstance.of({
    executionId: "caller",
    lineageId: "caller",
    flow: CreationStart,
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    actionState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: () => 1,
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  })
  // The deliberately faulty runtime dies on every operation.
  const faulty = FlowRuntime.FlowRuntime.of(
    new Proxy({}, { get: () => () => Effect.die(new TypeError("private-runtime-defect")) }) as FlowRuntime.FlowRuntime["Service"]
  )
  const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
  const logger = Logger.make(({ message, logLevel, fiber }) =>
    void lines.push({
      message: (message as ReadonlyArray<unknown>)[0],
      level: logLevel,
      annotations: fiber.getRef(References.CurrentLogAnnotations)
    })
  )
  const actual = await failure(
    run(request).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(FlowRuntime.FlowRuntime, faulty),
      Effect.provide(WebCrypto.layer),
      Effect.provide(Logger.layer([logger]))
    )
  )
  expect(actual).toBeInstanceOf(BranchTrackUnavailable)
  expect(lines).toEqual([{
    message: "branch.creation.defect",
    level: "Error",
    annotations: { feature: "branch", outcome: "defect", errorCode: "TypeError" }
  }])
  expect(JSON.stringify(lines)).not.toContain("private-runtime-defect")
  await Effect.runPromise(Scope.close(instance.scope, Exit.void))
})

describe("durable creation recovery beyond the former child deadline", () => {
  test.each(["selection", "write"] as const)("recovers %s after more than 30 seconds with one child and request identity", async (phase) => {
    const first = Deferred.makeUnsafe<void>()
    const startedAt = Date.now()
    const timing: Array<{ readonly elapsedMs: number; readonly method: string; readonly status: number }> = []
    onTestFailed(() => console.info("creation.recovery.timing", { phase, timing }))
    const requests: string[] = []
    let healthy = false
    let calls = 0
    const server = await serve((req, res) => {
      const selecting = req.method === "GET"
      const answer = () => {
        const failing = !healthy && selecting === (phase === "selection")
        timing.push({ elapsedMs: Date.now() - startedAt, method: req.method!, status: failing ? 503 : selecting ? 200 : 201 })
        if (failing) {
          calls++
          Effect.runSync(Deferred.succeed(first, undefined))
          json(503, { code: "unavailable" })(req, res)
        } else json(selecting ? 200 : 201, selecting ? selection() : made)(req, res)
      }
      if (selecting) return answer()
      let body = ""
      req.on("data", (chunk) => { body += String(chunk) })
      req.on("end", () => {
        requests.push((JSON.parse(body) as { request: string }).request)
        answer()
      })
    })
    const Retry = Action.make(`test/creation/recover-${phase}`, {
      payload: CreationRequest, success: Tracked, error: TrackFailure, retryPolicy: NEW_RETRY,
    })
    const Parent = Flow.make(`test/creation/parent-${phase}`, {
      payload: CreationRequest, success: Tracked, error: TrackFailure,
      body: Node.capture({ retry: Retry.name }, (payload) => Retry.call(payload)),
    })
    const http = FetchHttpClient.layer
    const registered = Layer.merge(registration(server.origin), Interpreter.layerWithImplementations(Parent, Retry.toLayer(run))).pipe(
      Layer.provide(BranchClient.layer({ origin: server.origin }).pipe(Layer.provide(http))),
      Layer.provide(http), Layer.provide(WebCrypto.layer), Layer.provideMerge(Action.layerImplementations),
    )
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { context, engine } = yield* build(registered)
      const runtime = Context.get(context, FlowRuntime.FlowRuntime)
      const pending = yield* Effect.forkChild(runtime.execute(Parent, { executionId: `recover-${phase}`, payload: request }).pipe(Effect.provide(context)))
      yield* Deferred.await(first)
      // A failed child is memoized by execution identity: the parent cannot restart it.
      // Recover after the former 30-second deadline, without shifting SQL ownership leases.
      yield* Effect.sleep("35 seconds")
      healthy = true
      // Await the actual durable completion within this test's existing total budget.
      // A second wall-clock polling deadline can expire while real SQL rounds are still progressing.
      expect(yield* Fiber.await(pending), JSON.stringify(timing)).toEqual(Exit.succeed(made))
      expect(yield* engine.status(`branch-creation:${request.request}`)).toBe("completed")
      expect(calls).toBeGreaterThan(0)
      expect(requests.length).toBeGreaterThan(0)
      expect(new Set(requests)).toEqual(new Set([request.request]))
    })))
  }, 90_000)
})
