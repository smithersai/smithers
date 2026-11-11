/**
 * A sealed action's step key must not depend on the `effect` release the
 * application installed.
 *
 * The key folds in `SchemaRepresentation.toJson` of the action's success and
 * error schemas. `effect@4.0.4` renamed six built-in checks, so the installed
 * encoder writes a different document than `4.0.0-rc.115` did for any schema
 * that uses one, and every recorded step behind such a schema would re-key.
 * `Node.representationIdentity` writes the rc.115 document.
 *
 * `effect@4.0.4` also dropped `Schema.brand` from the AST, so version 2 prints
 * a branded schema as its base. Version 1 restores the brands from the schema
 * value, so a key written before the upgrade can still be derived and its
 * recorded outcome found again.
 *
 * rc.115 wrote a JSON string as its media type alone. Version 3, the current
 * identity, is version 2 with what the string decodes to.
 *
 * The fixture beside this file is what rc.115 wrote for every schema in
 * `SchemaIdentityCorpus.ts`, produced by
 * `fixtures/effect-rc115-schema-identity.generate.mjs` from the rc.115 tarball
 * its `producer` block names. Nothing here regenerates it.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Node from "../src/Node.ts"
import { corpus } from "./SchemaIdentityCorpus.ts"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/effect-rc115-representation-identity.json", import.meta.url), "utf8")
) as {
  readonly producer: { readonly effect: string; readonly package: { readonly integrity: string } }
  readonly documents: Readonly<Record<string, string>>
  readonly failures: Readonly<Record<string, string>>
}

const schemas = corpus(Schema, Effect)

/**
 * The corpus entries whose rc.115 document carries a `brands` annotation.
 * From `effect@4.0.4` on a brand is not part of the AST: version 2 prints
 * these as their base, and version 1 restores the brand from the schema value.
 */
const branded = [
  "brand/string",
  "brand/checked",
  "brand/identified",
  "brand/reuse",
  "brand/identified-reuse",
  "brand/identified-then-branded",
  "brand/struct",
  "brand/int",
  "brand/twice",
  "brand/annotated-around",
  "brand/then-checked",
  "brand/between-checks",
  "brand/array",
  "brand/non-empty-array",
  "brand/tuple",
  "brand/union",
  "brand/null-or",
  "brand/record",
  "brand/optional-fields",
  "brand/nested-struct",
  "brand/identified-container",
  "brand/twice-annotated",
  "brand/tuple-with-rest",
  "brand/struct-with-rest"
]

/** A document with every `brands` annotation removed, and an emptied `annotations` with it. */
const withoutBrands = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutBrands)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value).filter(([key]) => key !== "brands").map(([key, member]) =>
    [key, withoutBrands(member)] as const
  )
  return Object.fromEntries(
    entries.filter(([key, member]) => !(key === "annotations" && Object.keys(member as object).length === 0))
  )
}

const printed = (name: string, version?: Node.RepresentationIdentityVersion): string =>
  JSON.stringify(Node.representationIdentity(schemas[name]!(), version))

