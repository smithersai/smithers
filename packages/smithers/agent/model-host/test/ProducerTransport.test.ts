import { Model, type ModelEvent } from "@smthrs/model"
import { AgentTurnJournal, type NativeAgent } from "@smthrs/rpc"
import { Duration, Effect, Exit, Fiber, Latch, Stream } from "effect"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { DurableChatProducer } from "../src/DurableChatProducer.ts"
import { runModelTurn } from "../src/ModelTurnHost.vibe"

/**
 * The journal callback over real transport. The production stall is a
 * transport fact: the guest's own records show a commit attempted and never
 * answered, with no socket for it in the guest's table. A stubbed writer
 * cannot hold that contract — only a request on a real socket can — so this
 * suite runs the host's own `fetch` against a real journal and controls what
 * that journal does with each request.
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
const grantFor = (producerBaseUrl: string) => ({
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 3,
  token: "capability_capability_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request,
  producerBaseUrl
})

const digest = (value: unknown): string =>
  createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", value)).digest("hex")

/** The receipt a journal that took this batch answers with. */
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

/** What one journal request did, including whether the client gave up on it. */
interface Attempt {
  readonly path: string
  readonly batch: number
  aborted: boolean
  answered: boolean
}

interface Journal {
  readonly baseUrl: string
  readonly attempts: Array<Attempt>
  /** Answers the commits this journal is told to answer; others are held open. */
  answerCommits: (batch: number) => boolean
  /** Milliseconds a journal waits before it answers a commit it will answer. */
  latencyMillis: number
  /**
   * Commits this journal sends headers for and then stops. A journal that
   * answers its status and never sends the receipt wedges a turn exactly as
   * one that never answers at all, and the half-read response holds the
   * socket, so the bound has to reach the body read too.
   */
  stallAfterHeaders: (batch: number) => boolean
}

const servers: Array<Server> = []

afterEach(async () => {
  // A held request keeps its socket open, so every connection is destroyed
  // rather than waiting for a graceful close that the test deliberately broke.
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    )
  )
})

const startJournal = async (
  options: {
    readonly answerCommits?: (batch: number) => boolean
    readonly latencyMillis?: number
    readonly stallAfterHeaders?: (batch: number) => boolean
  } = {}
): Promise<Journal> => {
  const state = {
    attempts: [] as Array<Attempt>,
    answerCommits: options.answerCommits ?? (() => true),
    latencyMillis: options.latencyMillis ?? 0,
    stallAfterHeaders: options.stallAfterHeaders ?? (() => false)
  }
  let committed = cursor
  const handle = (incoming: IncomingMessage, answer: ServerResponse): void => {
    const chunks: Array<Buffer> = []
    // A request the client gives up on closes its socket with no answer sent;
    // that is how this journal observes a bound firing on the wire.
    const held = (attempt: Attempt) =>
      answer.on("close", () => {
        if (!attempt.answered) attempt.aborted = true
      })
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      const path = (incoming.url ?? "").split("?")[0] ?? ""
      if (path === "/internal/chat/provider-started") {
        const attempt: Attempt = { path, batch: 0, aborted: false, answered: false }
        state.attempts.push(attempt)
        held(attempt)
        if (!state.answerCommits(0)) return
        attempt.answered = true
        answer.writeHead(204).end()
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        readonly frames: Array<NativeAgent.AgentTurnFrame>
      }
      const next = committed.batch + 1
      const attempt: Attempt = { path, batch: next, aborted: false, answered: false }
      state.attempts.push(attempt)
      held(attempt)
      if (state.stallAfterHeaders(next)) {
        // Headers, then silence: the response never ends, so the client's
        // receipt read waits on a socket this journal keeps open.
        answer.writeHead(200, { "content-type": "application/json" })
        answer.flushHeaders()
        return
      }
      if (!state.answerCommits(next)) return
      const reply = receipt(committed, body.frames[0]!)
      committed = reply.cursor
      attempt.answered = true
      const send = () => {
        answer.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply))
      }
      if (state.latencyMillis === 0) send()
      else setTimeout(send, state.latencyMillis)
    })
  }
  const server = createServer(handle)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    attempts: state.attempts,
    get answerCommits() {
      return state.answerCommits
    },
    set answerCommits(value) {
      state.answerCommits = value
    },
    get latencyMillis() {
      return state.latencyMillis
    },
    set latencyMillis(value) {
      state.latencyMillis = value
    },
    get stallAfterHeaders() {
      return state.stallAfterHeaders
    },
    set stallAfterHeaders(value) {
      state.stallAfterHeaders = value
    }
  }
}

