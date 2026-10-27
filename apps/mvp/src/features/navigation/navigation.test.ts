// `app/navigate` (docs/features/flows.md#navigation): only this app's paths, only the tab that asked moves, and a tab
// that is gone settles the step. The step runs on the Node host's engine (worker/test/flowHost.ts) with navigation's
// real `Tabs` over Node's `BroadcastChannel`, and the tabs are the real `tabNavigation` on the same channel; then the
// whole device, as the browser builds it (src/test/device.ts), for a person's dispatch and the agent's call. Faults
// are injected: a router that throws, a stray message on the channel.
import { Action, FlowRuntime } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Layer, Logger, Metric, Option, Scope, Stream, Tracer } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { stop, testFile, usage } from "../../../worker/test/harness.ts"
import { build } from "../../../worker/test/flowHost.ts"
import { slashSubmit } from "@smthrs/ui"
import { TabRequests } from "../../flows/requests"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { answerRow, cell, openAgent } from "../../test/agent"
import { COMMANDS } from "../commands/catalog"
import { openDevice } from "../../test/device"
import { MAX_TO_LENGTH, NAVIGATE_WITHIN, NAVIGATION_TELEMETRY, navigationChannel } from "./contract"
import { Navigate, NavigationRefused, registration, Tabs } from "./flows"
import { navigations } from "./metrics"
import { appPath } from "./paths"
import { GoCall, To } from "./schema"
import { tabNavigation } from "./tab"

const ORIGIN = "http://localhost:1337"

const scopes: Array<Scope.Closeable> = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

const scoped = () => {
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  return scope
}

describe("where it may go", () => {
  test("an app path, with or without its leading slash, keeps its query and fragment", () => {
    expect(appPath("/octocat/Spoon-Knife", ORIGIN)).toEqual({ _tag: "Path", path: "/octocat/Spoon-Knife" })
    expect(appPath("octocat/Spoon-Knife", ORIGIN)).toEqual({ _tag: "Path", path: "/octocat/Spoon-Knife" })
    expect(appPath("/octocat/Spoon-Knife/blob/main/README.md?L=12#top", ORIGIN)).toEqual({
      _tag: "Path",
      path: "/octocat/Spoon-Knife/blob/main/README.md?L=12#top",
    })
  })

  test("a full URL on the app's own origin is reduced to its path; leading slashes collapse to one", () => {
    expect(appPath(`${ORIGIN}/octocat/Spoon-Knife/tree/main/src?L=3-5`, ORIGIN)).toEqual({
      _tag: "Path",
      path: "/octocat/Spoon-Knife/tree/main/src?L=3-5",
    })
    expect(appPath(ORIGIN, ORIGIN)).toEqual({ _tag: "Path", path: "/" })
    // `//example.com` would read as another host: the path is the app's own.
    expect(appPath(`${ORIGIN}//example.com/x`, ORIGIN)).toEqual({ _tag: "Path", path: "/example.com/x" })
  })

  test("another origin, however written, is refused", () => {
    for (const to of [
      "https://example.com/octocat/Spoon-Knife",
      "https://github.com/octocat/Spoon-Knife",
      "//example.com/x",
      "/\\example.com/x",
      "https://localhost:1337/x",
      "http://localhost:1338/x",
    ]) {
      expect([to, appPath(to, ORIGIN)]).toEqual([to, { _tag: "Refused", reason: "origin" }])
    }
  })

  test("another scheme is refused, and so is what isn't a URL", () => {
    for (const to of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<p>hi</p>", "mailto:a@b.c", "blob:x"]) {
      expect([to, appPath(to, ORIGIN)]).toEqual([to, { _tag: "Refused", reason: "scheme" }])
    }
    expect(appPath("http://", ORIGIN)).toEqual({ _tag: "Refused", reason: "invalid" })
    expect(appPath("http://[::1", ORIGIN)).toEqual({ _tag: "Refused", reason: "invalid" })
  })

  test("the tab call bounds a supplied path while allowing no path", () => {
    const valid = (input: { readonly path?: string }) => Exit.isSuccess(Effect.runSyncExit(GoCall.makeEffect(input)))
    expect(valid({})).toBe(true)
    expect(valid({ path: "x".repeat(MAX_TO_LENGTH) })).toBe(true)
    expect(valid({ path: "x".repeat(MAX_TO_LENGTH + 1) })).toBe(false)
  })

  test("the flow takes 1 to MAX_TO_LENGTH characters", () => {
    const valid = (to: string) => Exit.isSuccess(Effect.runSyncExit(To.makeEffect(to)))
    expect(valid("")).toBe(false)
    expect(valid("x".repeat(MAX_TO_LENGTH))).toBe(true)
    expect(valid("x".repeat(MAX_TO_LENGTH + 1))).toBe(false)
  })
})

