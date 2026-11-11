/**
 * The opt-in wire trace: what one prepared request reports, the common input
 * prefix it measures against the previous request on the same key, and the
 * environment switch that turns it on.
 */
import { NodeHost } from "@smthrs/platform-node"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WireTrace as Sink } from "../src/index.ts"
import * as WireTrace from "../src/internal/WireTrace.vibe"

const prepared = (body: Record<string, unknown>, key?: string) => ({
  routeId: "openai-chatgpt",
  protocolId: "openai-responses-chatgpt",
  publicHeaders: key === undefined ? {} : { "session-id": key },
  bodyText: JSON.stringify({ ...body, ...(key === undefined ? {} : { prompt_cache_key: key }) })
})

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })

describe("WireTrace.line", () => {
  it("reports the cache identity and the input prefix shared with the previous request", () => {
    const history = new Map<string, ReadonlyArray<string>>()
    const first = WireTrace.line(
      prepared({ instructions: "teach", input: [user("begin"), user("panel 0")] }, "k"),
      history
    )
    const second = WireTrace.line(
      prepared({
        instructions: "teach",
        input: [user("begin"), { type: "reasoning", encrypted_content: "secret-state" }, user("panel 1")]
      }, "k"),
      history
    )
    expect(first).toMatchObject({ cacheKey: "k", sessionIdHeader: "k", affinity: false, commonPrefixItems: 0 })
    expect(WireTrace.line({ ...prepared({}, "other"), affinity: true }, history)).toMatchObject({ affinity: true })
    expect(second).toMatchObject({ commonPrefixItems: 1, previousItems: 2, kinds: ["user", "reasoning", "user"] })
    expect(JSON.stringify(second)).not.toContain("secret-state")
  })

  it("reads a Chat Completions body's messages and keys a request with no cache key by its route", () => {
    const history = new Map<string, ReadonlyArray<string>>()
    WireTrace.line(prepared({ messages: [user("a")] }), history)
    const line = WireTrace.line(prepared({ messages: [user("a"), null] }), history)
    expect(line).toMatchObject({
      cacheKey: null,
      sessionIdHeader: null,
      instructions: null,
      kinds: ["user", "undefined"],
      commonPrefixItems: 1
    })
    expect(WireTrace.line(prepared({}), history)).toMatchObject({ items: [], commonPrefixItems: 0 })
  })
})

const answered = (fields: Partial<WireTrace.Answered> = {}): WireTrace.Answered => ({
  routeId: "openai-chatgpt",
  protocolId: "openai-responses-chatgpt",
  outcome: "settled",
  timing: { startedAt: 1_000, attempts: 1, headersMs: 900, firstOutputMs: 7_400 },
  usage: { inputTokens: 12, outputTokens: 3 },
  ...fields
})

describe("WireTrace.responseLine", () => {
  it("reports how the call ended, its status, timing, usage, id and tier", () => {
    const line = WireTrace.responseLine(
      4,
      answered({
        stopReason: "tool-calls",
        status: 200,
        responseId: "resp_1",
        servedTier: "priority",
        headers: {
          "x-request-id": "req_1",
          "openai-processing-ms": "812",
          "cf-ray": "ray-1",
          authorization: "Bearer echoed-by-a-broken-proxy",
          "set-cookie": "session=opaque",
          "x-codex-turn-state": "routing-token"
        }
      }),
      9_400
    )

    expect(line).toEqual({
      at: "1970-01-01T00:00:09.400Z",
      kind: "response",
      call: 4,
      routeId: "openai-chatgpt",
      protocolId: "openai-responses-chatgpt",
      outcome: "settled",
      stopReason: "tool-calls",
      status: 200,
      responseId: "resp_1",
      servedTier: "priority",
      timing: { startedAt: 1_000, attempts: 1, headersMs: 900, firstOutputMs: 7_400 },
      usage: { inputTokens: 12, outputTokens: 3 },
      // Copied by name from a fixed list: nothing else in the response is read.
      headers: { "x-request-id": "req_1", "cf-ray": "ray-1", "openai-processing-ms": "812" }
    })
    expect(JSON.stringify(line)).not.toContain("echoed-by-a-broken-proxy")
    expect(JSON.stringify(line)).not.toContain("routing-token")
  })

  it("states what a call that never answered lacks as null, not as a guess", () => {
    expect(WireTrace.responseLine(1, answered({ outcome: "transport" }), 0)).toMatchObject({
      outcome: "transport",
      stopReason: null,
      status: null,
      responseId: null,
      servedTier: null,
      headers: {}
    })
  })
})

