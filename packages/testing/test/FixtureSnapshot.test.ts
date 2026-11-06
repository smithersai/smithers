/**
 * A recorder writes what the provider saw, and a fixture keeps it.
 *
 * Both halves used to alias caller-owned collections across the asynchronous
 * boundary: the request was projected after the whole stream had run, emitted
 * events were pushed by reference, and `parameters`, `stopSequences`, and
 * `itemIds` were carried through untouched. With a file-backed store the
 * recorded object is re-encoded on every later append, so a harness that
 * reused one tool array across turns and rewrote its schema retroactively
 * rewrote entries it had already recorded.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { Effect, Option, Ref, Stream } from "effect"
import { canonicalRequestDigest, index, type RecordedCall, recordedRequest } from "../src/Fixture.vibe"
import * as FixtureStore from "../src/FixtureStore.ts"
import type { ModelRequestLike } from "../src/ModelLike.vibe"
import * as RecordingModel from "../src/RecordingModel.ts"
import { FixtureEncodingError } from "../src/TestingError.vibe"

/** A mutable request in the structural shape the recorder projects. */
const mutableRequest = () => ({
  modelId: "openai:gpt-5-mini",
  system: [{ type: "text" as const, text: "You are a concise reviewer." }],
  messages: [
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok" }],
      stopReason: "stop" as const,
      itemIds: ["item-1"]
    }
  ],
  tools: [{ name: "search", description: "search", parameters: { type: "object", extra: "original" } }],
  params: { stopSequences: ["STOP"] }
})

describe("recordedRequest copies every collection it stores", () => {
  it("deep-copies tool parameters", () => {
    const request = mutableRequest()
    const recorded = recordedRequest(request as ModelRequestLike)
    ;(request.tools[0]!.parameters as Record<string, unknown>).extra = "rewritten"
    expect(recorded.tools[0]!.parameters).toEqual({ type: "object", extra: "original" })
  })

  it("copies stopSequences and itemIds the way addedToolNames already was", () => {
    const request = mutableRequest()
    const recorded = recordedRequest(request as ModelRequestLike)
    request.params.stopSequences.push("ALSO-STOP")
    request.messages[0]!.itemIds.push("item-2")
    expect(recorded.params.stopSequences).toEqual(["STOP"])
    const assistant = recorded.messages[0]!
    expect(assistant.role === "assistant" ? assistant.itemIds : undefined).toEqual(["item-1"])
  })
})

describe("canonicalRequestDigest reports an unencodable value as a typed failure", () => {
  const withParameters = (parameters: Record<string, unknown>): ModelRequestLike =>
    ({
      ...mutableRequest(),
      tools: [{ name: "search", description: "search", parameters }]
    }) as ModelRequestLike

  const raised = (request: ModelRequestLike): FixtureEncodingError => {
    try {
      canonicalRequestDigest(request)
    } catch (error) {
      return error as FixtureEncodingError
    }
    throw new Error("expected a FixtureEncodingError")
  }

  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      return withParameters(cyclic)
    }, "cycle"],
    ["a class instance", () => withParameters({ when: new Date(0) }), "non-plain-object"],
    ["a non-finite number", () => withParameters({ size: Number.NaN }), "non-finite-number"],
    ["a symbol key", () => withParameters({ [Symbol("s")]: 1 } as Record<string, unknown>), "symbol-key"],
    ["an undefined value", () => withParameters({ absent: undefined }), "unsupported-type"],
    ["a value nested past the depth cap", () => {
      let nested: Record<string, unknown> = { leaf: 1 }
      for (let depth = 0; depth < 200; depth += 1) nested = { nested }
      return withParameters(nested)
    }, "too-deep"]
  ])("rejects %s", (_name, build, reason) => {
    const error = raised(build())
    expect(error).toBeInstanceOf(FixtureEncodingError)
    expect(error.code).toBe("fixture_not_encodable")
    expect(error.reason).toBe(reason)
    expect(error.path.startsWith("$")).toBe(true)
  })
})

describe("Fixture.index encodes each recorded call once", () => {
  const call = (text: string): RecordedCall => ({
    request: {
      ...mutableRequest(),
      messages: [{ role: "user", content: [{ type: "text", text }] }]
    } as ModelRequestLike,
    model: "openai:gpt-5-mini",
    events: []
  })

  it("finds a recorded call by its digest and memoizes the map", () => {
    const fixture = { calls: [call("one"), call("two")] }
    const built = index(fixture)
    expect(index(fixture)).toBe(built)
    expect(built.get(canonicalRequestDigest(fixture.calls[1]!.request))).toBe(fixture.calls[1])
    expect(built.size).toBe(2)
  })
})