type Recorded = {
  readonly logs: Array<ReturnType<typeof Logger.formatStructured.log>>
  readonly spans: Array<Tracer.NativeSpan>
  readonly registry: Metric.MetricRegistry
}

/**
 * `app/navigate` on the Node host's engine, asking the tabs on a navigation channel of its own and waiting `within`
 * for them; `tab` opens one of those tabs, with its own requests and router. Every record is kept.
 */
const openEngine = async (within: `${number} millis` = "2000 millis") => {
  const name = `navigation-${crypto.randomUUID()}`
  const recorded: Recorded = { logs: [], spans: [], registry: new Map() }
  // The engine runs a step with the services it was built with, so the records go where the build's did.
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([Logger.make((o) => void recorded.logs.push(Logger.formatStructured.log(o)))]),
      ),
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span: (o) => {
            const span = new Tracer.NativeSpan(o)
            recorded.spans.push(span)
            return span
          },
        }),
      ),
      Effect.provideService(Metric.MetricRegistry, recorded.registry),
    )
  const { context } = await Effect.runPromise(
    observed(
      Scope.provide(scoped())(
        build(
          registration.pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provide(Tabs.layerChannel({ name, origin: ORIGIN, within })),
            Layer.provide(TabChannel.layer),
          ),
        ),
      ),
    ),
  )
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)

  /** A tab on this engine: it moves through `navigate`, which records each path unless set. */
  const tab = async (navigate?: (path: string) => void | Promise<void>) => {
    const navigated: Array<string> = []
    const built = await Effect.runPromise(
      Scope.provide(scoped())(
        Layer.build(
          tabNavigation({ name, origin: ORIGIN, navigate: navigate ?? ((path) => void navigated.push(path)) }).pipe(
            Layer.provideMerge(TabRequests.layer()),
            Layer.provide(TabChannel.layer),
          ),
        ),
      ),
    )
    const requests = Context.get(built, TabRequests)
    return {
      navigated,
      /** This tab dispatched `executionId` through `door`, as `FlowDispatch` remembers it; answers the id. */
      started: (executionId: string, door: "button" | "slash" | "composer") => {
        Effect.runSync(requests.add(executionId, door))
        return executionId
      },
    }
  }

  /** Runs `app/navigate { to }` as `executionId`, every record kept. */
  const navigate = (executionId: string, to: string) =>
    Effect.runPromise(observed(Effect.exit(runtime.execute(Navigate, { executionId, payload: { to } }))))

  const count = (attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(navigations, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, recorded.registry),
      ),
    ).count
  const line = () => recorded.logs.findLast((log) => log.message === "web.navigate")
  const span = () => recorded.spans.findLast((candidate) => candidate.name === "web.navigate")
  return { name, tab, navigate, count, line, span, recorded }
}

