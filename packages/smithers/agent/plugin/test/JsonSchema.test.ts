import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as JsonSchema from "../src/JsonSchema.ts"

const resolve = (schema: JsonSchema.Json, defs?: Record<string, JsonSchema.Json>) =>
  Effect.runPromise(JsonSchema.resolve(schema, defs, "s"))

const refused = (schema: JsonSchema.Json, defs?: Record<string, JsonSchema.Json>) =>
  Effect.runPromise(Effect.flip(JsonSchema.resolve(schema, defs, "s"))).then(({ path, reason }) => [reason, path])

describe("JsonSchema.resolve", () => {
  it("inlines refs from $defs, beside a title or description", async () => {
    const defs = { Note: { type: "object", properties: { note: { type: "string" } } } }
    expect(await resolve({ type: "array", items: { $ref: "#/$defs/Note", title: "A note" } }, defs)).toEqual({
      type: "array",
      items: { type: "object", properties: { note: { type: "string" } } }
    })
    expect(await Effect.runPromise(JsonSchema.resolve({ type: "string" }))).toEqual({ type: "string" })
  })

  it("admits every keyword of the closed subset", async () => {
    const schema = {
      type: ["object", "null"],
      title: "All",
      description: "Every keyword.",
      properties: {
        n: { type: "integer", minimum: 0, maximum: 9 },
        s: { type: "string", minLength: 1 }
      },
      required: ["n"],
      additionalProperties: false,
      default: null,
      oneOf: [{ const: 1 }],
      anyOf: [{ enum: [1, "x"] }, { type: "array", minItems: 0, maxItems: 2, items: {} }, { maxLength: 3 }]
    }
    expect(await resolve(schema)).toEqual(schema)
  })

  it("refuses a keyword outside the subset, a $defs inside a schema, and a URL or unknown ref", async () => {
    expect(await refused({ type: "string", format: "date" })).toEqual(["schema_unresolved", "s.format"])
    expect(await refused({ $defs: {} })).toEqual(["schema_unresolved", "s.$defs"])
    expect(await refused({ $ref: "https://example.test/schema" })).toEqual(["schema_unresolved", "s.$ref"])
    expect(await refused({ $ref: 5 })).toEqual(["schema_unresolved", "s.$ref"])
    expect(await refused({ $ref: "#/$defs/Missing" }, {})).toEqual(["schema_unresolved", "s.$ref"])
    expect(await refused({ $ref: "#/$defs/A", type: "string" }, { A: {} })).toEqual(["schema_unresolved", "s.$ref"])
    expect(await refused({ additionalProperties: {} })).toEqual(["schema_unresolved", "s.additionalProperties"])
    expect(await refused({ items: [{}] })).toEqual(["schema_unresolved", "s.items"])
  })

  it("refuses pattern, so no plugin regular expression ever runs on host text", async () => {
    expect(await refused({ type: "string", pattern: "^(a+)+$" })).toEqual(["schema_unresolved", "s.pattern"])
    expect(await refused({ properties: { s: { pattern: "^a" } } })).toEqual([
      "schema_unresolved",
      "s.properties.s.pattern"
    ])
  })

  it("refuses a ref cycle, naming the def that closes it", async () => {
    expect(await refused({ $ref: "#/$defs/A" }, { A: { items: { $ref: "#/$defs/B" } }, B: { $ref: "#/$defs/A" } }))
      .toEqual(["schema_unresolved", "$defs.B.$ref"])
  })

  it("refuses a field that would collect a secret", async () => {
    expect(await refused({ type: "string", format: "password" })).toEqual(["secret_field", "s"])
    expect(await refused({ type: "string", writeOnly: true })).toEqual(["secret_field", "s"])
    for (const name of ["apiToken", "Password", "client_secret", "credentials"]) {
      expect(await refused({ properties: { [name]: { type: "string" } } })).toEqual([
        "secret_field",
        `s.properties.${name}`
      ])
    }
  })

  it("refuses a malformed keyword", async () => {
    const cases: ReadonlyArray<readonly [JsonSchema.Json, string]> = [
      [5, "s"],
      [[], "s"],
      [{ type: "date" }, "s.type"],
      [{ type: [] }, "s.type"],
      [{ type: [1] }, "s.type"],
      [{ properties: [] }, "s.properties"],
      [{ required: "a" }, "s.required"],
      [{ required: [1] }, "s.required"],
      [{ enum: 1 }, "s.enum"],
      [{ enum: [] }, "s.enum"],
      [{ minimum: "0" }, "s.minimum"],
      [{ maximum: null }, "s.maximum"],
      [{ oneOf: [] }, "s.oneOf"],
      [{ anyOf: {} }, "s.anyOf"],
      [{ title: 1 }, "s.title"],
      [{ description: false }, "s.description"],
      [{ minLength: -1 }, "s.minLength"],
      [{ maxItems: 1.5 }, "s.maxItems"],
      [{ minItems: "1" }, "s.minItems"]
    ]
    for (const [schema, path] of cases) expect(await refused(schema), JSON.stringify(schema)).toEqual(["invalid", path])
  })

  it("bounds a schema's size before and after inlining, and its depth", async () => {
    expect(await refused({ description: "x".repeat(JsonSchema.maximumBytes) })).toEqual(["invalid", "s"])

    const big = { Big: { description: "x".repeat(1_000) } }
    expect(await refused({ anyOf: Array.from({ length: 20 }, () => ({ $ref: "#/$defs/Big" })) }, big)).toEqual([
      "invalid",
      "s"
    ])

    const doubling: Record<string, JsonSchema.Json> = { D13: {} }
    for (let level = 12; level >= 0; level--) {
      doubling[`D${level}`] = { anyOf: [{ $ref: `#/$defs/D${level + 1}` }, { $ref: `#/$defs/D${level + 1}` }] }
    }
    const [reason] = await refused({ $ref: "#/$defs/D0" }, doubling)
    expect(reason).toBe("invalid")

    let deep: JsonSchema.Json = {}
    for (let depth = 0; depth <= JsonSchema.maximumDepth; depth++) deep = { items: deep }
    expect((await refused(deep))[0]).toBe("invalid")
  })

  it("draws every result from a shared budget and refuses the one that overdraws it", async () => {
    const shared = JsonSchema.budget()
    expect(shared.remaining).toBe(JsonSchema.maximumInlinedBytes)
    // 15,017 bytes each: four fit 64 KiB, the fifth does not.
    const big = { description: "x".repeat(15_000) }
    for (let call = 0; call < 4; call++) await Effect.runPromise(JsonSchema.resolve(big, {}, "s", shared))
    const overdrawn = await Effect.runPromise(Effect.flip(JsonSchema.resolve(big, {}, "t", shared)))
    expect([overdrawn.reason, overdrawn.path]).toEqual(["invalid", "t"])
    for (let call = 0; call < 5; call++) expect(await resolve(big)).toEqual(big)
  })
})