describe("representation identity under an effect upgrade", () => {
  it("is held to the reviewed rc.115 tarball", () => {
    expect(fixture.producer.effect).toBe("4.0.0-rc.115")
    expect(fixture.producer.package.integrity).toBe(
      "sha512-ogYulZ5ffeOzrJqQrG0XOkDO5lKn2s9KNHhoxJy/6wKUkF0i12dlVXWA9TgsgQ+zV/JzizyG0+XMPepZEQX6vw=="
    )
  })

  it("records every schema of the corpus", () => {
    expect([...Object.keys(fixture.documents), ...Object.keys(fixture.failures)].sort())
      .toEqual(Object.keys(schemas).sort())
  })

  it("names exactly the corpus entries rc.115 wrote a brand into", () => {
    expect(Object.keys(fixture.documents).filter((name) => fixture.documents[name]!.includes("\"brands\"")))
      .toEqual(branded)
  })

  // Compared as text: the key order is part of what a canonical writer hashes.
  it.each(Object.keys(fixture.documents).filter((name) => !branded.includes(name)))(
    "writes %s as rc.115 wrote it",
    (name) => {
      expect(printed(name, 2)).toBe(fixture.documents[name])
    }
  )

  it.each(branded)("writes %s as rc.115 wrote it, less the brand", (name) => {
    expect(printed(name, 2)).not.toBe(fixture.documents[name])
    expect(printed(name, 2)).toBe(JSON.stringify(withoutBrands(JSON.parse(fixture.documents[name]!))))
  })

  // Compared as text: version 1 is the bytes every key written before the upgrade hashed.
  it.each(Object.keys(fixture.documents))("writes %s as rc.115 wrote it, brand included, at version 1", (name) => {
    expect(printed(name, 1)).toBe(fixture.documents[name])
  })

  it("names its versions newest first, and defaults to the newest", () => {
    expect(Node.representationIdentityVersions).toEqual([3, 2, 1])
    expect(printed("transform/fromJsonString")).toBe(printed("transform/fromJsonString", 3))
    expect(printed("transform/fromJsonString")).not.toBe(printed("transform/fromJsonString", 2))
  })

  it("restores no brand below a schema value that names no members", () => {
    // `Schema.make` keeps an AST and nothing else: its fields, elements and
    // members are gone, so only a brand on the value itself can be restored.
    // A declaration like this re-keys once, as every branded one did before.
    const UserId = Schema.String.pipe(Schema.brand("UserId"))
    for (
      const bare of [
        Schema.make<Schema.Top>(Schema.Struct({ id: UserId }).ast),
        Schema.make<Schema.Top>(Schema.Record(Schema.String, UserId).ast),
        Schema.make<Schema.Top>(Schema.Array(UserId).ast),
        Schema.make<Schema.Top>(Schema.Union([UserId, Schema.Number]).ast)
      ]
    ) {
      expect(Node.representationIdentity(bare, 1)).toEqual(Node.representationIdentity(bare, 2))
      expect(JSON.stringify(Node.representationIdentity(bare.pipe(Schema.brand("Row")), 1)))
        .toBe(
          JSON.stringify(Node.representationIdentity(bare, 2)).replace(
            "\"checks\"",
            "\"annotations\":{\"brands\":[\"Row\"]},\"checks\""
          )
        )
    }
  })

  it("restores a definition every position brands alike, and none that positions brand differently", () => {
    // A definition with a bigint literal and a unique symbol, which the
    // comparison of two restorations must keep apart from each other.
    const Lit = Schema.Struct({ n: Schema.Literal(1n), s: Schema.UniqueSymbol(Symbol.for("lit")) })
      .annotate({ identifier: "Lit" })
    const A = Lit.pipe(Schema.brand("A"))
    const alike = Schema.Struct({ a: A, b: A })
    expect(Node.representationIdentity(alike, 1)).toMatchObject({
      references: { Lit: { annotations: { identifier: "Lit", brands: ["A"] } } }
    })
    // rc.115 wrote two definitions for each of these, and the current encoding
    // writes one. Restoring the first position's brand would print `alike`'s
    // rc.115 document, so a key derived from it could replay `alike`'s outcome:
    // version 1 is the unrestored document instead, which adds no older key.
    for (
      const differently of [Schema.Struct({ a: A, b: Lit.pipe(Schema.brand("B")) }), Schema.Struct({ a: A, b: Lit })]
    ) {
      expect(Node.representationIdentity(differently, 1)).toEqual(Node.representationIdentity(differently, 2))
      expect(Node.representationIdentity(differently, 1)).not.toEqual(Node.representationIdentity(alike, 1))
    }
  })

  it("adds brands to the version 2 document and changes nothing else", () => {
    // What bounds every restoration, complete or not: two declarations share a
    // version 1 document only if they share a version 2 one, so a version 1 key
    // stands for another declaration only when the two differ in brands alone.
    const X = Schema.String.annotate({ identifier: "X" })
    const A = X.pipe(Schema.brand("A"))
    const V = Schema.Number.pipe(Schema.brand("V"))
    // Positions a restoration does not reach: a suspended field, and a record
    // whose key union expands into two index signatures.
    const reachedPartly = [
      Schema.Struct({ a: A, b: Schema.suspend(() => Schema.Struct({ x: X })) }),
      Schema.Record(Schema.Union([Schema.String, Schema.Symbol]), V)
    ]
    for (const schema of [...Object.keys(fixture.documents).map((name) => schemas[name]!()), ...reachedPartly]) {
      expect(JSON.stringify(withoutBrands(Node.representationIdentity(schema, 1))))
        .toBe(JSON.stringify(Node.representationIdentity(schema, 2)))
    }
  })

  it("never writes another corpus declaration's rc.115 document at version 1", () => {
    // The property a legacy key rests on: version 1 of a declaration is its own
    // rc.115 document, or its unrestored one, and never what rc.115 wrote for a
    // declaration with a different document.
    const owners = new Map<string, Set<string>>()
    for (const [name, document] of Object.entries(fixture.documents)) {
      owners.set(document, (owners.get(document) ?? new Set()).add(name))
    }
    for (const name of Object.keys(fixture.documents)) {
      const owner = owners.get(printed(name, 1))
      if (owner !== undefined) expect(owner).toContain(name)
    }
  })

  it.each(Object.entries(fixture.failures))("refuses %s as rc.115 refused it", (name, message) => {
    for (const version of Node.representationIdentityVersions) {
      expect(() => Node.representationIdentity(schemas[name]!(), version)).toThrow(expect.objectContaining({ message }))
    }
  })

  it("is the installed encoding with the renamed check ids written back", () => {
    // The premise of the module, stated where it can fail: the installed
    // release writes the 4.0.4 id, and the identity writes the rc.115 one.
    const schema = Schema.String.check(Schema.isStartingWith("a"))
    expect(JSON.stringify(SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast))))
      .toContain("\"effect/schema/isStartingWith\"")
    expect(JSON.stringify(Node.representationIdentity(schema))).toContain("\"effect/schema/isStartsWith\"")
  })
})