describe("the injected wire trace", () => {
  it("appends paired records using the Node host filesystem, preserving existing content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wire-trace-"))
    const file = join(directory, "trace.jsonl")
    const run = Effect.gen(function*() {
      const sink = yield* Sink.WireTrace
      const first = yield* WireTrace.record(prepared({ input: [user("a")] }, "record-k"), sink)
      const second = yield* WireTrace.record(prepared({ input: [user("a"), user("b")] }, "record-k"), sink)
      yield* WireTrace.recordResponse(first, () => answered({ status: 200 }), 9_400)
      return [first!.id, second!.id]
    })
    try {
      const ids = await Effect.runPromise(run.pipe(
        Effect.provide(Sink.layerFileSystem(file)),
        Effect.provide(NodeHost.NodeFileSystem.layer)
      ))
      const lines = readFileSync(file, "utf8").trim().split("\n").map((text) => JSON.parse(text))
      expect(lines.map((line) => [line.kind, line.call])).toEqual([["request", ids[0]], ["request", ids[1]], [
        "response",
        ids[0]
      ]])
      expect(lines.slice(0, 2).map((line) => line.commonPrefixItems)).toEqual([0, 1])
      expect(ids[1]).toBe(ids[0]! + 1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not evaluate a request or response when no sink was provided", async () => {
    const invalid = { ...prepared({}), bodyText: "not json" }
    expect(await Effect.runPromise(WireTrace.record(invalid, undefined))).toBeUndefined()
    await Effect.runPromise(WireTrace.recordResponse(undefined, () => {
      throw new Error("must not read")
    }, 0))
  })

  it("keeps diagnostic failures from failing a call, for request and response writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wire-trace-"))
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const sink = yield* Sink.WireTrace
          const call = yield* WireTrace.record(prepared({}), sink)
          expect(call).toBeDefined()
          yield* WireTrace.recordResponse(call, answered, 0)
        }).pipe(
          // A directory cannot be opened as an append file: the real host fails.
          Effect.provide(Sink.layerFileSystem(directory)),
          Effect.provide(NodeHost.NodeFileSystem.layer)
        )
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

it.each(["typed", "defect", "throw"])(
  "isolates a sink's %s failure from request and response recording",
  async (kind) => {
    const sink = Sink.WireTrace.of({
      write: () => {
        if (kind === "throw") throw new Error("diagnostic secret")
        return kind === "typed" ? Effect.fail("diagnostic secret") : Effect.die("diagnostic secret")
      }
    })
    const call = await Effect.runPromise(WireTrace.record(prepared({}), sink))
    expect(call).toBeDefined()
    await Effect.runPromise(WireTrace.recordResponse(call, answered, 0))
  }
)

it.each([undefined, 25, 0, -1, Infinity, NaN])(
  "bounds an async finalizer write (budget %s)",
  async (writeTimeoutMs) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sink = Sink.WireTrace.of({
          writeTimeoutMs,
          write: () => Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
        })
        const fiber = yield* WireTrace.recordResponse({ id: 1, sink }, answered, 0).pipe(
          Effect.uninterruptible,
          Effect.forkChild
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(writeTimeoutMs === 25 ? 25 : 1_000)
        const beforeRelease = fiber.pollUnsafe()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(fiber)
        expect(beforeRelease).toBeDefined()
        expect(Exit.isSuccess(beforeRelease!)).toBe(true)
      }).pipe(Effect.provide(TestClock.layer()))
    )
  }
)

it.each(["request", "response"])("preserves cancellation during a pending %s write", async (kind) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sink = Sink.WireTrace.of({
        writeTimeoutMs: 25,
        write: () => Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
      })
      const write = kind === "request"
        ? WireTrace.record(prepared({}), sink)
        : WireTrace.recordResponse({ id: 1, sink }, answered, 0).pipe(Effect.uninterruptible)
      const fiber = yield* write.pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* TestClock.adjust(25)
      const beforeRelease = interrupted.pollUnsafe()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.await(interrupted)
      expect(beforeRelease).toBeDefined()
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }).pipe(Effect.provide(TestClock.layer()))
  )
})

it("retains original interruption reasons and isolates accompanying sink faults", async () => {
  const interruption = Cause.makeInterruptReason(42)
  const sink = Sink.WireTrace.of({
    write: () =>
      Effect.failCause(Cause.fromReasons([
        Cause.makeFailReason("diagnostic secret"),
        Cause.makeDieReason("diagnostic defect"),
        interruption
      ]))
  })
  const exit = await Effect.runPromiseExit(
    WireTrace.recordResponse({ id: 1, sink }, answered, 0).pipe(Effect.uninterruptible)
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual([interruption])
})