describe("the tab that asked", () => {
  test("a tab's own dispatch moves that tab, and no other, recorded by its door", async () => {
    const engine = await openEngine()
    const asking = await engine.tab()
    const other = await engine.tab()
    asking.started("nav-1", "slash")

    const exit = await engine.navigate("nav-1", "octocat/Spoon-Knife")

    expect(exit).toEqual(Exit.succeed({ path: "/octocat/Spoon-Knife", moved: true }))
    expect(asking.navigated).toEqual(["/octocat/Spoon-Knife"])
    expect(other.navigated).toEqual([])
    expect(engine.count({ door: "slash", outcome: "navigated" })).toBe(1)
    expect(engine.line()).toMatchObject({
      level: "INFO",
      annotations: { door: "slash", outcome: "navigated", executionId: "nav-1" },
    })
    expect(Object.fromEntries(engine.span()!.attributes)).toMatchObject({
      "smithers.navigation.door": "slash",
      "smithers.navigation.outcome": "navigated",
    })
  })

  test("the agent's call moves the tab that asked for the answer, recorded as the agent's", async () => {
    const engine = await openEngine()
    const asking = await engine.tab()
    const other = await engine.tab()
    asking.started("answer-1", "composer")

    const exit = await engine.navigate(
      "answer-1/chat/Respond@abc:1/call/1.0",
      `${ORIGIN}/octocat/Spoon-Knife/blob/main/README.md?L=12`,
    )

    expect(exit).toEqual(Exit.succeed({ path: "/octocat/Spoon-Knife/blob/main/README.md?L=12", moved: true }))
    expect(asking.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/README.md?L=12"])
    expect(other.navigated).toEqual([])
    expect(engine.count({ door: "agent", outcome: "navigated" })).toBe(1)
  })

  test("a tab that is gone settles the step without moving any other tab", async () => {
    const engine = await openEngine("100 millis")
    const other = await engine.tab()

    // A tab's own dispatch whose tab closed, and the agent's call for an answer whose tab closed.
    expect(await engine.navigate("nav-gone", "/octocat/Spoon-Knife")).toEqual(
      Exit.succeed({ path: "/octocat/Spoon-Knife", moved: false }),
    )
    expect(await engine.navigate("answer-gone/chat/Respond@abc:1/call/1.0", "/octocat")).toEqual(
      Exit.succeed({ path: "/octocat", moved: false }),
    )

    expect(other.navigated).toEqual([])
    expect(engine.count({ door: "unknown", outcome: "gone" })).toBe(1)
    expect(engine.count({ door: "agent", outcome: "gone" })).toBe(1)
    expect(engine.recorded.logs.filter((log) => log.message === "web.navigate")).toEqual([
      expect.objectContaining({ level: "INFO", annotations: expect.objectContaining({ door: "unknown", outcome: "gone" }) }),
      expect.objectContaining({ level: "INFO", annotations: expect.objectContaining({ door: "agent", outcome: "gone" }) }),
    ])
  })

  test("an asynchronous router must complete before moved is true", async () => {
    const engine = await openEngine()
    let enter!: () => void
    let complete!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const completion = new Promise<void>((resolve) => { complete = resolve })
    const asking = await engine.tab(() => { enter(); return completion })
    asking.started("nav-async", "button")
    let settled = false
    const result = engine.navigate("nav-async", "/octocat").then((exit) => { settled = true; return exit })
    await entered
    try {
      // A second request completes over the same channel while this router is still pending.
      const other = await engine.tab()
      other.started("nav-barrier", "slash")
      expect(await engine.navigate("nav-barrier", "/")).toEqual(Exit.succeed({ path: "/", moved: true }))
      expect(settled).toBe(false)
    } finally {
      complete()
    }
    expect(await result).toEqual(Exit.succeed({ path: "/octocat", moved: true }))
    expect(engine.count({ door: "button", outcome: "navigated" })).toBe(1)
  })

  test("an asynchronous router failure answers false and records failure", async () => {
    const engine = await openEngine()
    const asking = await engine.tab(() => {
      const failed = Promise.reject(new Error("the router failed asynchronously"))
      void failed.catch(() => {}) // Keep the old implementation's discarded rejection from escaping the test.
      return failed
    })
    asking.started("nav-rejected", "button")
    expect(await engine.navigate("nav-rejected", "/octocat")).toEqual(Exit.succeed({ path: "/octocat", moved: false }))
    expect(engine.count({ door: "button", outcome: "failed" })).toBe(1)
    expect(engine.line()).toMatchObject({ level: "ERROR", annotations: { outcome: "failed" } })
  })

  test("a router that throws leaves the tab where it was, and the step answers it didn't move", async () => {
    const engine = await openEngine()
    const asking = await engine.tab(() => {
      throw new Error("the router failed")
    })
    asking.started("nav-1", "button")

    expect(await engine.navigate("nav-1", "/octocat")).toEqual(Exit.succeed({ path: "/octocat", moved: false }))
    expect(engine.count({ door: "button", outcome: "failed" })).toBe(1)
    expect(engine.line()).toMatchObject({ level: "ERROR", annotations: { outcome: "failed" } })
  })
})

describe("refusals", () => {
  test("another site, another scheme or no URL fails NavigationRefused, and the tab stays", async () => {
    const engine = await openEngine()
    const asking = await engine.tab()
    asking.started("answer-1", "composer")

    for (
      const [index, [to, reason]] of ([
        ["https://example.com/phish", "origin"],
        ["javascript:alert(document.cookie)", "scheme"],
        ["data:text/html,<script>alert(1)</script>", "scheme"],
        ["http://", "invalid"],
      ] as const).entries()
    ) {
      const id = asking.started(`nav-${index}`, "slash")
      expect(await engine.navigate(id, to)).toEqual(Exit.fail(new NavigationRefused({ reason })))
    }
    expect(await engine.navigate("answer-1/chat/Respond@abc:1/call/1.0", "https://example.com")).toEqual(
      Exit.fail(new NavigationRefused({ reason: "origin" })),
    )

    expect(asking.navigated).toEqual([])
    expect(engine.count({ door: "slash", outcome: "refused" })).toBe(4)
    expect(engine.count({ door: "agent", outcome: "refused" })).toBe(1)
    expect(engine.line()).toMatchObject({ level: "WARN", annotations: { outcome: "refused", reason: "origin" } })
  })

  test("the tab checks a path once more before it moves, and ignores what isn't a call", async () => {
    const engine = await openEngine()
    const asking = await engine.tab()
    asking.started("nav-1", "button")

    // Something else on the channel asks this tab to leave the app.
    const reply = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* (yield* TabChannel.TabChannel).open(navigationChannel(engine.name))
          const replies = yield* port.subscribe
          yield* port.post({ kind: "something else" })
          yield* port.post({ kind: "smithers/asking-tab", id: "odd", requester: "nav-1", input: { path: 7 } })
          yield* port.post({
            kind: "smithers/asking-tab",
            id: "rogue",
            requester: "nav-1",
            input: { path: "https://example.com" },
          })
          return yield* Stream.fromQueue(replies).pipe(
            Stream.filter((message) => (message as { kind?: string }).kind === "smithers/asking-tab-reply"),
            Stream.runHead,
          )
        }),
      ).pipe(Effect.provide(TabChannel.layer)),
    )

    expect(reply).toEqual(
      Option.some({ kind: "smithers/asking-tab-reply", id: "rogue", door: "button", output: { moved: false } }),
    )
    expect(asking.navigated).toEqual([])
  })
})

