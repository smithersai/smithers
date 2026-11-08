import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Trigger from "../src/Trigger.ts"
import { fromSchemaError, TriggerError } from "../src/TriggerError.ts"

const Nested = Schema.Struct({
  outer: Schema.Struct({
    inner: Schema.NonEmptyString
  })
})

describe("TriggerError", () => {
  // A caller that logs `message` used to record "Trigger declaration is
  // invalid" and nothing else; the offending field lived only inside a
  // stringified cause.
  it("names the offending field in both message and path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Trigger.make({
          id: "",
          flowId: "flow",
          input: {},
          cron: "0 0 * * *",
          maxCatchUp: 0,
          enabled: true
        })
      )
    )
    expect(error.code).toBe("invalid_trigger")
    expect(error.path).toBe("id")
    expect(error.message).toContain("Trigger declaration is invalid at id")
  })

  it("joins a nested path with dots", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Schema.decodeUnknownEffect(Nested)({ outer: { inner: "" } }))
    )
    const error = fromSchemaError("invalid_trigger", "Nested declaration is invalid", failure)
    expect(error.path).toBe("outer.inner")
    expect(error.message).toContain("at outer.inner")
  })

  // Serializing a whole `SchemaError` costs roughly five kilobytes of schema
  // AST per failure. Only the rendered issue tree is kept, and it names the
  // expectation and the path without the offending value, so a secret
  // submitted in a declaration reaches neither message nor cause.
  it("keeps a one-line summary as the cause rather than the schema AST", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Trigger.make({
          id: "secret-trigger",
          flowId: "flow",
          input: { token: "sk-live-do-not-log" },
          cron: 42,
          maxCatchUp: 0,
          enabled: true
        })
      )
    )
    expect(typeof error.cause).toBe("string")
    expect(JSON.stringify(error.cause).length).toBeLessThan(512)
    expect(error.message).not.toContain("sk-live-do-not-log")
    expect(JSON.stringify(error.cause)).not.toContain("sk-live-do-not-log")
    expect(error.message).not.toContain("\n")
  })

  // The issue tree is walked defensively: a shape this walker does not
  // recognize degrades to "no path" instead of throwing inside an error
  // constructor.
  it("degrades to no path when the failure carries no issue tree", () => {
    const error = fromSchemaError("invalid_schedule", "Schedule declaration is invalid", new Error("boom"))
    expect(error.path).toBeUndefined()
    expect(error.message).toBe("Schedule declaration is invalid: Error: boom")
  })

  it("degrades to no path for an issue tree with no path segments", () => {
    for (
      const issue of [
        { issue: null },
        { issue: { issues: [] } },
        { issue: { path: [], issue: { path: [] } } }
      ]
    ) {
      expect(fromSchemaError("invalid_trigger", "summary", issue).path).toBeUndefined()
    }
  })

  it("carries an optional cause only when one is supplied", () => {
    const bare = new TriggerError({ code: "store", message: "no cause" })
    expect(bare.cause).toBeUndefined()
    expect(bare.code).toBe("store")
  })
})
