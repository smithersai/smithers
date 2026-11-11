import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { Migrations } from "../src/index.ts"
import { toJsonSchemaDocument } from "../src/internal/schemaFingerprintDocument.ts"

// Documents and fingerprints published by Effect 4.0.5 (see the fixture's source
// and integrity). Deployed device locks hash these bytes.
const historical = JSON.parse(readFileSync(
  new URL("./corpus/schema-fingerprints-effect4.0.5.json", import.meta.url),
  "utf8"
)) as { readonly cases: Readonly<Record<string, { readonly document: unknown; readonly fingerprint: string }>> }

interface Tree {
  readonly value: number | null
  readonly children: ReadonlyArray<Tree>
}
const recursive: Schema.Codec<Tree> = Schema.Struct({
  value: Schema.NullOr(Schema.Number),
  children: Schema.Array(Schema.suspend(() => recursive))
}).annotate({ identifier: "Recursive" })

const cases = {
  payloadReference: Schema.Struct({ value: Schema.NullOr(Schema.Number) }).annotate({ identifier: "payload" }),
  annotationsReference: Schema.Struct({ value: Schema.NullOr(Schema.Number) }).annotate({ identifier: "annotations" }),
  number: Schema.Number,
  nullable: Schema.NullOr(Schema.Number),
  object: Schema.Struct({ value: Schema.NullOr(Schema.Number) }),
  array: Schema.Array(Schema.NullOr(Schema.Number)),
  enum: Schema.Union([Schema.Literals(["a", "b"]), Schema.Literals(["c", "d"])]),
  oneOf: Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" }),
  int: Schema.Int,
  date: Schema.Date,
  bigint: Schema.BigInt,
  described: Schema.NullOr(Schema.Number).annotate({ description: "kept by the author" }),
  named: Schema.Struct({ value: Schema.NullOr(Schema.Number) }).annotate({ identifier: "Named" }),
  marker: Schema.Struct({ "~smthrs/migrations/union": Schema.Boolean }),
  metadata: Schema.NullOr(Schema.Struct({ _tag: Schema.String, payload: Schema.Struct({ types: Schema.String }) }))
    .annotate({ default: { _tag: "Union", payload: { types: "author data" } } }),
  recursive
}

it.each(Object.entries(cases))("keeps the published 4.0.5 document and fingerprint for %s", (name, schema) => {
  const expected = historical.cases[name]!
  const before = Schema.toJsonSchemaDocument(schema)
  expect(toJsonSchemaDocument(Schema.toRepresentation(Schema.toCodecJson(schema)))).toEqual(expected.document)
  expect(Migrations.fingerprint(schema)).toBe(expected.fingerprint)
  expect(Schema.toJsonSchemaDocument(schema)).toEqual(before)
})

it("keeps a real row contract change distinct", () => {
  expect(Migrations.fingerprint(cases.object)).not.toBe(
    Migrations.fingerprint(Schema.Struct({ value: Schema.NullOr(Schema.String) }))
  )
})
