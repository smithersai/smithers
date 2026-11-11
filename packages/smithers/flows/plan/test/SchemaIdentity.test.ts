/**
 * A schema's identity must not depend on the `effect` release the application
 * installed.
 *
 * `effect` is a peer range, and `Schema.toJsonSchemaDocument` prints a
 * different document under 4.0.4 than it did under 4.0.0-rc.115 for a quarter
 * of the schemas below. A step key derived from that document would move with
 * the dependency, and every recorded step would re-key with nothing to say an
 * upgrade did it. `Node.schemaIdentity` prints the document itself.
 *
 * The fixture beside this file is what rc.115 printed for every entry of
 * `SchemaIdentityCorpus.ts` under both values of `onExcessProperty`, produced
 * by the generator next to it from the rc.115 tarball its `producer` block
 * names. Nothing here regenerates it, so a case that goes red means the
 * installed `effect` moved an identity.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import * as FastCheck from "fast-check"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as internal from "../src/internal/SchemaIdentity.ts"
import * as Node from "../src/Node.ts"
import { params } from "./FastCheckParams.ts"
import { corpus, representations } from "./SchemaIdentityCorpus.ts"

interface Recording {
  readonly options: Node.SchemaIdentityOptions
  readonly documents: Readonly<Record<string, string>>
  readonly failures: Readonly<
    Record<string, { readonly stage: "emitter" | "representation"; readonly message: string }>
  >
  readonly representationDocuments: Readonly<Record<string, string>>
  readonly representationFailures: Readonly<Record<string, string>>
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/effect-rc115-schema-identity.json", import.meta.url), "utf8")
) as {
  readonly producer: { readonly effect: string; readonly package: { readonly integrity: string } }
  readonly recordings: { readonly error: Recording; readonly ignore: Recording }
}

const schemas = corpus(Schema, Effect)
const documents = representations(Schema)
const closed = { onExcessProperty: "error" } as const

/**
 * Corpus entries rc.115 refused that this package now prints, each with the
 * test below that pins its document. Nothing recorded under rc.115 had them,
 * so supporting them re-keys no journal.
 */
const supportedSinceRc115: ReadonlySet<string> = new Set(["record/number-key"])

/**
 * Corpus entries whose document departs from rc.115 on purpose: a JSON string
 * also states what it decodes to. rc.115 printed the media type alone, so two
 * declarations that decode different values shared an identity.
 */
const statesContentSchema: ReadonlySet<string> = new Set(["transform/fromJsonString"])

/**
 * The key pattern `effect@4.1.1` gives a `Schema.Number` record key
 * (`numberKeyPattern` in `src/internal/schema/toJsonSchemaDocument.ts`, built
 * from `SchemaAST.FINITE_PATTERN`): what `String(n)` prints for every number.
 */
const numberKey = "^(?:[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[Ee][+-]?\\d+)?|Infinity|-Infinity|NaN)$"

/** A representation document no schema produces, handed straight to the emitter. */
const emitted = (document: unknown, options?: Node.SchemaIdentityOptions): internal.Document =>
  internal.fromRepresentation(document as SchemaRepresentation.Document, options)

/** A string whose one check is the given one. */
const checked = (check: Readonly<Record<string, unknown>>): unknown => ({
  representation: { _tag: "String", checks: [{ _tag: "Filter", aborted: false, ...check }] },
  references: {}
})

