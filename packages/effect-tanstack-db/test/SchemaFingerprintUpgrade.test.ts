import { Arbitrary, Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { Migrations } from "../src/index.ts"

// Captured from unmodified main 1651d87f2e24 (Effect 4.0.5). These are deployed
// Smithers device patterns, not snapshots regenerated from the new emitter.
describe("Smithers device union fingerprints", () => {
  interface LegacyCase {
    readonly kind: "number" | "string" | "boolean" | "literals" | "enum"
    readonly identifier?: string
    readonly style: string
    readonly fingerprint: string
    readonly document: {
      readonly schema: {
        readonly properties: Readonly<Record<string, unknown>>
        readonly required?: ReadonlyArray<string>
      }
    }
  }
  const corpus = JSON.parse(readFileSync(
    new URL("./corpus/smithers-device-union-fingerprints.json", import.meta.url),
    "utf8"
  )) as ReadonlyArray<LegacyCase>
  const schema = (row: LegacyCase, key = "field") => {
    let member: Schema.Top = {
      number: Schema.Number,
      string: Schema.String,
      boolean: Schema.Boolean,
      literals: Schema.Literals(["requested", "fetching", "indexing"]),
      enum: Schema.Enum({ A: "a", B: "b" })
    }[row.kind]
    if (row.style.includes("nullable")) member = Schema.NullOr(member)
    if (row.style === "nested-nullable") member = Schema.NullOr(member)
    if (row.identifier !== undefined) member = member.annotate({ identifier: row.identifier })
    if (row.style.includes("optional")) member = Schema.optionalKey(member)
    return Schema.Struct({ [key]: member })
  }
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(
        ([key, value]) => [key, key === "required" && Array.isArray(value) ? [...value].sort() : canonical(value)]
      )
    )
  }
  const legacyHash = (value: unknown): string => {
    const text = JSON.stringify(canonical(value))
    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < text.length; index++) {
      hash ^= BigInt(text.charCodeAt(index))
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
    return hash.toString(16).padStart(16, "0")
  }
  test.each(corpus)("keeps $kind/$style bytes from main", (row) => {
    expect(Migrations.fingerprint(schema(row))).toBe(row.fingerprint)
  })
  test("keeps the main oracle under generated field names and union compositions", () => {
    const generated = Arbitrary.schema(Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(corpus.length)),
      key: Schema.Union([
        Schema.Literal("__proto__"),
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))
      ])
    }))
    const result = Effect.runSync(Arbitrary.checkEffect(generated, ({ index, key }) => {
      const row = corpus[index]!
      const document = {
        ...row.document,
        schema: {
          ...row.document.schema,
          properties: { [key]: row.document.schema.properties["field"] },
          ...(row.document.schema.required === undefined ? {} : { required: [key] })
        }
      }
      return Migrations.fingerprint(schema(row, key)) === legacyHash(document)
    }, { seed: 20261101, runs: 500 }))
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  })
  test("keeps authored marker-like metadata and data without exposing the temporary title", () => {
    const annotations = {
      title: "smithers/device/union-grouping",
      examples: [{ title: "smithers/device/union-grouping#" }]
    }
    const row = corpus.find((row) => row.kind === "number" && row.style === "optional-nullable")!
    const expected = { ...row.document, schema: { ...row.document.schema, ...annotations } }
    expect(Migrations.fingerprint(schema(row).annotate(annotations))).toBe(legacyHash(expected))
  })
})
