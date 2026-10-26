// The engine worker's line to its tab (src/flows/tabPort.ts), over a real `MessageChannel`: one port is the worker's
// global scope, the other the tab's `Worker`.
import { Deferred, Effect, Exit, Layer, Logger, ManagedRuntime, References, Scope, type Schema } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { answer, type Endpoint, type Handlers, TabCallFailed, TabPort } from "./tabPort"

const channels: Array<MessageChannel> = []
const scopes: Array<Scope.Closeable> = []
const runtimes: Array<ManagedRuntime.ManagedRuntime<TabPort, never>> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

/** A worker and its tab on one channel; the tab answers with `handlers` unless `answered` is false. */
const open = async (
  handlers: Handlers,
  options: {
    readonly within?: number
    readonly answered?: boolean
    /** Records what the tab's side logs. */
    readonly lines?: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }>
  } = {},
) => {
  const channel = new MessageChannel()
  channels.push(channel)
  channel.port1.start()
  channel.port2.start()
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const lines = options.lines
  const logged = lines === undefined ? Layer.empty : Logger.layer([Logger.make(({ message, logLevel, fiber }) =>
    void lines.push({ message: (message as ReadonlyArray<unknown>)[0], level: logLevel, annotations: fiber.getRef(References.CurrentLogAnnotations) })
  )])
  const stop = options.answered === false
    ? () => {}
    : await Effect.runPromise(answer(channel.port2, handlers).pipe(Scope.provide(scope), Effect.provide(logged)))
  const runtime = ManagedRuntime.make(TabPort.layer(channel.port1, options.within ?? 2_000))
  runtimes.push(runtime)
  const call = (method: string, input: Schema.Json) =>
    runtime.runPromise(Effect.exit(Effect.flatMap(TabPort, (port) => port.call(method, input))))
  return { channel, call, stop, scope }
}

describe("TabPort", () => {
  test("calls the tab's handler with its input and answers with its output", async () => {
    const seen: Array<Schema.Json> = []
    const port = await open({ "app/echo": (input) => Effect.sync(() => (seen.push(input), { echoed: input })) })

    const exit = await port.call("app/echo", { mode: "dark" })

    expect(exit).toEqual(Exit.succeed({ echoed: { mode: "dark" } }))
    expect(seen).toEqual([{ mode: "dark" }])
  })

  test("a handler's failure is refused by that alone, a method the tab lacks is unknown, and silence times out", async () => {
    const port = await open({ "app/fail": () => Effect.fail(new Error("the tab's own words")) })
    const silent = await open({}, { answered: false, within: 50 })

    expect(await port.call("app/fail", null)).toEqual(
      Exit.fail(new TabCallFailed({ method: "app/fail", reason: "refused" })),
    )
    expect(await port.call("app/missing", null)).toEqual(
      Exit.fail(new TabCallFailed({ method: "app/missing", reason: "unknown_method" })),
    )
    expect(await silent.call("app/echo", null)).toEqual(
      Exit.fail(new TabCallFailed({ method: "app/echo", reason: "timeout" })),
    )
  })

  test("the tab logs each refusal once by its code, never its message: Warn for a failure or a missing method, Error for a defect", async () => {
    const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
    const port = await open({
      "app/fail": () => Effect.fail(new RangeError("the tab's own words")),
      "app/die": () => Effect.die(new TypeError("the tab's own words")),
      "app/echo": (input) => Effect.succeed(input),
    }, { lines, within: 200 })

    expect(await port.call("app/fail", null)).toEqual(Exit.fail(new TabCallFailed({ method: "app/fail", reason: "refused" })))
    expect(await port.call("app/missing", null)).toEqual(
      Exit.fail(new TabCallFailed({ method: "app/missing", reason: "unknown_method" })),
    )
    // A defect leaves the call unanswered, so the worker's side times out, as before.
    expect(await port.call("app/die", null)).toEqual(Exit.fail(new TabCallFailed({ method: "app/die", reason: "timeout" })))
    expect(await port.call("app/echo", 1)).toEqual(Exit.succeed(1))
    await vi.waitFor(() => expect(lines).toHaveLength(3))
    expect(lines).toEqual([
      { message: "flow.tab.answer", level: "Warn", annotations: { feature: "flows", method: "app/fail", outcome: "refused", errorCode: "RangeError" } },
      { message: "flow.tab.answer", level: "Warn", annotations: { feature: "flows", method: "app/missing", outcome: "unknown_method", errorCode: "unknown_method" } },
      { message: "flow.tab.answer", level: "Error", annotations: { feature: "flows", method: "app/die", outcome: "defect", errorCode: "TypeError" } },
    ])
    expect(JSON.stringify(lines)).not.toContain("the tab's own words")
  })

  test("a handler's null answer arrives as null, and the tab stops answering once stopped", async () => {
    const port = await open({ "app/set": () => Effect.succeed(null) }, { within: 50 })

    const answered = await port.call("app/set", null)
    port.stop()
    const unanswered = await port.call("app/set", null)

    expect(answered).toEqual(Exit.succeed(null))
    expect(unanswered).toEqual(Exit.fail(new TabCallFailed({ method: "app/set", reason: "timeout" })))
  })

  test("ignores messages that aren't calls or replies, and replies nobody waits for", async () => {
    const port = await open({ "app/set": () => Effect.succeed(null) })
    port.channel.port2.postMessage({ kind: "smithers/tab-reply", id: "nobody", ok: true })
    port.channel.port2.postMessage("noise")
    port.channel.port1.postMessage({ kind: "something else" })

    expect(await port.call("app/set", null)).toEqual(Exit.succeed(null))
  })
})


