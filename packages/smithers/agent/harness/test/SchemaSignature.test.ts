import { describe, expect, it } from "vitest"
import * as SchemaSignature from "../src/internal/schemaSignature.ts"

const document = (schema: unknown, definitions: Record<string, unknown> = {}) => ({
  dialect: "draft-2020-12",
  schema,
  definitions
})

const optional = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] })

describe("SchemaSignature.render", () => {
  it("prints an object as one line per property, optional ones marked, descriptions as comments", () => {
    // The `read` flow's input, as the registry projects it.
    const read = document({
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the text file to read" },
        offset: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], description: "1-based line offset" },
        limit: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], description: "Maximum number of lines" }
      },
      required: ["path"],
      additionalProperties: false
    })
    expect(SchemaSignature.render(read, 1)).toBe(
      [
        "{",
        "    path: string // Path of the text file to read",
        "    offset?: integer // min 1; 1-based line offset",
        "    limit?: integer // min 1; Maximum number of lines",
        "  }"
      ].join("\n")
    )
    // Smaller than the document it stands for, with nothing left out.
    expect(SchemaSignature.render(read, 1)!.length).toBeLessThan(JSON.stringify(read).length / 2)
  })

  it("takes a description from the member of a nullable union, where the encoder puts it", () => {
    const schema = document({
      type: "object",
      properties: { command: optional({ type: "string", description: "Shell command line" }) },
      additionalProperties: false
    })
    expect(SchemaSignature.render(schema)).toBe("{\n  command?: string // Shell command line\n}")
  })

  it("keeps a required property that may be null distinct from one that may be left out", () => {
    const schema = document({
      type: "object",
      properties: { parent: optional({ type: "string" }), name: { type: "string" } },
      required: ["parent", "name"],
      additionalProperties: false
    })
    // Either way a call may write no string there; `?` says so in one mark.
    expect(SchemaSignature.render(schema)).toBe("{\n  parent?: string\n  name: string\n}")
  })

  it("prints literals, unions, arrays, records and the number a schema spells three ways", () => {
    const schema = document({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["hermetic"] },
        to: optional({ type: "string", enum: ["parent", "person"] }),
        version: { const: 2 },
        globs: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
        env: { type: "object", additionalProperties: { type: "string" } },
        anything: { description: "Any JSON" },
        timeoutMs: {
          anyOf: [
            { anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }] },
            { type: "null" }
          ],
          description: "Milliseconds"
        },
        "odd-name": { type: "boolean" },
        choice: {
          anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }]
        }
      },
      required: ["mode", "version", "globs", "anything", "choice"],
      additionalProperties: false
    })
    expect(SchemaSignature.render(schema)).toBe(
      [
        "{",
        `  mode: "hermetic"`,
        `  to?: "parent" | "person"`,
        "  version: 2",
        "  globs: string[] // max items 16; each min length 1",
        "  env?: Record<string, string>",
        "  anything: unknown // Any JSON",
        "  timeoutMs?: number // Milliseconds",
        `  "odd-name"?: boolean`,
        "  choice: string | (string | number)[]",
        "}"
      ].join("\n")
    )
  })

  it("prints a union of objects as its variants and an open object with its index signature", () => {
    const schema = document({
      anyOf: [
        { type: "object", properties: { kind: { const: "a" } }, required: ["kind"], additionalProperties: false },
        {
          type: "object",
          properties: { kind: { const: "b" } },
          required: ["kind"],
          additionalProperties: { type: "number" }
        }
      ]
    })
    expect(SchemaSignature.render(schema)).toBe(
      `{\n  kind: "a"\n} | {\n  kind: "b"\n  [key: string]: number\n}`
    )
    expect(SchemaSignature.render(document({ type: "object" }))).toBe("Record<string, unknown>")
    expect(SchemaSignature.render(document({ type: "object", additionalProperties: false }))).toBe("{}")
  })

  it("expands a reference where it stands, with its JSON Pointer escapes undone", () => {
    // The `jev` flow's questions: a record of three referenced variants.
    const schema = document(
      {
        type: "object",
        properties: {
          questions: {
            type: "object",
            additionalProperties: {
              anyOf: [{ $ref: "#/$defs/flows~1model~1Boolean" }, { $ref: "#/$defs/Score" }]
            },
            description: "Questions keyed by your own ids"
          }
        },
        required: ["questions"],
        additionalProperties: false
      },
      {
        "flows/model/Boolean": {
          type: "object",
          properties: { type: { type: "string", enum: ["boolean"] }, instructions: { type: "string" } },
          required: ["type", "instructions"],
          additionalProperties: false
        },
        Score: {
          type: "object",
          properties: { type: { type: "string", enum: ["score"] }, criteria: { $ref: "#/$defs/Rungs" } },
          required: ["type", "criteria"],
          additionalProperties: false
        },
        Rungs: { type: "array", items: { type: "string" } }
      }
    )
    const rendered = SchemaSignature.render(schema)
    expect(rendered).toContain(`type: "boolean"`)
    expect(rendered).toContain("instructions: string")
    expect(rendered).toContain("criteria: string[]")
    expect(rendered).toContain("// Questions keyed by your own ids")
    expect(rendered).not.toContain("$ref")
  })

  it("renders nothing rather than drop what it does not read", () => {
    const unread: ReadonlyArray<unknown> = [
      // A keyword outside the ones it reads, at any depth.
      document({ type: "string", contentEncoding: "base64" }),
      document({ type: "object", properties: { a: { type: "string", if: {} } } }),
      document({ type: "object", patternProperties: { "^x": { type: "string" } } }),
      // A reference that names nothing, or reaches itself.
      document({ $ref: "#/$defs/Missing" }),
      document({ $ref: "#/$defs/Loop" }, { Loop: { type: "array", items: { $ref: "#/$defs/Loop" } } }),
      document({ $ref: "https://example.com/schema.json" }),
      // A required name with no property, and a type it does not know.
      document({ type: "object", properties: {}, required: ["ghost"] }),
      document({ type: "tuple" }),
      document({ type: ["string", "null"] }),
      // Not a schema document at all.
      { type: "object", required: ["path"] },
      { dialect: "draft-2020-12", schema: { type: "string" }, definitions: {}, extra: true },
      {},
      null,
      "string",
      [document({ type: "string" })]
    ]
    for (const value of unread) expect(SchemaSignature.render(value)).toBeUndefined()
  })

  it("prints a bare top-level type with its notes", () => {
    expect(SchemaSignature.render(document({ type: "string", description: "A name", maxLength: 8 }))).toBe(
      "string // max length 8; A name"
    )
    expect(SchemaSignature.render(document({ type: "string", default: "x", pattern: "^a" }))).toBe(
      `string // pattern ^a; default "x"`
    )
    expect(SchemaSignature.render(document({ anyOf: [{ type: "null" }] }))).toBe("null")
  })

  it("groups an array's item type only when the union is at its own level", () => {
    const of = (items: unknown) => SchemaSignature.render(document({ type: "array", items }))
    expect(of({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("(string | number)[]")
    // A union inside a record or an object belongs to that type, not to the array.
    expect(of({ type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "integer" }] } }))
      .toBe("Record<string, string | integer>[]")
    expect(of({ type: "object", properties: { a: { enum: ["x", "y"] } }, required: ["a"], additionalProperties: false }))
      .toBe(["{", "  a: \"x\" | \"y\"", "}[]"].join("\n"))
    expect(SchemaSignature.render(document({ type: "array" }))).toBe("unknown[]")
  })

  it("says what each item of an array is, from the item's own description and bounds", () => {
    expect(
      SchemaSignature.render(
        document({ type: "array", maxItems: 3, items: { type: "string", minLength: 1, description: "A path" } })
      )
    ).toBe("string[] // max items 3; each min length 1; each: A path")
  })

  it("prints an index signature beside named properties, with what it says of each value", () => {
    const open = (additionalProperties: unknown) =>
      SchemaSignature.render(
        document({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties })
      )
    expect(open({ type: "number" })).toBe(["{", "  id: string", "  [key: string]: number", "}"].join("\n"))
    expect(open({ type: "number", minimum: 0, description: "A weight" })).toBe(
      ["{", "  id: string", "  [key: string]: number // min 0; A weight", "}"].join("\n")
    )
    // An object that says nothing about other keys accepts them, and says so once.
    expect(open(true)).toBe(["{", "  id: string", "}"].join("\n"))
    expect(SchemaSignature.render(document({ type: "object", additionalProperties: false }))).toBe("{}")
  })

  it("takes a reference's own description before its definition's", () => {
    const definitions = { Path: { type: "string", description: "A path in the workspace" } }
    const property = (reference: Record<string, unknown>) =>
      SchemaSignature.render(
        document({ type: "object", properties: { at: reference }, required: ["at"], additionalProperties: false }, definitions)
      )
    expect(property({ $ref: "#/$defs/Path" })).toBe(["{", "  at: string // A path in the workspace", "}"].join("\n"))
    expect(property({ $ref: "#/$defs/Path", description: "Where to write" }))
      .toBe(["{", "  at: string // Where to write", "}"].join("\n"))
  })

  it("renders nothing for a shape it cannot read whole, at any depth", () => {
    const unread: ReadonlyArray<unknown> = [
      // A node that is not a schema object.
      { type: "array", items: 5 },
      { type: "object", properties: [] },
      { type: "object", properties: { a: 5 } },
      { type: "object", additionalProperties: { type: "tuple" } },
      // A union with a member it cannot read, no member at all, or a type beside it.
      { anyOf: [{ type: "string" }, { type: "tuple" }] },
      { anyOf: [] },
      { anyOf: "string" },
      { anyOf: [{ type: "string" }], type: "string" },
      // An enum that lists nothing.
      { enum: [] },
      { enum: "a" },
      // A reference that constrains beside what it names.
      { $ref: "#/$defs/Path", minLength: 2 }
    ]
    for (const schema of unread) {
      expect(SchemaSignature.render(document(schema, { Path: { type: "string" } }))).toBeUndefined()
    }
    // A document whose definitions are not a table of schemas.
    expect(SchemaSignature.render({ dialect: "draft-2020-12", schema: { type: "string" }, definitions: [] }))
      .toBeUndefined()
    // One that names no definitions at all still renders.
    expect(SchemaSignature.render({ dialect: "draft-2020-12", schema: { type: "string" } })).toBe("string")
  })
})
