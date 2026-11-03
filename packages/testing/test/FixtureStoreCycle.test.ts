/**
 * Cyclic caller values are outside fixture encoding, but the in-memory store
 * still has to own them without recursing forever while it snapshots a call.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import type { RecordedCall } from "../src/Fixture.vibe"
import * as FixtureStore from "../src/FixtureStore.ts"

describe("FixtureStore cyclic snapshots", () => {
  it.effect("terminates while owning cyclic record and array spines", () =>
    Effect.gen(function*() {
      const record: Record<string, unknown> = {}
      record.self = record
      const array: Array<unknown> = []
      array.push(array)
      const call: RecordedCall = {
        request: {
          modelId: "openai:gpt-5-mini",
          system: [],
          messages: [],
          tools: [{
            name: "cyclic",
            description: "cyclic schema",
            parameters: { record, array }
          }],
          params: {}
        },
        model: "openai:gpt-5-mini",
        events: []
      }

      const store = yield* FixtureStore.makeMemory()
      yield* store.append(call)
      const stored = Option.getOrThrow(yield* store.load())
      expect(stored.calls).toHaveLength(1)
      expect(Object.isFrozen(stored.calls[0]!.request.tools[0]!.parameters)).toBe(true)
    }))
})