describe("records", () => {
  test("carry the door and the outcome, never the path", async () => {
    const engine = await openEngine()
    const asking = await engine.tab()
    const sentinel = "sentinel-7f3a9c"

    await engine.navigate(asking.started("nav-1", "slash"), `/octocat/${sentinel}?L=1#${sentinel}`)
    await engine.navigate(asking.started("nav-2", "slash"), `https://${sentinel}.example.com/`)

    expect(asking.navigated).toEqual([`/octocat/${sentinel}?L=1#${sentinel}`])
    const logs = engine.recorded.logs.filter((log) => log.message === "web.navigate")
    expect(logs).toHaveLength(2)
    expect(JSON.stringify(logs)).not.toContain(sentinel)
    const spans = engine.recorded.spans.filter((span) => span.name === "web.navigate")
    expect(spans).toHaveLength(2)
    expect(JSON.stringify(spans.map((span) => Object.fromEntries(span.attributes)))).not.toContain(sentinel)
    // ChatApi's relay keeps every field a line carries.
    for (const log of logs) {
      for (const field of Object.keys(log.annotations)) expect(BROWSER_TELEMETRY.fields).toContain(field)
    }
    expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...NAVIGATION_TELEMETRY.records]))
    expect(NAVIGATE_WITHIN).toBe("5 seconds")
  })
})

