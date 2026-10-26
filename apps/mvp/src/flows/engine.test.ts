// This device's engine as the browser builds it (src/test/device.ts): a tab dispatches through `BrowserEngine` to the
// leader's engine worker, which runs every client flow and reaches the tab's collections through the tab port. A
// person's button and the agent's cell both switch the theme through the one declaration, `app/theme/set`. The tab's
// side splits in two: `tabEngine` starts the worker needing nothing of the tab, and `tabAnswers` answers it once the
// tab's store is open.
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine, TabChannel } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Fiber, Layer, Logger, ManagedRuntime, Option, References, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test, vi } from "vitest"
import { stop, testFile, usage } from "../../worker/test/harness.ts"
import { Answer } from "../features/agent/flows"
import { sessionChannel } from "../features/auth/contract"
import { REFRESH_RETRY } from "../features/auth/flows"
import { SessionCall } from "../features/auth/schema"
import { answerAskingTab } from "./askingTab"
import type { ThemeMode } from "../features/theme/contract"
import { WriteTheme } from "../features/theme/flows"
import { ThemeStore } from "../features/theme/store"
import { answerRow, cell, openAgent } from "../test/agent"
import { openDevice } from "../test/device"
import { EngineFailed, engineRequests, failFastOnEngine, tabAnswers, tabEngine, TabWorker } from "./engine"
import { ClientEngine } from "./dispatch"
import { AnswerReference } from "../features/agent/reference"
import { type Endpoint, TabCallFailed, TabPort } from "./tabPort"

const runtime = testFile("device")

const devices: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const device of devices.splice(0)) await device.close()
})

describe("the device's engine", () => {
  test("a person's button sets the theme through the leader's engine and the tab port, and the tab paints it", async () => {
    const agent = await openAgent(runtime, () => Stream.empty)
    const device = await openDevice(agent.fetch)
    devices.push(device)

    await device.theme.actions.toggle()
    const second = await Effect.runPromise(
      device.dispatch.dispatch("app/theme/set", { mode: "light" }, { door: "slash" }),
    )

    expect(device.painted).toEqual(["dark", "light"])
    expect(second).toEqual({ _tag: "Done", value: { mode: "light" } })
    expect(await Effect.runPromise(device.store.current)).toBe("light")
  })

  test("the tab says which door its press came through, so a person-only press goes in the person's session", async () => {
    const agent = await openAgent(runtime, () => Stream.empty)
    const device = await openDevice(agent.fetch)
    devices.push(device)

    // Answering a run that doesn't exist reaches ChatApi as the person and reads `404`; as anyone acting for them, the
    // server refuses it `403 person_only` before it looks for the run.
    const answered = await Effect.runPromise(device.dispatch.dispatch(
      "run/answer",
      { runId: crypto.randomUUID(), version: 1, execution: "none", value: true },
      { door: "button" },
    ))

    expect(answered).toMatchObject({ _tag: "Failed", error: { _tag: "@smthrs/mvp/status/AnswerRefused", status: 404 } })
  })

  test("the agent answers on the leader's engine, and its theme call paints this tab", async () => {
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      const source = calls === 1
        ? `await ctx.call("app/theme/set", { mode: "dark" })`
        : `ctx.done("Dark mode is on.")`
      return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
    })
    const device = await openDevice(agent.fetch)
    devices.push(device)
    const answerId = await agent.ask("Switch to dark mode")

    await Effect.runPromise(device.engine.start(Answer, { executionId: answerId, payload: { answerId } }))
    const exit = await Effect.runPromise(device.engine.result(Answer, answerId))

    expect(exit).toEqual(Exit.succeed({ status: "done" }))
    expect(device.painted).toEqual(["dark"])
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "done", text: "Dark mode is on." })
  })

  test("a session refresh waiting out its backoff holds up no other flow on the leader's engine", async () => {
    const agent = await openAgent(runtime, () => Stream.empty)
    const device = await openDevice(agent.fetch)
    devices.push(device)
    // The tab's side of auth/refresh, on a ChatApi that never says who is signed in: the engine asks again and again.
    const asked: Array<number> = []
    const scope = Effect.runSync(Scope.make())
    await device.run(
      Scope.provide(scope)(
        answerAskingTab({
          channel: sessionChannel(device.name),
          input: SessionCall,
          answer: () => Effect.sync(() => (asked.push(Date.now()), { outcome: "unreachable" as const })),
        }),
      ).pipe(Effect.provide(TabChannel.layer)),
    )
    try {
      const refreshing = Effect.runFork(device.dispatch.dispatch("auth/refresh", {}, { door: "sync" }))
      await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 20 })
      // The refresh is between attempts, its run still open: another flow starts and ends at once.
      const startedAt = Date.now()
      const set = await Effect.runPromise(device.dispatch.dispatch("app/theme/set", { mode: "dark" }, { door: "button" }))
      expect(set).toEqual({ _tag: "Done", value: { mode: "dark" } })
      expect(Date.now() - startedAt).toBeLessThan(REFRESH_RETRY.initialMs * 2)
      expect(device.painted).toEqual(["dark"])
      expect(refreshing.pollUnsafe()).toBeUndefined()
      await Effect.runPromise(Fiber.interrupt(refreshing))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }, 30_000)
})