describe("JsonSchema.validate", () => {
  const check = (schema: JsonSchema.Resolved, value: unknown) =>
    Option.getOrUndefined(JsonSchema.validate(schema, value))

  it("names the first failing value, or none", () => {
    const note: JsonSchema.Resolved = {
      type: "object",
      properties: { note: { type: "string", maxLength: 3 }, tags: { type: "array", items: { type: "string" } } },
      required: ["note"],
      additionalProperties: false
    }
    expect(check(note, { note: "ok", tags: ["a"] })).toBeUndefined()
    expect(check(note, {})).toBe("$.note")
    expect(check(note, { note: "long" })).toBe("$.note")
    expect(check(note, { note: "ok", tags: ["a", 1] })).toBe("$.tags[1]")
    expect(check(note, { note: "ok", more: 1 })).toBe("$.more")
    expect(check({ type: "object" }, { more: 1 })).toBeUndefined()
    expect(check(note, [])).toBe("$")
  })

  it("checks each type name", () => {
    const cases: ReadonlyArray<readonly [JsonSchema.TypeName, unknown, unknown]> = [
      ["object", {}, []],
      ["array", [], {}],
      ["integer", 1, 1.5],
      ["number", 1.5, Number.POSITIVE_INFINITY],
      ["string", "a", 1],
      ["boolean", true, "true"],
      ["null", null, undefined]
    ]
    for (const [type, good, bad] of cases) {
      expect(check({ type }, good), type).toBeUndefined()
      expect(check({ type }, bad), type).toBe("$")
    }
    expect(check({ type: ["string", "null"] }, null)).toBeUndefined()
  })

  it("checks const, enum, bounds, lengths and item counts", () => {
    expect(check({ const: { a: [1, { b: 2 }] } }, { a: [1, { b: 2 }] })).toBeUndefined()
    expect(check({ const: { a: 1 } }, { a: 1, b: 2 })).toBe("$")
    expect(check({ const: { a: 1 } }, { b: 1 })).toBe("$")
    expect(check({ const: [1, 2] }, [1])).toBe("$")
    expect(check({ const: [1, 2] }, [1, 3])).toBe("$")
    expect(check({ const: { a: 1 } }, [1])).toBe("$")
    expect(check({ enum: ["a", "b"] }, "b")).toBeUndefined()
    expect(check({ enum: ["a", "b"] }, "c")).toBe("$")
    expect(check({ minimum: 1, maximum: 2 }, 0)).toBe("$")
    expect(check({ minimum: 1, maximum: 2 }, 3)).toBe("$")
    expect(check({ minimum: 1, maximum: 2 }, 2)).toBeUndefined()
    expect(check({ minLength: 2 }, "é")).toBe("$")
    expect(check({ maxLength: 1 }, "😀")).toBeUndefined()
    expect(check({ minItems: 1 }, [])).toBe("$")
    expect(check({ maxItems: 1 }, [1, 2])).toBe("$")
    expect(check({ maxItems: 1 }, [1])).toBeUndefined()
  })

  it("checks anyOf (at least one) and oneOf (exactly one)", () => {
    const anyOf: JsonSchema.Resolved = { anyOf: [{ type: "string" }, { type: "integer" }] }
    expect(check(anyOf, 1)).toBeUndefined()
    expect(check(anyOf, true)).toBe("$")
    const oneOf: JsonSchema.Resolved = { oneOf: [{ type: "number" }, { type: "integer" }] }
    expect(check(oneOf, 1.5)).toBeUndefined()
    expect(check(oneOf, 1)).toBe("$")
    expect(check(oneOf, "x")).toBe("$")
  })
})