describe("schema identity under an effect upgrade", () => {
  it("is held to the reviewed rc.115 tarball", () => {
    expect(fixture.producer.effect).toBe("4.0.0-rc.115")
    expect(fixture.producer.package.integrity).toBe(
      "sha512-ogYulZ5ffeOzrJqQrG0XOkDO5lKn2s9KNHhoxJy/6wKUkF0i12dlVXWA9TgsgQ+zV/JzizyG0+XMPepZEQX6vw=="
    )
    expect(fixture.recordings.error.options).toEqual(closed)
    expect(fixture.recordings.ignore.options).toEqual({ onExcessProperty: "ignore" })
  })

  describe.each(Object.entries(fixture.recordings))("with onExcessProperty %s", (_mode, recording) => {
    it("records every schema and every representation of the corpus", () => {
      expect([...Object.keys(recording.documents), ...Object.keys(recording.failures)].sort())
        .toEqual(Object.keys(schemas).sort())
      expect(
        [...Object.keys(recording.representationDocuments), ...Object.keys(recording.representationFailures)].sort()
      ).toEqual(Object.keys(documents).sort())
    })

    // Compared as text: the key order is part of what rc.115 returned.
    it.each(Object.keys(recording.documents).filter((name) => !statesContentSchema.has(name)))(
      "prints %s as rc.115 printed it",
      (name) => {
        expect(JSON.stringify(Node.schemaIdentity(schemas[name]!(), recording.options))).toBe(recording.documents[name])
      }
    )

    // Compared as text: the decoded schema prints last, after what rc.115 printed.
    it.each([...statesContentSchema])("prints %s as rc.115 printed it, then what the string decodes to", (name) => {
      const recorded = JSON.parse(recording.documents[name]!) as internal.Document
      expect(JSON.stringify(Node.schemaIdentity(schemas[name]!(), recording.options))).toBe(JSON.stringify({
        ...recorded,
        schema: {
          ...recorded.schema,
          contentSchema: {
            type: "object",
            properties: { a: { type: "integer" } },
            required: ["a"],
            additionalProperties: recording.options.onExcessProperty !== "error"
          }
        }
      }))
    })

    it.each(Object.entries(recording.failures).filter(([name]) => !supportedSinceRc115.has(name)))(
      "refuses %s as rc.115 refused it",
      (name, failure) => {
        const attempt = () => Node.schemaIdentity(schemas[name]!(), recording.options)
        // The emitter's refusals are this package's to reproduce word for word.
        // An earlier one is effect's own message about its own schema.
        if (failure.stage === "emitter") expect(attempt).toThrow(expect.objectContaining({ message: failure.message }))
        else expect(attempt).toThrow()
      }
    )

    it.each([...supportedSinceRc115])("prints %s, which rc.115 refused", (name) => {
      expect(recording.failures[name]).toBeDefined()
      expect(Node.schemaIdentity(schemas[name]!(), recording.options).dialect).toBe("draft-2020-12")
    })

    it.each(Object.keys(recording.representationDocuments))(
      "prints the representation %s as rc.115 printed it",
      (name) => {
        expect(JSON.stringify(emitted(documents[name]!(), recording.options)))
          .toBe(recording.representationDocuments[name])
      }
    )

    it.each(Object.entries(recording.representationFailures))(
      "refuses the representation %s as rc.115 refused it",
      (name, message) => {
        expect(() => emitted(documents[name]!(), recording.options)).toThrow(expect.objectContaining({ message }))
      }
    )
  })

  it("leaves undeclared keys open unless told to close them, as the emitter it replaces did", () => {
    const struct = Schema.Struct({ name: Schema.String })
    expect(Node.schemaIdentity(struct).schema).toMatchObject({ additionalProperties: true })
    expect(Node.schemaIdentity(struct, { onExcessProperty: "ignore" })).toEqual(Node.schemaIdentity(struct))
    expect(Node.schemaIdentity(struct, closed).schema).toMatchObject({ additionalProperties: false })
  })

  it("folds the closed document into a catch node's filter", () => {
    const filtered = Node.catch(Node.succeed(1) as Node.Node<number, { readonly code: number }>, {
      error: Schema.Struct({ code: Schema.Int }),
      onFailure: () => Node.succeed(0)
    })
    expect((filtered.ast as { readonly filter?: unknown }).filter).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        properties: { code: { type: "integer" } },
        required: ["code"],
        additionalProperties: false
      },
      definitions: {}
    })
  })
})