describe("the tab's side", () => {
  test("tabEngine starts the worker needing nothing of the tab; tabAnswers answers it only while attached", async () => {
    const channel = new MessageChannel()
    channel.port1.start()
    channel.port2.start()
    const terminated: Array<boolean> = []
    const worker = {
      postMessage: (message: unknown) => channel.port2.postMessage(message),
      addEventListener: (type: string, listener: (event: never) => void) =>
        type === "message" && channel.port2.addEventListener("message", listener as never),
      removeEventListener: (type: string, listener: (event: never) => void) =>
        type === "message" && channel.port2.removeEventListener("message", listener as never),
      terminate: () => void terminated.push(true),
    } as unknown as BrowserEngine.WorkerLike & Endpoint
    const engineScope = Effect.runSync(Scope.make())
    const engine = await Effect.runPromise(
      Scope.provide(engineScope)(Layer.build(tabEngine(() => worker, `smithers-${crypto.randomUUID()}`))),
    )
    // The worker's end of the line, waiting briefly for each answer.
    const port = ManagedRuntime.make(TabPort.layer(channel.port1, "200 millis"))
    const write = (mode: ThemeMode) =>
      port.runPromise(Effect.exit(Effect.flatMap(TabPort, (tab) => tab.call(WriteTheme.name, { mode }))))
    const unanswered = Exit.fail(new TabCallFailed({ method: WriteTheme.name, reason: "timeout" }))

    expect(Context.get(engine, TabWorker)).toBe(worker)
    expect(await write("dark")).toEqual(unanswered)

    const painted: Array<ThemeMode | undefined> = []
    const store = ThemeStore.layer({
      paint: (mode) => void painted.push(mode),
      mirror: () => {},
      system: () => "light",
      painted: () => painted.at(-1),
    })
      .pipe(Layer.provide(Persistence.memory))
    const answersScope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.provide(answersScope)(
        Layer.build(tabAnswers.pipe(Layer.provide(store), Layer.provide(Layer.succeedContext(engine)))),
      ),
    )

    expect(await write("dark")).toEqual(Exit.succeed(null))
    await vi.waitFor(() => expect(painted).toEqual(["dark"]))

    await Effect.runPromise(Scope.close(answersScope, Exit.void))
    expect(await write("light")).toEqual(unanswered)

    await port.dispose()
    await Effect.runPromise(Scope.close(engineScope, Exit.void))
    expect(terminated).toEqual([true])
    channel.port1.close()
    channel.port2.close()
  })
})

