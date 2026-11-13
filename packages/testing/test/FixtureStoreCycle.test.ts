/**
 * Cyclic caller values are outside fixture encoding, but the in-memory store
 * still has to own them without recursing forever while it snapshots a call.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import type { RecordedCall } from "../src/Fixture.ts"
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
      expect(Object.isFrozen(record)).toBe(false)
      expect(Object.isFrozen(array)).toBe(false)
      const parameters = stored.calls[0]!.request.tools[0]!.parameters
      const storedRecord = parameters.record as Record<string, unknown>
      const storedArray = parameters.array as Array<unknown>
      expect(storedRecord).not.toBe(record)
      expect(storedRecord.self).toBe(storedRecord)
      expect(storedArray).not.toBe(array)
      expect(storedArray[0]).toBe(storedArray)
      expect(Object.isFrozen(storedRecord)).toBe(true)
      expect(Object.isFrozen(storedArray)).toBe(true)
      record.extra = "caller"
      array.push("caller")
      expect(storedRecord.extra).toBeUndefined()
      expect(storedArray).toHaveLength(1)
      expect(stored.calls).toHaveLength(1)
      expect(Object.isFrozen(stored.calls[0]!.request.tools[0]!.parameters)).toBe(true)
    }))
})