test.each(["stop", "scope", "timeout"])("%s interrupts an in-flight handler and prevents its late reply", async (how) => {
  const started = Effect.runSync(Deferred.make<void>())
  const finished = Effect.runSync(Deferred.make<void>())
  const replies: unknown[] = []
  const port = await open({ slow: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))) }, { within: 100 })
  port.channel.port1.addEventListener("message", (event) => { replies.push(event.data) })
  const call = port.call("slow", null)
  await Effect.runPromise(Deferred.await(started))
  if (how === "stop") port.stop()
  if (how === "scope") await Effect.runPromise(Scope.close(port.scope, Exit.void))
  expect(await call).toEqual(Exit.fail(new TabCallFailed({ method: "slow", reason: "timeout" })))
  await vi.waitFor(() => expect(Effect.runSync(Deferred.isDone(finished))).toBe(true))
  expect(replies).toEqual([])
})

test.each(["toString", "__proto__"])("inherited %s is an unknown method", async (method) => {
  const port = await open({}, { within: 100 })
  expect(await port.call(method, null)).toEqual(Exit.fail(new TabCallFailed({ method, reason: "unknown_method" })))
})

test("a throwing transport removes its waiting entry before a late reply arrives", async () => {
  let listener!: (event: MessageEvent) => void
  let id = ""
  const endpoint: Endpoint = {
    postMessage: (message) => { id = (message as { id: string }).id; throw new Error("transport closed") },
    addEventListener: (_, received) => { listener = received },
    removeEventListener: () => {},
  }
  const runtime = ManagedRuntime.make(TabPort.layer(endpoint))
  runtimes.push(runtime)
  const exit = await runtime.runPromise(Effect.exit(Effect.flatMap(TabPort, (port) => port.call("echo", null))))
  expect(Exit.isFailure(exit)).toBe(true)
  let reads = 0
  const reply = { kind: "smithers/tab-reply", id, ok: true, output: null }
  listener({ get data() { reads++; return reply } } as MessageEvent)
  // Validation and lookup read it; an abandoned Deferred must never receive it.
  expect(reads).toBe(2)
})

test("a handler stopping its listener drops its reply and any already queued call", async () => {
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  let listener!: (event: MessageEvent) => void
  const replies: unknown[] = []
  let stopped = false
  let stop!: () => void
  const endpoint: Endpoint = {
    postMessage: (reply) => { replies.push(reply) },
    addEventListener: (_, receive) => { listener = receive },
    removeEventListener: () => {},
  }
  stop = await Effect.runPromise(answer(endpoint, { stop: () => Effect.sync(() => { stop(); stopped = true; return null }) }).pipe(Scope.provide(scope)))
  listener({ data: { kind: "smithers/tab-call", id: "first", method: "stop", input: null } } as MessageEvent)
  await vi.waitFor(() => expect(stopped).toBe(true))
  listener({ data: { kind: "smithers/tab-call", id: "queued", method: "stop", input: null } } as MessageEvent)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(replies).toEqual([])
})