const waitUntil = async (ready: () => boolean, complaint: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(complaint)
}

const delta = (text: string): NativeAgent.AgentTurnFrame => ({ runId: "run", type: "delta", kind: "text", text })

/** The deadline every case here uses, so a bound that fires is quick to see. */
const deadline = 300

// The defect, stated as transport. `fetch` has no deadline of its own, so a
// journal callback that is never answered holds a hosted turn open for as long
// as the lease renews: production turn 2d851bdd sat on one such attempt for
// half an hour, and turn 7e5fc00f for 1 h 19 m, both committing nothing. Each
// case below is unsatisfiable without the host's own bound.
describe("a journal callback that is never answered", () => {
  test("ends the commit attempt, retries once, and fails the turn by name", async () => {
    const journal = await startJournal({ answerCommits: () => false })
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const exit = await Effect.runPromise(
      Effect.exit(producer.write(delta("a"))).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () => Effect.die(new Error("the commit was never bounded: the host waited on a silent journal"))
        })
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})
    expect(cause).toContain("ProducerUnreachable")
    expect(cause).toContain("commit")
    // Two attempts: the bounded one and the single retry the producer allows.
    expect(journal.attempts).toHaveLength(2)
    // The bound frees the socket rather than leaking it, so the retry asks for
    // a connection of its own instead of queueing behind a dead request.
    await waitUntil(
      () => journal.attempts.every((attempt) => attempt.aborted),
      "a bounded attempt left its request open on the journal"
    )
  })

  // A journal that answers its status and then stops sending the receipt is
  // the same fault one message later, and it is the shape the comment on the
  // commit bound claims to cover. `fetch` resolves on headers, so the receipt
  // read is a second unbounded wait on the same socket: bounding only the
  // request leaves the turn ended and the connection leaked.
  test("ends an attempt whose journal sends headers and never sends the receipt", async () => {
    const journal = await startJournal({ stallAfterHeaders: () => true })
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const exit = await Effect.runPromise(
      Effect.exit(producer.write(delta("a"))).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () =>
            Effect.die(new Error("the receipt read was never bounded: the host waited on a half-sent response"))
        })
      )
    )
    const cause = JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})
    expect(cause).toContain("ProducerUnreachable")
    expect(cause).toContain("commit")
    expect(journal.attempts).toHaveLength(2)
    // The bound has to close the socket it is holding, or every stalled turn
    // leaves a connection behind for the lifetime of the guest.
    await waitUntil(
      () => journal.attempts.every((attempt) => attempt.aborted),
      "a bounded attempt left its half-sent response open on the journal"
    )
  })

  test("ends a provider-start attempt instead of holding the turn before its first event", async () => {
    const journal = await startJournal({ answerCommits: () => false })
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const exit = await Effect.runPromise(
      Effect.exit(producer.providerStarted()).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () => Effect.die(new Error("provider start was never bounded"))
        })
      )
    )
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})).toContain("provider_started")
    expect(journal.attempts).toHaveLength(1)
  })

  test("names the bound in the guest's own record, so a reader need not infer it", async () => {
    const journal = await startJournal({ answerCommits: () => false })
    const lines: Array<Record<string, unknown>> = []
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      {
        record: () => {},
        begin: () =>
          Effect.succeed((outcome) => {
            lines.push({ ...outcome })
          })
      },
      deadline
    )
    await Effect.runPromise(
      Effect.exit(producer.write(delta("a"))).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () => Effect.die(new Error("the commit was never bounded, so no record could name a bound"))
        })
      )
    )
    expect(lines.every((line) => line.timedOut === true)).toBe(true)
    expect(lines).toHaveLength(2)
  })

  test("still drains the provider's whole response, then fails rather than stalling", async () => {
    // Both halves of the repair, against one real journal: the provider's side
    // keeps draining while a commit is outstanding (no buffer bounded by a
    // token count could hold this response), and the outstanding commit ends.
    const journal = await startJournal({ answerCommits: (batch) => batch !== 1 })
    const produced = { events: 0 }
    const events: Array<ModelEvent.ModelEvent> = [
      ...Array.from({ length: 5_000 }, (_, index) => ({ type: "text-delta" as const, id: "a", text: `w${index} ` })),
      { type: "settle", stopReason: "stop" }
    ]
    const model = Model.make({
      stream: () =>
        Stream.fromIterable(events).pipe(Stream.tap(() =>
          Effect.sync(() => {
            produced.events += 1
          })
        ))
    })
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const exit = await Effect.runPromise(
      Effect.exit(
        runModelTurn(model, request, { modelId: "model", maxTokens: 1024 }, (frame) => producer.write(frame))
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () =>
            Effect.die(new Error("the turn never ended: a silent journal still holds the provider's response"))
        })
      )
    )
    expect(produced.events).toBe(events.length)
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})).toContain("ProducerUnreachable")
  })
})