describe("schema identity for what rc.115 did not have", () => {
  it("prints the code-point checks with the fragment 4.0.5 introduced them with", () => {
    expect(Node.schemaIdentity(Schema.String.check(Schema.isMinCodePoints(2))).schema)
      .toEqual({ type: "string", minLength: 2 })
    expect(Node.schemaIdentity(Schema.String.check(Schema.isMaxCodePoints(5))).schema)
      .toEqual({ type: "string", maxLength: 5 })
    expect(Node.schemaIdentity(Schema.String.check(Schema.isBetweenCodePoints(2, 5))).schema)
      .toEqual({ type: "string", allOf: [{ minLength: 2 }, { maxLength: 5 }] })
  })

  it("owns the new ASCII check while retaining Effect's runtime validation", () => {
    const ascii = Schema.String.check(Schema.isAscii())
    expect(Node.schemaIdentity(ascii).schema).toEqual({ type: "string", pattern: "^[\\x00-\\x7F]*$" })
    expect(Schema.is(ascii)("plain\0text")).toBe(true)
    expect(Schema.is(ascii)("café")).toBe(false)
    const ulid = Schema.String.check(Schema.isULID())
    expect(Schema.is(ulid)("00000000000000000000000000")).toBe(true)
    expect(Schema.is(ulid)("80000000000000000000000000")).toBe(false)
  })

  it("takes the schema of a check result marked approximate", () => {
    const approximate = Schema.String.check(
      Schema.makeFilter((text: string) => text.length > 0, { toJsonSchema: () => [{ minLength: 1 }, true] })
    )
    expect(Node.schemaIdentity(approximate).schema).toEqual({ type: "string", minLength: 1 })
  })

  it("owns the fragment of every check the installed effect can revive", () => {
    // A release that adds a built-in check adds its reviver. Until the check
    // is listed, its identity would be whatever that release prints for it.
    const revivable = Object.values(SchemaRepresentation).flatMap((value) =>
      typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" &&
        /^effect\/schema\/is[A-Z]/.test(value.id)
        ? [value.id]
        : []
    )
    expect(revivable.length).toBeGreaterThan(40)
    expect(revivable.filter((id) => !internal.builtinCheckIds.includes(id))).toEqual([])
  })
})

