/**
 * The error schema a composed pattern declares, read on its own.
 *
 * A durable engine journals a typed failure through the flow's error schema,
 * so every member's tagged error must encode through the pattern's union as
 * itself, whichever member declared a looser schema first, and a member that
 * declares no typed error adds nothing.
 */
import { Action, Flow } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Failure from "../src/internal/Failure.vibe"
import { PatternError } from "../src/PatternError.vibe"

class Throttled extends Schema.TaggedError<Throttled>()("patterns-test/Throttled", { seconds: Schema.Number }) {}
class Refused extends Schema.TaggedError<Refused>()("patterns-test/Refused", { reason: Schema.String }) {}
class Message extends Schema.Class<Message>("patterns-test/Message")({ message: Schema.String }) {}

const member = (name: string, error: Schema.Top) =>
  Flow.make(name, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    error: error as typeof Schema.Unknown,
    body: () => Node.succeed(null)
  })

const roundTrip = (schema: Schema.Top, failure: unknown): unknown => {
  const codec = schema as Schema.Codec<unknown>
  const encoded = Schema.encodeUnknownSync(codec)(failure)
  expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
  return Schema.decodeUnknownSync(codec)(encoded)
}

describe("Failure.wire", () => {
  it("encodes a caught error through the schema of the member that declares it", () => {
    const wire = Failure.wire([member("throttles", Throttled), member("untagged", Message), undefined])
    const encoded = wire(new Throttled({ seconds: 3 }))
    expect(encoded).toEqual({ _tag: "patterns-test/Throttled", seconds: 3 })
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(wire(new Message({ message: "m" })))).toBe(Object.prototype)
  })

  it("leaves plain data as it is", () => {
    const wire = Failure.wire([member("throttles", Throttled)])
    expect(wire({ code: "down", message: "seat down" })).toEqual({ code: "down", message: "seat down" })
    expect(wire("down")).toBe("down")
  })

  it("hands back an error no member schema encodes", () => {
    const refused = new Refused({ reason: "undeclared" })
    expect(Failure.wire([member("throttles", Throttled)])(refused)).toBe(refused)
  })
})

describe("Failure.schemaFor", () => {
  it("encodes the pattern's own errors and each member's declared error as themselves", () => {
    const schema = Failure.schemaFor([PatternError], [
      member("throttles", Throttled),
      member("throttles-again", Throttled),
      member("opaque", Schema.Unknown),
      member("never-fails", Schema.Never),
      member("own", PatternError),
      { name: "not-a-flow", call: () => Node.succeed(null) },
      { name: "no-schema", errorSchema: 1 },
      () => null,
      undefined
    ])
    const throttled = new Throttled({ seconds: 3 })
    expect(roundTrip(schema, throttled)).toBeInstanceOf(Throttled)
    expect(roundTrip(schema, throttled)).toEqual(throttled)
    const refused = new PatternError({ code: "invalid_input", message: "refused" })
    expect(roundTrip(schema, refused)).toEqual(refused)
    expect(roundTrip(schema, { reason: "plain data" })).toEqual({ reason: "plain data" })
  })

  it("keeps a later member's tagged error from being swallowed by an earlier, looser schema", () => {
    // An author whose schema is a union ending in Unknown, and an untagged
    // class that accepts any `{ message }`, both come before the leaf's tagged
    // error in member order. Each still encodes as itself.
    const schema = Failure.schemaFor([], [
      member("loose-author", Schema.Union([Refused, Schema.Unknown])),
      member("untagged", Message),
      member("leaf", Throttled)
    ])
    expect(roundTrip(schema, new Throttled({ seconds: 1 }))).toBeInstanceOf(Throttled)
    expect(roundTrip(schema, new Refused({ reason: "no" }))).toBeInstanceOf(Refused)
    expect(roundTrip(schema, new Message({ message: "m" }))).toBeInstanceOf(Message)
  })

  it("reads an action member's declared error", () => {
    const work = Action.make("patterns-test/work", { payload: {}, success: Schema.String, error: Throttled })
    expect(roundTrip(Failure.schemaFor([], [work]), new Throttled({ seconds: 2 }))).toBeInstanceOf(Throttled)
  })
})