describe("a journal that answers", () => {
  test("commits every frame of a long reply over real requests, in order", async () => {
    const journal = await startJournal({ latencyMillis: 1 })
    const words = 600
    const events: Array<ModelEvent.ModelEvent> = [
      ...Array.from({ length: words }, (_, index) => ({ type: "text-delta" as const, id: "a", text: `w${index} ` })),
      { type: "settle", stopReason: "stop" }
    ]
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const committed: Array<NativeAgent.AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(
        Model.make({ stream: () => Stream.fromIterable(events) }),
        request,
        { modelId: "model" },
        (frame) =>
          Effect.flatMap(producer.write(frame), () =>
            Effect.sync(() => {
              committed.push(frame)
            }))
      )
    )
    // One batch per frame, the last of them terminal, and every batch answered
    // on its own request: the journal's own cursor advanced 1..n in order.
    expect(committed).toHaveLength(events.length)
    expect(committed.at(-1)?.type).toBe("done")
    expect(journal.attempts.map((attempt) => attempt.batch)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1)
    )
    expect(journal.attempts.every((attempt) => attempt.answered)).toBe(true)
  })

  test("takes the journal's first receipt while the provider is still answering", async () => {
    // Early durable progress: the person's first words reach the journal before
    // the provider has finished, so a turn cut short still leaves a transcript.
    const latch = Latch.makeUnsafe(false)
    const held = Stream.drain(Stream.fromEffect(latch.await))
    const journal = await startJournal()
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      deadline
    )
    const model = Model.make({
      stream: () =>
        Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "a", text: "first " }]).pipe(
          Stream.concat(held),
          Stream.concat(Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "settle", stopReason: "stop" }]))
        )
    })
    const fiber = Effect.runFork(
      runModelTurn(model, request, { modelId: "model" }, (frame) => producer.write(frame))
    )
    await waitUntil(
      () => journal.attempts.some((attempt) => attempt.answered),
      "no frame reached the journal while the provider was still answering"
    )
    latch.openUnsafe()
    await Effect.runPromise(Fiber.join(fiber))
    expect(journal.attempts.length).toBeGreaterThanOrEqual(2)
  })

  test("aborts an in-flight commit when the turn is cancelled", async () => {
    // A cancelled turn must not leave a request on the journal: the connection
    // is the scarce resource the stall turned on.
    const journal = await startJournal({ answerCommits: () => false })
    const producer = new DurableChatProducer(
      journal.baseUrl,
      grantFor(journal.baseUrl),
      undefined,
      undefined,
      30_000
    )
    const fiber = Effect.runFork(
      runModelTurn(
        Model.make({
          stream: () =>
            Stream.fromIterable<ModelEvent.ModelEvent>([
              { type: "text-delta", id: "a", text: "x" },
              { type: "settle", stopReason: "stop" }
            ])
        }),
        request,
        { modelId: "model" },
        (frame) => producer.write(frame)
      )
    )
    await waitUntil(() => journal.attempts.length > 0, "the commit never reached the journal")
    await Effect.runPromise(Fiber.interrupt(fiber))
    await waitUntil(
      () => journal.attempts[0]?.aborted === true,
      "a cancelled turn left its commit open on the journal"
    )
  })
})