it("keeps author constraints on built-in checks while projecting their default annotations", () => {
  for (
    const constraint of [{}, { patterns: [{ source: "^custom$", flags: "u" }] }, {
      patterns: [{
        source: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
        flags: "i"
      }]
    }] as const
  ) {
    const schema = Schema.String.check(Schema.isGUID({ arbitraryConstraint: constraint }))
    const current = SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast))
    expect(Node.representationIdentity(schema)).toEqual(current)
  }
})

describe("what a JSON string decodes to", () => {
  const counts = () => Schema.fromJsonString(Schema.Struct({ a: Schema.Int }))
  const names = () => Schema.fromJsonString(Schema.Struct({ b: Schema.String }))
  const identified = () => Schema.fromJsonString(Schema.Struct({ a: Schema.Int.annotate({ identifier: "Count" }) }))
  const identity = (schema: Schema.Top, version?: Node.RepresentationIdentityVersion): string =>
    JSON.stringify(Node.representationIdentity(schema, version))

  it("is no part of versions 2 and 1, which keep the identity recorded keys hashed", () => {
    for (const version of [2, 1] as const) {
      for (const schema of [counts(), names(), identified()]) {
        expect(identity(schema, version)).toBe(fixture.documents["transform/fromJsonString"])
      }
    }
  })

  it("is part of version 3, at the root and in a field", () => {
    expect(identity(counts())).not.toBe(identity(names()))
    expect(identity(Schema.Struct({ row: counts() }))).not.toBe(identity(Schema.Struct({ row: names() })))
    expect(Node.representationIdentity(names())).toEqual({
      representation: {
        _tag: "String",
        annotations: { expected: "a string that will be decoded as JSON" },
        checks: [],
        content: {
          mediaType: "application/json",
          schema: {
            _tag: "Objects",
            checks: [],
            propertySignatures: [{
              name: { type: "string", value: "b" },
              type: { _tag: "String", checks: [] },
              isOptional: false,
              isMutable: false
            }],
            indexSignatures: []
          }
        }
      },
      references: {}
    })
  })

  it("keeps the definitions the decoded schema names at version 3", () => {
    expect(Node.representationIdentity(identified())).toMatchObject({
      representation: {
        content: { schema: { propertySignatures: [{ type: { _tag: "Reference", $ref: "Count" } }] } }
      },
      references: { Count: { _tag: "Number" } }
    })
    expect(identity(identified())).not.toBe(identity(counts()))
  })

  it("is the one thing version 3 adds to version 2", () => {
    expect(Object.keys(fixture.documents).filter((name) => printed(name, 3) !== printed(name, 2)))
      .toEqual(["transform/fromJsonString"])
  })
})