describe("FixtureStore owns what it stores", () => {
  const call = (text: string): RecordedCall => ({
    request: mutableRequest() as ModelRequestLike,
    model: "openai:gpt-5-mini",
    events: [{ type: "text-delta", id: "text_1", text } as ModelEvent.ModelEvent]
  })

  it.effect("keeps an appended call as it was appended", () =>
    Effect.gen(function*() {
      const store = yield* FixtureStore.makeMemory()
      // The caller keeps its own value and rewrites it after the append.
      const appended = call("before")
      yield* store.append(appended)
      ;(appended.events[0] as { text: string }).text = "after"
      const loaded = yield* store.load()
      const stored = Option.getOrThrow(loaded).calls[0]!
      expect((stored.events[0] as { text: string }).text).toBe("before")
    }))

  it.effect("keeps the fixture it was seeded with", () =>
    Effect.gen(function*() {
      const seed = { calls: [call("before")] }
      const store = yield* FixtureStore.makeMemory(seed)
      ;(seed.calls[0]!.events[0] as { text: string }).text = "after"
      const stored = Option.getOrThrow(yield* store.load()).calls[0]!
      expect((stored.events[0] as { text: string }).text).toBe("before")
    }))

  it.effect("stops owning at the snapshot's own depth boundary", () =>
    Effect.gen(function*() {
      let deep: Record<string, unknown> = { leaf: 1 }
      for (let level = 0; level < 50_000; level += 1) deep = { nested: deep }
      const store = yield* FixtureStore.makeMemory()
      // Below the cap the snapshot is the caller's own object, so freezing it
      // would freeze the caller's value, and a walk with no cap would overflow
      // the stack inside `append`.
      yield* store.append({
        ...call("before"),
        request: {
          ...(mutableRequest() as ModelRequestLike),
          tools: [{
            name: "search",
            description: "search",
            parameters: deep
          }]
        }
      })
      const stored = Option.getOrThrow(yield* store.load()).calls[0]!
      expect(Object.isFrozen(stored.request.tools[0]!.parameters)).toBe(true)
      // The caller's own value is untouched, at every level.
      expect(Object.isFrozen(deep)).toBe(false)
      let tail: unknown = stored.request.tools[0]!.parameters
      for (let level = 0; level < 200; level += 1) tail = (tail as Record<string, unknown>).nested
      expect(Object.isFrozen(tail)).toBe(false)
    }))

  it.effect("hands back a value a consumer cannot rewrite, at a stable identity", () =>
    Effect.gen(function*() {
      const store = yield* FixtureStore.makeMemory()
      yield* store.append(call("before"))
      const loaded = Option.getOrThrow(yield* store.load())
      // Frozen rather than re-copied per load: `Fixture.index` memoizes on
      // fixture identity, so a fresh copy per load would rebuild the digest
      // index on every model call.
      expect(Option.getOrThrow(yield* store.load())).toBe(loaded)
      expect(() => {
        ;(loaded.calls[0]!.events[0] as { text: string }).text = "after"
      }).toThrow(TypeError)
    }))
})

describe("RecordingModel snapshots what the provider saw", () => {
  const events: ReadonlyArray<ModelEvent.ModelEvent> = [
    { type: "text-start", id: "text_1" },
    { type: "settle", stopReason: "stop", responseId: "resp_1" }
  ]

  const collector = Effect.gen(function*() {
    const recorded = yield* Ref.make<ReadonlyArray<RecordedCall>>([])
    return {
      sink: (call: RecordedCall) => Ref.update(recorded, (calls) => [...calls, call]),
      calls: () => Ref.get(recorded)
    }
  })

  it.effect("records the request as it was at acquisition, not as it is at exit", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const request = mutableRequest()
      const live = Model.make({
        stream: () =>
          Stream.fromIterable(events).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                // Mutated while the exchange is in flight.
                ;(request.tools[0]!.parameters as Record<string, unknown>).extra = "rewritten"
              })
            )
          )
      })
      const recorder = RecordingModel.make(live, sink.sink)
      yield* Stream.runDrain(recorder.stream(request as never))
      const [call] = yield* sink.calls()
      expect(call!.request.tools[0]!.parameters).toEqual({ type: "object", extra: "original" })
    }))

  it.effect("records each event as it was emitted, not as the provider later left it", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const reused: { type: "text-delta"; id: string; text: string } = {
        type: "text-delta",
        id: "text_1",
        text: "first"
      }
      const live = Model.make({ stream: () => Stream.fromIterable([reused as ModelEvent.ModelEvent, events[1]!]) })
      const recorder = RecordingModel.make(live, sink.sink)
      yield* Stream.runDrain(recorder.stream(mutableRequest() as never))
      // The provider reuses its event object for the next turn. The array was
      // copied but its elements were not, so this rewrote what was recorded.
      reused.text = "rewritten"
      const [call] = yield* sink.calls()
      expect(call!.events[0]).toEqual({ type: "text-delta", id: "text_1", text: "first" })
    }))
})