describe("an engine worker that fails", () => {
  /** A worker whose `fail` reports an error it didn't catch, as one whose module can't load does. */
  const failing = () => {
    const listeners: Array<(event: ErrorEvent) => void> = []
    const worker = {
      postMessage: () => {},
      addEventListener: (type: string, listener: (event: ErrorEvent) => void) =>
        void (type === "error" && listeners.push(listener)),
      removeEventListener: () => {},
      terminate: () => {},
    } as unknown as BrowserEngine.WorkerLike & Endpoint
    return { worker, fail: () => listeners.forEach((listener) => listener({ error: new ReferenceError("x") } as ErrorEvent)) }
  }

  test("the tab's engine is unavailable, and a dispatch to it fails `unavailable` instead of waiting for a leader", async () => {
    const { worker, fail } = failing()
    const runtime = ManagedRuntime.make(tabEngine(() => worker, `smithers-${crypto.randomUUID()}`))
    const engine = await runtime.runPromise(Effect.service(BrowserEngine.BrowserEngine))
    const unavailable = runtime.runPromise(engine.unavailable)
    const dispatched = runtime.runPromise(
      Effect.flip(
        Effect.flatMap(Effect.service(ClientEngine), (client) =>
          client.start(AnswerReference, { executionId: crypto.randomUUID(), payload: { answerId: crypto.randomUUID() } })),
      ),
    )

    fail()
    expect(await unavailable).toMatchObject({ reason: "worker-failed" })
    expect(await dispatched).toMatchObject({ _tag: "@smthrs/mvp/flows/DispatchFailed", reason: "unavailable" })
    await runtime.dispose()
  })

  test("the device store's open fails at once instead of waiting for a leader; a healthy worker's opens as given", async () => {
    const { worker, fail } = failing()
    const runtime = ManagedRuntime.make(tabEngine(() => worker, `smithers-${crypto.randomUUID()}`))
    const database = { close: () => {} }
    const options = (open: () => Promise<typeof database>) => ({ open, make: () => ({}) as never })

    // Healthy: `open` is the host's.
    const healthy = await runtime.runPromise(Effect.scoped(failFastOnEngine(options(() => Promise.resolve(database)))))
    expect(await healthy.open()).toBe(database)

    // A leader that never answers: once the worker fails, `open` fails with `EngineFailed`.
    const scope = Effect.runSync(Scope.make())
    const waiting = await runtime.runPromise(Scope.provide(scope)(failFastOnEngine(options(() => new Promise(() => {})))))
    const opened = Promise.resolve(waiting.open())
    fail()
    await expect(opened).rejects.toBeInstanceOf(EngineFailed)

    // `Persistence.layer` keeps the rows in memory then.
    const persistence = await runtime.runPromise(
      Effect.scoped(
        Effect.flatMap(failFastOnEngine(options(() => new Promise(() => {}))), (open) =>
          Effect.map(Layer.build(Persistence.layer(open)), (context) => Context.get(context, Persistence.Persistence))),
      ),
    )
    expect(persistence.persistence).toEqual(Option.none())
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await runtime.dispose()
  })
})

describe("the engine worker's requests", () => {
  test("a failed request to the app's own /api/ is logged by its route template; another origin's isn't", async () => {
    const lines: Array<{ readonly message: unknown; readonly annotations: unknown }> = []
    const logger = Logger.make(({ message, fiber }) =>
      void lines.push({ message: (message as ReadonlyArray<unknown>)[0], annotations: fiber.getRef(References.CurrentLogAnnotations) })
    )
    // The provider is down: the deployment's model endpoint answers 503, and another origin refuses too.
    const down: typeof globalThis.fetch = async () => new Response(null, { status: 503 })
    await Effect.runPromise(Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch
      yield* Effect.promise(() => fetch("https://chat.test/api/model/agent", { method: "POST" }))
      yield* Effect.promise(() => fetch("https://elsewhere.test/api/model/agent"))
    }).pipe(
      Effect.provide(engineRequests("https://chat.test")),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(FetchHttpClient.Fetch, down),
    ))
    expect(lines).toEqual([{
      message: "http.request.failed",
      annotations: { route: "/api/model/:id", method: "POST", status: 503, statusClass: "5xx", retried: false, failures: 1 },
    }])
  })
})