describe("schema identity of a number-keyed record", () => {
  const document = (schema: Record<string, unknown>) => ({ dialect: "draft-2020-12", schema, definitions: {} })

  it("matches a number key with the pattern effect gives it", () => {
    const numberValue = Node.schemaIdentity(Schema.Number).schema
    const versions = Schema.Record(Schema.Number, Schema.Number)
    expect(Node.schemaIdentity(versions)).toEqual(
      document({ type: "object", patternProperties: { [numberKey]: numberValue }, additionalProperties: true })
    )
    expect(Node.schemaIdentity(versions, closed)).toEqual(
      document({ type: "object", patternProperties: { [numberKey]: numberValue }, additionalProperties: false })
    )
  })

  it("matches every key a number prints as, and no other", () => {
    const key = new RegExp(numberKey)
    FastCheck.assert(
      FastCheck.property(FastCheck.double(), (value) => key.test(String(value))),
      params(200)
    )
    for (const other of ["", "a", "1a", "0x10", " 1", "1 ", "+", "Infinity1", "nan"]) {
      expect(key.test(other)).toBe(false)
    }
  })

  it("keys a union of string and number keys the way effect does", () => {
    const tagged = Schema.TemplateLiteral(["k-", Schema.String])
    expect(Node.schemaIdentity(Schema.Record(Schema.Union([Schema.Number, tagged]), Schema.String), closed)).toEqual(
      document({
        type: "object",
        patternProperties: { [numberKey]: { type: "string" }, "^k-[\\s\\S]*?$": { type: "string" } },
        additionalProperties: false
      })
    )
    // effect gives each member of a key union its own index signature, so a
    // plain string member adds an open signature beside the number pattern.
    for (const keys of [[Schema.Number, Schema.String], [Schema.String, Schema.Number]] as const) {
      for (const options of [{}, closed]) {
        expect(Node.schemaIdentity(Schema.Record(Schema.Union(keys), Schema.String), options)).toEqual(
          document({
            type: "object",
            patternProperties: { [numberKey]: { type: "string" } },
            allOf: [{ type: "object", additionalProperties: { type: "string" } }]
          })
        )
      }
    }
  })

  it("names a checked number key's property names by effect's pattern when undeclared keys are closed", () => {
    const counts = Schema.Record(Schema.Int, Schema.String)
    expect(Node.schemaIdentity(counts)).toEqual(document({ type: "object", additionalProperties: true }))
    expect(Node.schemaIdentity(counts, closed)).toEqual(
      document({
        type: "object",
        propertyNames: { type: "string", pattern: numberKey },
        additionalProperties: { type: "string" }
      })
    )
    const either = Schema.Record(
      Schema.Union([Schema.Int, Schema.TemplateLiteral(["k-", Schema.String])]),
      Schema.String
    )
    expect(Node.schemaIdentity(either, closed).schema).toMatchObject({
      propertyNames: { anyOf: [{ type: "string", pattern: numberKey }, { type: "string", pattern: "^k-[\\s\\S]*?$" }] }
    })
  })

  it("follows a referenced number key into its definition", () => {
    const counts = Schema.Record(Schema.Int.annotate({ identifier: "Count" }), Schema.String)
    expect(Node.schemaIdentity(counts, closed)).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        propertyNames: { type: "string", pattern: numberKey },
        additionalProperties: { type: "string" }
      },
      definitions: { Count: { type: "integer" } }
    })
  })

  it("names a recursive or missing key reference behind a number key", () => {
    const int = Schema.toRepresentation(Schema.toCodecJson(Schema.Int)).representation
    const keyed = (parameter: unknown, references: Record<string, unknown>) => ({
      representation: {
        _tag: "Objects",
        checks: [],
        propertySignatures: [],
        indexSignatures: [{ parameter, type: { _tag: "String", checks: [] } }]
      },
      references
    })
    const tagged = Schema.toRepresentation(Schema.TemplateLiteral(["k-", Schema.String])).representation
    const recursive = { _tag: "Union", checks: [], types: [int, tagged, { _tag: "Reference", $ref: "Key" }] }
    expect(emitted(keyed({ _tag: "Reference", $ref: "Key" }, { Key: recursive }), closed).schema).toEqual({
      type: "object",
      propertyNames: {
        anyOf: [{ type: "string", pattern: numberKey }, { type: "string", pattern: "^k-[\\s\\S]*?$" }, {
          type: "string"
        }]
      },
      additionalProperties: { type: "string" }
    })
    // The pattern walk stops at the checked number; the property names reach the reference.
    const missing = { _tag: "Union", checks: [], types: [int, { _tag: "Reference", $ref: "Missing" }] }
    expect(() => emitted(keyed(missing, {}), closed)).toThrow(
      expect.objectContaining({
        message:
          "Invalid reference Missing\n  at [\"representation\"][\"indexSignatures\"][0][\"parameter\"][\"types\"][1][\"$ref\"]"
      })
    )
  })

  it("is stable for number-keyed records and differs from the string-keyed ones", () => {
    const values = [
      () => Schema.Number,
      () => Schema.String,
      () => Schema.Struct({ a: Schema.Int }),
      () => Schema.Array(Schema.Boolean),
      () => Schema.Record(Schema.Number, Schema.String)
    ]
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: values.length - 1 }),
        FastCheck.constantFrom<Node.SchemaIdentityOptions>({}, closed),
        (index, options) => {
          const value = values[index]!
          const identity = JSON.stringify(Node.schemaIdentity(Schema.Record(Schema.Number, value()), options))
          expect(JSON.stringify(Node.schemaIdentity(Schema.Record(Schema.Number, value()), options))).toBe(identity)
          expect(JSON.stringify(Node.schemaIdentity(Schema.Record(Schema.String, value()), options))).not.toBe(identity)
        }
      ),
      params(50)
    )
  })
})

