import { Model } from "@smthrs/model"
import { AgentTurnJournal, type NativeAgent } from "@smthrs/rpc"
import { Cause, Effect, Exit, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { inertCallbackTransport } from "../src/CallbackTransport.ts"
import type { CallbackTransport, CallbackTransportObserver } from "../src/CallbackTransport.ts"
import type { HostDiagnosticFields } from "../src/HostDiagnostics.vibe"
import { createHostDiagnostics } from "./diagnostics.ts"
import { DurableChatProducer, runDurableChatTurn } from "./fixtures/durable.ts"

/**
 * The producer's half of journal callback attribution: the port.
 *
 * Which phase a callback reached is read from the runtime's own HTTP stack,
 * so the reading itself lives in the host bundle (`FetchTransport` in
 * `@smthrs/platform-node`, which pins it over real sockets). What this package
 * owns is that every callback runs inside its own attempt, that an attempt's
 * reading is taken once and is the same reading in the guest's log and in the
 * failure the host answers with, and that a turn observes its callbacks for
 * exactly as long as it runs. A scripted observer holds those without a
 * socket.
 */

const request: NativeAgent.StartAgentTurnRequest = {
  runId: "run",
  instructions: "answer",
  messages: [{ role: "user", content: "hi" }]
}
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
  request,
  producerBaseUrl: "http://journal.test/"
}

const digest = (value: unknown): string =>
  createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", value)).digest("hex")

const receipt = (expected: AgentTurnJournal.AgentTurnCursor, frame: NativeAgent.AgentTurnFrame) => {
  const unsigned = {
    version: 1 as const,
    runId: expected.runId,
    legId: expected.legId,
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames: [frame]
  }
  const batch: AgentTurnJournal.AgentTurnBatch = { ...unsigned, hash: digest(unsigned) }
  return {
    status: "committed" as const,
    batch,
    cursor: {
      version: 1 as const,
      runId: batch.runId,
      legId: batch.legId,
      batch: batch.batch,
      position: batch.from,
      hash: batch.hash
    }
  }
}

const delta = (text: string): NativeAgent.AgentTurnFrame => ({ runId: "run", type: "delta", kind: "text", text })

const recorderInto = (lines: Array<Record<string, unknown>>) => ({
  record: () => {},
  begin: () =>
    Effect.succeed((outcome: Record<string, unknown> = {}) => {
      lines.push(outcome)
    })
})

/**
 * An observer that hands out one scripted reading per attempt and remembers
 * how it was used: which origin it was opened on, whether each request ran
 * inside its attempt, how often each attempt was read, and how often it was
 * closed.
 */
const scripted = (readings: ReadonlyArray<HostDiagnosticFields>) => {
  const queue = [...readings]
  const state = { opened: [] as Array<string>, reads: [] as Array<number>, closed: 0, inside: false }
  const transport: CallbackTransport = {
    begin: () => {
      const fields = queue.shift() ?? {}
      const index = state.reads.push(0) - 1
      return {
        run: async (action) => {
          state.inside = true
          try {
            return await action()
          } finally {
            state.inside = false
          }
        },
        fields: () => {
          state.reads[index] = (state.reads[index] ?? 0) + 1
          return fields
        }
      }
    }
  }
  const observe: CallbackTransportObserver = (callbackBaseUrl) => {
    state.opened.push(callbackBaseUrl)
    return {
      ...transport,
      runtime: { node: "26.5.0", platform: "linux", arch: "arm64" },
      close: () => {
        state.closed += 1
      }
    }
  }
  return { state, transport, observe }
}

