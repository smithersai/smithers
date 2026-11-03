/**
 * Remaining public fixture canonicalization and indexing branches.
 *
 * Duplicate calls keep the first recording, thinking parts retain their
 * optional signature, and an array cycle must fail with the same stable typed
 * encoding error as an object cycle.
 */
import { describe, expect, it } from "vitest"
import { canonicalRequestDigest, index, type RecordedCall, recordedRequest } from "../src/Fixture.vibe"
import type { ModelRequestLike } from "../src/ModelLike.vibe"
import { FixtureEncodingError } from "../src/TestingError.ts"

const request = (messages: ModelRequestLike["messages"]): ModelRequestLike => ({
  modelId: "openai:gpt-5-mini",
  system: [],
  messages,
  tools: [],
  params: {}
})

describe("Fixture remaining canonical paths", () => {
  it("keeps the first call when two recordings have the same request digest", () => {
    const shared = request([{ role: "user", content: [{ type: "text", text: "same" }] }])
    const first: RecordedCall = { request: shared, model: "first-model", events: [] }
    const second: RecordedCall = { request: shared, model: "second-model", events: [] }
    const built = index({ calls: [first, second] })
    expect(built.size).toBe(1)
    expect(built.get(canonicalRequestDigest(shared))).toBe(first)
  })

  it("projects signed thinking parts as plain fixture data", () => {
    const projected = recordedRequest(request([{
      role: "assistant",
      content: [{ type: "thinking", text: "considering", signature: "signed" }],
      stopReason: "stop"
    }]))
    expect(projected.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "thinking", text: "considering", signature: "signed" }],
      stopReason: "stop"
    })
  })

  it("rejects an array cycle with a typed fixture error", () => {
    const cyclic: Array<unknown> = []
    cyclic.push(cyclic)
    const attempted: ModelRequestLike = {
      ...request([]),
      tools: [{
        name: "cyclic",
        description: "cyclic schema",
        parameters: { nested: cyclic }
      }]
    }
    expect(() => canonicalRequestDigest(attempted)).toThrowError(
      expect.objectContaining<Partial<FixtureEncodingError>>({
        code: "fixture_not_encodable",
        reason: "cycle",
        path: "$.tools[0].parameters.nested[0][0]"
      })
    )
  })
})
