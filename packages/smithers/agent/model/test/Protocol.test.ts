import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.vibe"
import * as Protocol from "../src/Protocol.vibe"

const Event = Schema.Struct({ type: Schema.String, index: Schema.optional(Schema.Number) })

describe("Protocol", () => {
  it("returns the protocol value it was given", () => {
    const protocol = Protocol.make({
      id: "test",
      supportsDeferred: () => false,
      body: {
        schema: Schema.Struct({ model: Schema.String }),
        from: (request) => Effect.succeed({ model: request.modelId })
      },
      stream: {
        event: Protocol.jsonEvent(Event),
        initial: () => 0,
        step: (state) => Effect.succeed([state, []] as const)
      },
      classifyError: (status) => new ModelError({ code: "unknown", message: String(status) })
    })

    expect(protocol.id).toBe("test")
    expect(protocol.stream.onHalt).toBeUndefined()
    expect(protocol.stream.terminal).toBeUndefined()
  })

  it("decodes a framed JSON event and rejects a frame that is not JSON", () => {
    const codec = Protocol.jsonEvent(Event)

    expect(Schema.decodeUnknownSync(codec)("{\"type\":\"ping\"}")).toEqual({ type: "ping" })
    expect(Schema.decodeUnknownSync(codec)("{\"type\":\"ping\",\"index\":0}")).toEqual({ type: "ping", index: 0 })
    expect(() => Schema.decodeUnknownSync(codec)("")).toThrow()
    expect(() => Schema.decodeUnknownSync(codec)("not-json")).toThrow()
    expect(() => Schema.decodeUnknownSync(codec)("{\"index\":0}")).toThrow()
  })
})