describe("a journal callback's attempt", () => {
  test("runs inside its own attempt and records the reading that attempt took", async () => {
    const observer = scripted([{ transport: "received", reusedSocket: false }])
    const lines: Array<Record<string, unknown>> = []
    const ran: Array<boolean> = []
    const fetchImpl: NativeAgent.FetchLike = async (_input, init) => {
      ran.push(observer.state.inside)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      return Response.json(receipt(body.expected, body.frames[0]))
    }
    const producer = new DurableChatProducer(
      grant.producerBaseUrl,
      grant,
      fetchImpl,
      recorderInto(lines),
      300,
      observer.transport
    )
    await Effect.runPromise(producer.write(delta("a")))
    expect(ran).toEqual([true])
    expect(lines).toEqual([{ status: 200, transport: "received", reusedSocket: false }])
    expect(observer.state.reads).toEqual([1])
  })

  test("a failed callback carries the phase it died in, the same reading as its record", async () => {
    // The attempt's record goes to the guest's log, and that log lives exactly
    // as long as the guest does. The failure carries the same reading out to
    // the caller over the one connection a callback fault does not break, and
    // it is one reading, not two that could disagree.
    const refused = { transport: "created", connectBegan: 1, connectEnded: 0, connectCode: "ECONNREFUSED" }
    const observer = scripted([refused, refused])
    const lines: Array<Record<string, unknown>> = []
    const producer = new DurableChatProducer(
      grant.producerBaseUrl,
      grant,
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      recorderInto(lines),
      300,
      observer.transport
    )
    const exit = await Effect.runPromise(Effect.exit(producer.write(delta("a"))))
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) as { transport?: unknown } : {}
    expect(failure.transport).toEqual(refused)
    // The retry is an attempt of its own, and each is read exactly once.
    expect(lines).toEqual([{ status: 0, failed: true, ...refused }, { status: 0, failed: true, ...refused }])
    expect(observer.state.reads).toEqual([1, 1])
  })

  test("carries no transport field when nothing was observed", async () => {
    // A producer driven by a caller's own fetch has no dispatcher record to
    // report, and an empty field would read as a record that found nothing.
    const producer = new DurableChatProducer(
      grant.producerBaseUrl,
      grant,
      () => Promise.reject(new Error("refused")),
      recorderInto([]),
      300,
      inertCallbackTransport
    )
    const exit = await Effect.runPromise(Effect.exit(producer.write(delta("a"))))
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) as { transport?: unknown } : {}
    expect(failure.transport).toBeUndefined()
  })
})

describe("a turn's callback observer", () => {
  const settles = Model.make({ stream: () => Stream.fromIterable([{ type: "settle", stopReason: "stop" } as const]) })

  test("is opened on the turn's callback origin and closed when the turn fails", async () => {
    const observer = scripted([{ transport: "received" }])
    const sink: Array<Record<string, unknown>> = []
    const exit = await Effect.runPromiseExit(
      runDurableChatTurn(
        settles,
        grant,
        { modelId: "m" },
        "http://callback.test/",
        () => Promise.resolve(new Response(null, { status: 403 })),
        undefined,
        undefined,
        createHostDiagnostics({ turnId: grant.turnId, write: (line) => sink.push(JSON.parse(line)) }),
        observer.observe
      )
    )
    expect(exit._tag).toBe("Failure")
    expect(observer.state.opened).toEqual(["http://callback.test/"])
    expect(observer.state.closed).toBe(1)
    // The provider-started callback ran inside the observer's attempt, and its
    // record carries that attempt's reading.
    expect(sink.find((line) => line.event === "chat_callback" && line.phase === "end")).toMatchObject({
      step: "provider_started",
      status: 403,
      transport: "received"
    })
  })

  test("is closed when the turn succeeds", async () => {
    const observer = scripted([])
    let expected = cursor
    const fetchImpl: NativeAgent.FetchLike = async (input, init) => {
      if (String(input).includes("provider-started")) return new Response(null, { status: 204 })
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      const answer = receipt(expected, body.frames[0])
      expected = answer.cursor
      return Response.json(answer)
    }
    await Effect.runPromise(
      runDurableChatTurn(
        settles,
        grant,
        { modelId: "m" },
        grant.producerBaseUrl,
        fetchImpl,
        undefined,
        undefined,
        createHostDiagnostics({ turnId: grant.turnId, write: () => {} }),
        observer.observe
      )
    )
    expect(observer.state.opened).toEqual([grant.producerBaseUrl])
    expect(observer.state.closed).toBe(1)
  })

  test("without one, a failed callback carries no transport phase", async () => {
    const exit = await Effect.runPromiseExit(
      runDurableChatTurn(
        settles,
        grant,
        { modelId: "m" },
        "http://callback.test/",
        () => Promise.reject(new Error("refused")),
        undefined,
        undefined,
        createHostDiagnostics({ turnId: grant.turnId, write: () => {} })
      )
    )
    expect(exit._tag).toBe("Failure")
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) as { transport?: unknown } : {}
    expect(failure.transport).toBeUndefined()
  })
})

describe("the inert transport", () => {
  test("runs the request and adds no field a caller cannot stand behind", async () => {
    const attempt = inertCallbackTransport.begin()
    expect(await attempt.run(() => Promise.resolve("ran"))).toBe("ran")
    expect(attempt.fields()).toEqual({})
  })
})
