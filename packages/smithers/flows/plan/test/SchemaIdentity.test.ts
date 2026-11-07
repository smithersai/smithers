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
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as internal from "../src/internal/SchemaIdentity.ts"
import * as Node from "../src/Node.ts"
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
    it.each(Object.keys(recording.documents))("prints %s as rc.115 printed it", (name) => {
      expect(JSON.stringify(Node.schemaIdentity(schemas[name]!(), recording.options))).toBe(recording.documents[name])
    })

    it.each(Object.entries(recording.failures))("refuses %s as rc.115 refused it", (name, failure) => {
      const attempt = () => Node.schemaIdentity(schemas[name]!(), recording.options)
      // The emitter's refusals are this package's to reproduce word for word.
      // An earlier one is effect's own message about its own schema.
      if (failure.stage === "emitter") expect(attempt).toThrow(expect.objectContaining({ message: failure.message }))
      else expect(attempt).toThrow()
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
        Node.schemaIdentity(Schema.Record(Schema.Number, Schema.String))
      } catch (error) {
        return error
      }
    })()
    expect(refusal).toBeInstanceOf(Node.SchemaIdentityError)
    expect(refusal).toMatchObject({ _tag: "@smthrs/plan/SchemaIdentityError" })
    expect(() => emitted(checked({ representation: { id: "effect/schema/isPattern", payload: null } })))
      .toThrow(Node.SchemaIdentityError)
    expect(() => Node.schemaIdentity(Schema.String.annotate({ contentSchema: { $ref: "#/~2" } })))
      .toThrow(Node.SchemaIdentityError)
  })

  it("refuses a kind of node it does not print, by name", () => {
    expect(() => emitted({ representation: { _tag: "Tensor", checks: [] }, references: {} })).toThrow(
      new Node.SchemaIdentityError({ message: "Unsupported schema representation Tensor\n  at [\"representation\"]" })
    )
  })
})
