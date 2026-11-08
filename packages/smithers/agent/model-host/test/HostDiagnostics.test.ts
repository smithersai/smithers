import { Model, type ModelEvent } from "@smthrs/model"
import type { AgentTurnJournal, NativeAgent } from "@smthrs/rpc"
import { Duration, Effect, Fiber, Stream } from "effect"
import { describe, expect, test, vi } from "vitest"
import { inertCallbackTransport } from "../src/CallbackTransport.ts"
import type { CallbackTransportObserver } from "../src/CallbackTransport.ts"
import { HOST_DIAGNOSTIC_MARKER } from "../src/HostDiagnostics.vibe"
import { createHostDiagnostics } from "./diagnostics.ts"
import { DurableChatProducer, runDurableChatTurn } from "./fixtures/durable.ts"
import { runModelTurn } from "./fixtures/durable.ts"

/** Collects the record lines one recorder writes. */
const collector = () => {
  const lines: Array<Record<string, unknown>> = []
  return {
    lines,
    write: (line: string) => {
      expect(line.endsWith("\n")).toBe(true)
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
    phase: (event: string, phase: string) => lines.filter((line) => line.event === event && line.phase === phase)
  }
}

/** Waits, on real timers, for the recorder to write a matching record. */
const waitFor = async (
  find: () => ReadonlyArray<Record<string, unknown>>,
  count = 1
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  await vi.waitFor(() => expect(find().length).toBeGreaterThanOrEqual(count))
  return find()
}

describe("createHostDiagnostics", () => {
  test("names the turn and keeps only bounded, non-textual fields", () => {
    const sink = collector()
    const diagnostics = createHostDiagnostics({ turnId: "7e5fc00f-8f6b-47ca", write: sink.write, clock: () => 25 })
    diagnostics.record("model_stream", "first_event", {
      kind: "text-delta",
      events: 3,
      settled: false,
      // Every one of these must be refused: a recorder is not a channel for
      // prompt text, a destination, a header or a credential.
      prompt: "the user asked about their invoice",
      destination: "https://api.cerebras.ai/v1/chat/completions",
      authorization: "Bearer sk-secret-value",
      ratio: Number.NaN,
      "bad key": 1
    })
    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).toEqual({
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      turnId: "7e5fc00f-8f6b-47ca",
      event: "model_stream",
      phase: "first_event",
      atMillis: 0,
      kind: "text-delta",
      events: 3,
      settled: false,
      droppedFields: 5
    })
  })

  test("reports an unfinished operation while it is still unfinished", async () => {
    const sink = collector()
    let now = 0
    const diagnostics = createHostDiagnostics({ write: sink.write, clock: () => now, pendingMillis: 1_000 })
    vi.useFakeTimers()
    try {
      const settle = Effect.runSync(diagnostics.begin("chat_callback", { step: "commit", batch: 1 }))
      now = 1_000
      await vi.advanceTimersByTimeAsync(1_000)
      now = 2_000
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sink.phase("chat_callback", "pending").map((line) => line.pendingMillis)).toEqual([1_000, 2_000])
      now = 2_500
      settle({ status: 200 })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sink.phase("chat_callback", "pending")).toHaveLength(2)
      expect(sink.phase("chat_callback", "end")[0]).toMatchObject({
        step: "commit",
        batch: 1,
        status: 200,
        elapsedMillis: 2_500
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test("past the detail limit only a slow or pending operation is recorded", () => {
    const sink = collector()
    let now = 0
    const diagnostics = createHostDiagnostics({
      write: sink.write,
      clock: () => now,
      detailLimit: 1,
      slowMillis: 100
    })
    Effect.runSync(diagnostics.begin("chat_callback", { batch: 1 }))()
    const quiet = Effect.runSync(diagnostics.begin("chat_callback", { batch: 2 }))
    now = 10
    quiet()
    const slow = Effect.runSync(diagnostics.begin("chat_callback", { batch: 3 }))
    now = 500
    slow()
    expect(sink.lines.map((line) => [line.phase, line.batch])).toEqual([
      ["begin", 1],
      ["end", 1],
      ["end", 3]
    ])
  })

  test("stops at its own bound and says that it stopped", () => {
    const sink = collector()
    const diagnostics = createHostDiagnostics({ write: sink.write, clock: () => 0, limit: 3 })
    for (let index = 0; index < 10; index += 1) diagnostics.record("model_stream", "pending", { index })
    expect(sink.lines).toHaveLength(3)
    expect(sink.lines[2]).toEqual({
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      event: "diagnostics",
      phase: "capped"
    })
  })

  test("is inert without a sink: it writes nothing, starts no timer and reads no clock", () => {
    // The package never writes to a console or stream on its own; records
    // reach only the sink the host composition passes.
    const consoleError = vi.spyOn(globalThis.console, "error")
    const clock = vi.fn(() => 0)
    vi.useFakeTimers()
    try {
      const diagnostics = createHostDiagnostics({ turnId: "turn", clock, pendingMillis: 1 })
      diagnostics.record("model_stream", "first_event", { kind: "text-delta" })
      const settle = Effect.runSync(diagnostics.begin("chat_callback", { step: "commit" }))
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(10)
      settle({ status: 200 })
      createHostDiagnostics().record("host_runtime", "start")
      expect(clock).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      consoleError.mockRestore()
    }
  })
})

const turn: NativeAgent.StartAgentTurnRequest = {
  runId: "run",
  instructions: "answer",
  messages: [{ role: "user", content: "hi" }]
}

describe("stream consumption diagnostics", () => {
  test("counts what the host took off the provider stream", async () => {
    const sink = collector()
    const events: Array<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "a", text: "four" },
      { type: "thinking-delta", id: "a", text: "think" },
      { type: "settle", stopReason: "stop" }
    ]
    await Effect.runPromise(runModelTurn(
      Model.make({ stream: () => Stream.fromIterable(events) }),
      turn,
      { modelId: "model" },
      () => Effect.void,
      undefined,
      createHostDiagnostics({ write: sink.write })
    ))
    expect(sink.phase("model_stream", "first_event")[0]).toMatchObject({ kind: "text-delta" })
    expect(sink.phase("model_stream", "end")[0]).toMatchObject({ events: 3, characters: 9, settled: true })
  })

  // The production boundary this investigation could not read: the model proxy
  // completed its upstream response, and the guest consumed no event from it.
  // The record must show that while the turn is still stuck, naming zero
  // events, rather than leaving the turn silent until somebody cancels it.
  test("reports a provider stream the host consumed nothing from", async () => {
    const sink = collector()
    const fiber = Effect.runFork(runModelTurn(
      Model.make({ stream: () => Stream.never }),
      turn,
      { modelId: "model" },
      () => Effect.void,
      undefined,
      createHostDiagnostics({ write: sink.write, pendingMillis: 20 })
    ))
    const pending = await waitFor(() => sink.phase("model_stream", "pending"), 2)
    expect(sink.phase("model_stream", "first_event")).toHaveLength(0)
    expect(pending[0]?.pendingMillis).toBeTypeOf("number")
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(sink.phase("model_stream", "end")[0]).toMatchObject({ events: 0, characters: 0, settled: false })
  })
})

const cursor: AgentTurnJournal.AgentTurnCursor = {
  version: 1,
  runId: "run",
  legId: "leg",
  batch: 0,
  position: 0,
  hash: "a".repeat(64)
}
const grant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 3,
  token: "capability_capability_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: turn,
  producerBaseUrl: "http://host.test/"
}