describe("a person's door", () => {
  test("`/navigate <path>` runs app/navigate with the path, for anyone, its row the short slash description", () => {
    const command = COMMANDS.find(({ flow }) => flow === "app/navigate")
    expect(command).toMatchObject({ name: "navigate", minimum: "anyone", description: "Go to a page" })
    expect(slashSubmit("/navigate /octocat/Spoon-Knife/blob/main/README.md?L=12", COMMANDS)).toEqual({
      kind: "run",
      command,
      payload: { to: "/octocat/Spoon-Knife/blob/main/README.md?L=12" },
    })
    expect(slashSubmit("/navigate", COMMANDS)).toEqual({ kind: "missing", command, fields: ["to"] })
  })
})

describe("on the device, as the browser builds it", () => {
  const runtime = testFile("navigation")
  // Three model rounds on a real engine leader: about 3 seconds alone, past 30 under a full suite's load.
  const AGENT_WITHIN = 90_000

  test("a person's dispatch runs on the leader's engine and moves only the tab that dispatched it", async () => {
    const agent = await openAgent(runtime, () => Stream.empty)
    const device = await openDevice(agent.fetch)
    closers.push(device.close)
    const second = await device.openTab()

    const first = await Effect.runPromise(
      device.dispatch.dispatch("app/navigate", { to: "/octocat/Spoon-Knife" }, { door: "slash" }),
    )
    // The second tab's worker never leads: its dispatch runs on the first tab's engine, and still moves only it.
    const other = await Effect.runPromise(
      second.dispatch.dispatch("app/navigate", { to: "/octocat/Spoon-Knife/tree/main" }, { door: "button" }),
    )
    const refused = await Effect.runPromise(
      device.dispatch.dispatch("app/navigate", { to: "javascript:alert(1)" }, { door: "slash" }),
    )

    expect(first).toEqual({ _tag: "Done", value: { path: "/octocat/Spoon-Knife", moved: true } })
    expect(other).toEqual({ _tag: "Done", value: { path: "/octocat/Spoon-Knife/tree/main", moved: true } })
    expect(refused).toEqual({ _tag: "Failed", error: new NavigationRefused({ reason: "scheme" }) })
    expect(device.navigated).toEqual(["/octocat/Spoon-Knife"])
    expect(second.navigated).toEqual(["/octocat/Spoon-Knife/tree/main"])
  })

  test("the agent's call moves the tab whose composer asked, and no other", async () => {
    let calls = 0
    const agent = await openAgent(runtime, () => {
      calls++
      const source = calls === 1
        ? `await ctx.call("app/navigate", { to: "octocat/Spoon-Knife" })`
        : calls === 2
        ? `await ctx.call("app/navigate", { to: "https://example.com/phish" })`
        : `ctx.done("Opened octocat/Spoon-Knife.")`
      return Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)
    })
    const device = await openDevice(agent.fetch)
    closers.push(device.close)
    const second = await device.openTab()
    const answerId = await agent.ask("Open octocat/Spoon-Knife, then example.com")

    const exit = await Effect.runPromise(
      device.dispatch.dispatch("chat/Answer", { answerId }, { door: "composer", executionId: answerId }),
    )

    expect(exit).toEqual({ _tag: "Done", value: { status: "done" } })
    expect(device.navigated).toEqual(["/octocat/Spoon-Knife"])
    expect(second.navigated).toEqual([])
    const answer = await answerRow(runtime, answerId)
    expect(answer).toMatchObject({ status: "done", text: "Opened octocat/Spoon-Knife." })
    expect(answer?.parts).toEqual([
      expect.objectContaining({ kind: "step", flow: "app/navigate", status: "done" }),
      expect.objectContaining({ kind: "step", flow: "app/navigate", status: "failed" }),
    ])
  }, AGENT_WITHIN)
})