describe("the limits of schema identity", () => {
  it("does not consult a toJsonSchema annotation passed to a built-in check", () => {
    // The identity of a built-in check is its id and payload. rc.115 printed
    // the annotation here; reading it would tie the identity to whatever the
    // installed release makes the default annotation return.
    const overridden = Schema.String.check(Schema.isMinLength(2, { toJsonSchema: () => ({ minLength: 99 }) }))
    expect(JSON.stringify(Node.schemaIdentity(overridden, closed)))
      .toBe(fixture.recordings.error.documents["check/isMinLength-2"])
  })

  it("gives one definition to a schema used both branded and unbranded, where rc.115 gave two", () => {
    // From 4.0.4 on a brand is not part of the schema, so nothing an identity
    // can read tells the two fields apart. rc.115 printed
    // {"a":{"$ref":"#/$defs/Name"},"b":{"$ref":"#/$defs/Name_1"}} with both
    // definitions. A journal recorded under rc.115 for such a declaration
    // re-keys once.
    const Name = Schema.String.annotate({ identifier: "Name" })
    const mixed = Schema.Struct({ a: Name, b: Name.pipe(Schema.brand("UserId")) })
    expect(Node.schemaIdentity(mixed, closed)).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        properties: { a: { $ref: "#/$defs/Name" }, b: { $ref: "#/$defs/Name" } },
        required: ["a", "b"],
        additionalProperties: false
      },
      definitions: { Name: { type: "string" } }
    })
  })

  it("falls back to the installed annotation for a built-in check it does not list", () => {
    const representation = { id: "effect/schema/isFromALaterRelease", payload: null }
    expect(emitted(checked({ representation, annotations: { toJsonSchema: () => ({ format: "later" }) } })).schema)
      .toEqual({ type: "string", format: "later" })
    expect(emitted(checked({ representation })).schema).toEqual({ type: "string" })
  })

  it("reads a toJsonSchema annotation only when it is a function", () => {
    expect(emitted(checked({ annotations: { toJsonSchema: { pattern: "^a" } } })).schema).toEqual({ type: "string" })
  })
})

describe("what a JSON string decodes to", () => {
  const counts = Schema.fromJsonString(Schema.Struct({ a: Schema.Int }))
  const names = Schema.fromJsonString(Schema.Struct({ b: Schema.String }))
  /** A string representation with the given content and annotations. */
  const string = (content: unknown, annotations?: unknown): unknown => ({
    representation: { _tag: "String", checks: [], content, ...(annotations === undefined ? {} : { annotations }) },
    references: {}
  })

  it("tells two JSON strings apart, at the root and in a field", () => {
    expect(Node.schemaIdentity(counts, closed)).not.toEqual(Node.schemaIdentity(names, closed))
    expect(Node.schemaIdentity(Schema.Struct({ row: counts }), closed))
      .not.toEqual(Node.schemaIdentity(Schema.Struct({ row: names }), closed))
    expect(Node.schemaIdentity(names, closed)).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "string",
        contentMediaType: "application/json",
        contentSchema: {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
          additionalProperties: false
        }
      },
      definitions: {}
    })
  })

  it("files the definition the decoded schema names", () => {
    const identified = Schema.fromJsonString(Schema.Struct({ a: Schema.Int.annotate({ identifier: "Count" }) }))
    expect(Node.schemaIdentity(identified, closed)).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "string",
        contentMediaType: "application/json",
        contentSchema: {
          type: "object",
          properties: { a: { $ref: "#/$defs/Count" } },
          required: ["a"],
          additionalProperties: false
        }
      },
      definitions: { Count: { type: "integer" } }
    })
  })

  it("prints the decoded schema last, in place of an author's contentSchema annotation", () => {
    const annotated = string(
      { mediaType: "application/json", schema: { _tag: "Boolean", checks: [] } },
      { contentSchema: { type: "number" }, description: "a row" }
    )
    expect(JSON.stringify(emitted(annotated).schema)).toBe(JSON.stringify({
      type: "string",
      contentMediaType: "application/json",
      description: "a row",
      contentSchema: { type: "boolean" }
    }))
  })

  // effect names no decoded schema for a JSON string built with a reviver or a replacer.
  it("prints the media type alone for a JSON string that names no decoded schema", () => {
    const revived = Schema.fromJsonString(Schema.Struct({ a: Schema.Int }), { reviver: (_key, value) => value })
    expect(Node.schemaIdentity(revived, closed).schema)
      .toEqual({ type: "string", contentMediaType: "application/json" })
    expect(emitted(string({ mediaType: "application/json" })).schema)
      .toEqual({ type: "string", contentMediaType: "application/json" })
  })

  it("prints a JSON string used as a record key among the property names, with what it decodes to", () => {
    const keyed = (schema: unknown): unknown => ({
      representation: {
        _tag: "Objects",
        checks: [],
        propertySignatures: [],
        indexSignatures: [{
          parameter: { _tag: "String", checks: [], content: { mediaType: "application/json", schema } },
          type: { _tag: "String", checks: [] }
        }]
      },
      references: {}
    })
    const flags = emitted(keyed({ _tag: "Boolean", checks: [] }), closed)
    expect(flags).not.toEqual(emitted(keyed({ _tag: "Null", checks: [] }), closed))
    expect(flags.schema).toEqual({
      type: "object",
      propertyNames: { type: "string", contentMediaType: "application/json", contentSchema: { type: "boolean" } },
      additionalProperties: { type: "string" }
    })
    // A key that names no decoded schema is any string, as before.
    expect(emitted(keyed(undefined), closed).schema).toEqual({
      type: "object",
      additionalProperties: { type: "string" }
    })
  })

  it("prints nothing for content of another media type, as before", () => {
    expect(emitted(string({ mediaType: "text/csv", schema: { _tag: "Boolean", checks: [] } })).schema)
      .toEqual({ type: "string" })
  })
})