describe("callback attempt diagnostics", () => {
  // A worker sees a CONNECT; only the guest knows whether it asked the journal
  // for anything. A commit the guest attempted and a tunnel somebody observed
  // are different facts, and the hung turn needs them told apart.
  test("records the commit this host attempted, by batch, before it settles", async () => {
    const sink = collector()
    const producer = new DurableChatProducer(
      "http://host.test/",
      grant,
      () => new Promise<Response>(() => {}),
      createHostDiagnostics({ turnId: grant.turnId, write: sink.write, pendingMillis: 20 })
    )
    const fiber = Effect.runFork(producer.write({ runId: "run", type: "delta", kind: "text", text: "hi" }))
    const begun = await waitFor(() => sink.phase("chat_callback", "begin"))
    expect(begun[0]).toMatchObject({ turnId: "turn", step: "commit", batch: 1 })
    const pending = await waitFor(() => sink.phase("chat_callback", "pending"))
    expect(pending[0]).toMatchObject({ step: "commit", batch: 1 })
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(sink.phase("chat_callback", "end")[0]).toMatchObject({ step: "commit", status: 0 })
  })

  test("records the provider start this host attempted and its answer", async () => {
    const sink = collector()
    const producer = new DurableChatProducer(
      "http://host.test/",
      grant,
      () => Promise.resolve(new Response(null, { status: 204 })),
      createHostDiagnostics({ turnId: grant.turnId, write: sink.write })
    )
    await Effect.runPromise(producer.providerStarted())
    expect(sink.phase("chat_callback", "begin")[0]).toMatchObject({ step: "provider_started" })
    expect(sink.phase("chat_callback", "end")[0]).toMatchObject({ step: "provider_started", status: 204 })
  })
})