describe("JsonSchema.properties", () => {
  it("lists declared properties, alternatives included, once each", () => {
    expect(
      JsonSchema.properties({
        properties: { a: {} },
        oneOf: [{ properties: { b: {}, a: {} } }],
        anyOf: [{ properties: { c: {} } }]
      })
    ).toEqual(["a", "b", "c"])
    expect(JsonSchema.properties({})).toEqual([])
  })
})

describe("JsonSchema.property and JsonSchema.at", () => {
  const row: JsonSchema.Resolved = {
    properties: { options: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } } },
    anyOf: [{ properties: { extra: { type: "integer" } } }],
    oneOf: [{ properties: { other: {} } }]
  }

  it("finds a property in properties, then in oneOf and anyOf members", () => {
    expect(JsonSchema.property(row, "options")).toBe(row.properties!["options"])
    expect(JsonSchema.property(row, "extra")).toEqual({ type: "integer" })
    expect(JsonSchema.property(row, "other")).toEqual({})
    expect(JsonSchema.property(row, "constructor")).toBeUndefined()
    expect(JsonSchema.property({}, "x")).toBeUndefined()
  })

  it("walks names into properties and numbers into items", () => {
    expect(JsonSchema.at(row, ["options", 0, "label"])).toEqual({ type: "string" })
    expect(JsonSchema.at(row, [])).toBe(row)
    expect(JsonSchema.at(row, ["options", "length"])).toBeUndefined()
    expect(JsonSchema.at(row, ["extra", 0])).toBeUndefined()
    expect(JsonSchema.at(row, ["missing", "x"])).toBeUndefined()
  })
})