describe("a representation a later effect release could hand the emitter", () => {
  it("refuses a check payload that no longer names what the check constrains", () => {
    expect(() => emitted(checked({ representation: { id: "effect/schema/isMinLength", payload: { minimum: 2 } } })))
      .toThrow(/check effect\/schema\/isMinLength carries no usable "minLength" in its payload/)
    expect(() => emitted(checked({ representation: { id: "effect/schema/isPattern", payload: null } })))
      .toThrow(/check effect\/schema\/isPattern carries no usable "source" in its payload/)
  })

  it("raises a tagged refusal a caller can classify", () => {
    const refusal = (() => {
      try {
        Node.schemaIdentity(Schema.String.annotate({ contentSchema: { $ref: "#/~2" } }))
      } catch (error) {
        return error
      }
    })()
    expect(refusal).toBeInstanceOf(Node.SchemaIdentityError)
    expect(refusal).toMatchObject({ _tag: "@smthrs/plan/SchemaIdentityError" })
    expect(() => emitted(checked({ representation: { id: "effect/schema/isPattern", payload: null } })))
      .toThrow(Node.SchemaIdentityError)
  })

  it("refuses a record key type neither it nor effect supports, by name", () => {
    const keyed = (parameter: unknown) => ({
      representation: {
        _tag: "Objects",
        checks: [],
        propertySignatures: [],
        indexSignatures: [{ parameter, type: { _tag: "String", checks: [] } }]
      },
      references: {}
    })
    const at = "\n  at [\"representation\"][\"indexSignatures\"][0][\"parameter\"]"
    const refusal = (message: string) => expect.objectContaining({ _tag: "@smthrs/plan/SchemaIdentityError", message })
    expect(() => emitted(keyed({ _tag: "Boolean", checks: [] }))).toThrow(
      refusal(`Unsupported index key type Boolean${at}`)
    )
    expect(() =>
      emitted(
        keyed({ _tag: "Union", checks: [], types: [{ _tag: "Number", checks: [] }, { _tag: "BigInt", checks: [] }] })
      )
    ).toThrow(refusal(`Unsupported index key type BigInt${at}["types"][1]`))
  })

  it("refuses a kind of node it does not print, by name", () => {
    expect(() => emitted({ representation: { _tag: "Tensor", checks: [] }, references: {} })).toThrow(
      expect.objectContaining({ message: "Unsupported schema representation Tensor\n  at [\"representation\"]" })
    )
  })
})