// Why a commit attempt never put a socket on the wire is still open, and the
// guest's own Node and undici build is the one variable the transport
// experiments could not control for. Ten post-release production turns failed
// to answer it, because each finished before its sandbox could be read and a
// finished turn's sandbox is deleted at once. The build therefore has to be in
// the same log the stall itself is read from, written before the first
// callback is attempted rather than raced for afterwards.
describe("the guest runtime a turn reports", () => {
  // The build is the host's to name: the Node model host's observer reads it
  // off the process it runs in (`FetchTransport` in `@smthrs/platform-node`).
  const runtime = { node: "26.5.0", platform: "linux", arch: "arm64" }
  const observeTransport: CallbackTransportObserver = () => ({
    ...inertCallbackTransport,
    runtime,
    close: () => {}
  })

  test("is recorded before this turn's first callback, as version strings", async () => {
    const sink = collector()
    // A turn whose journal refuses its very first callback: the record has to
    // be there for the turns that fail, which are the ones being read.
    const exit = await Effect.runPromiseExit(
      runDurableChatTurn(
        Model.make({ stream: () => Stream.fromIterable([{ type: "settle", stopReason: "stop" } as const]) }),
        grant,
        { modelId: "m" },
        "http://host.test/",
        () => Promise.resolve(new Response(null, { status: 403 })),
        undefined,
        undefined,
        createHostDiagnostics({ turnId: grant.turnId, write: sink.write }),
        observeTransport
      )
    )
    expect(exit._tag).toBe("Failure")
    const [recorded] = sink.phase("host_runtime", "start")
    expect(recorded).toMatchObject({ turnId: "turn", ...runtime })
    // Before the first attempt, so a stalled turn's log carries it.
    expect(sink.lines.indexOf(recorded!)).toBeLessThan(
      sink.lines.findIndex((line) => line.event === "chat_callback")
    )
    // One record per turn that RAN: building the Effect writes nothing.
    const unrun = collector()
    const _unrunTurn = runDurableChatTurn(
      Model.make({ stream: () => Stream.never }),
      grant,
      { modelId: "m" },
      "http://host.test/",
      () => Promise.resolve(new Response(null, { status: 403 })),
      undefined,
      undefined,
      createHostDiagnostics({ turnId: grant.turnId, write: unrun.write }),
      observeTransport
    )
    expect(unrun.phase("host_runtime", "start")).toHaveLength(0)
  })

  test("names no build when the host supplied no observer", async () => {
    const sink = collector()
    await Effect.runPromiseExit(
      runDurableChatTurn(
        Model.make({ stream: () => Stream.fromIterable([{ type: "settle", stopReason: "stop" } as const]) }),
        grant,
        { modelId: "m" },
        "http://host.test/",
        () => Promise.resolve(new Response(null, { status: 403 })),
        undefined,
        undefined,
        createHostDiagnostics({ turnId: grant.turnId, write: sink.write })
      )
    )
    const [recorded] = sink.phase("host_runtime", "start")
    expect(recorded).toEqual({
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      turnId: "turn",
      event: "host_runtime",
      phase: "start",
      atMillis: expect.any(Number)
    })
  })
})

// The production deadlock, as a stream contract. The commit production turn
// 2d851bdd issued 1 ms after its first event never answered while the host
// held the provider's response unread, so a commit that can only answer once
// that response has been released must still be able to. The host therefore
// has to keep draining the provider's side while a frame is in flight; a host
// that reads only when its consumer asks cannot finish this turn at all.
// `ProviderDrain.test.ts` carries the same contract for a response longer
// than any fixed buffer.
describe("a frame committed while the provider response is still open", () => {
  test("does not stop the provider stream being drained", async () => {
    let drained = false
    const events: Array<ModelEvent.ModelEvent> = [
      ...Array.from({ length: 64 }, (_, index) => ({
        type: "text-delta" as const,
        id: "a",
        text: `word ${index} `
      })),
      { type: "settle", stopReason: "stop" }
    ]
    const provider = Model.make({
      stream: () =>
        Stream.fromIterable(events).pipe(Stream.ensuring(Effect.sync(() => {
          drained = true
        })))
    })
    // The commit answers only once the response has been read to its end,
    // which is exactly what sharing one connection with it enforces.
    const commits: Array<string> = []
    const write = (frame: { readonly type: string }) =>
      Effect.flatMap(
        Effect.promise(() =>
          new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (!drained) return
              clearInterval(check)
              resolve()
            }, 5)
          })
        ),
        () =>
          Effect.sync(() => {
            commits.push(frame.type)
          })
      )
    await Effect.runPromise(
      runModelTurn(provider, turn, { modelId: "model" }, write, undefined, createHostDiagnostics({ write: () => {} }))
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () =>
              Effect.die(new Error("the turn never finished: the commit and the provider stream are deadlocked"))
          })
        )
    )
    expect(commits.length).toBe(events.length)
    expect(commits.at(-1)).toBe("done")
  })
})
