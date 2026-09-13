import { Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Digest from "../src/Digest.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

// These bytes were produced by the reviewed rc.112 tarball before upgrading
// dependencies. The fixture records its source SHA and tarball integrity.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/effect-rc112-schema-identity.json", import.meta.url), "utf8")
) as {
  readonly cases: Readonly<Record<string, string>>
}

const schemas = {
  string: Schema.String,
  struct: Schema.Struct({ name: Schema.String, count: Schema.Number }),
  union: Schema.Struct({ value: Schema.Union([Schema.String, Schema.Number]) }),
  optional: Schema.Struct({ name: Schema.optionalKey(Schema.String), items: Schema.Array(Schema.Boolean) }),
  record: Schema.Record(Schema.String, Schema.String),
  tuple: Schema.Tuple([Schema.String, Schema.Number]),
  literals: Schema.Literals(["ready", "failed"]),
  tagged: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Ready"), value: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal("Failed"), code: Schema.Int })
  ]),
  checked: Schema.String.check(Schema.isMinLength(2)),
  annotated: Schema.Struct({ name: Schema.String.annotate({ description: "User name" }) })
}

it.each(Object.entries(schemas).filter(([name]) => name !== "tagged" && name !== "checked"))(
  "retains pre-upgrade structural schema identity for %s",
  (name, schema) => {
    const actual = Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(Node.dynamic({ output: schema })))))
    expect(actual).toBe(fixture.cases[name])
  }
)

it.each(["tagged", "checked"] as const)("distinguishes changed upstream predicate implementations in %s", (name) => {
  const actual = Digest.canonical(
    Result.getOrThrow(Graph.keyMaterial(Graph.build(Node.dynamic({ output: schemas[name] }))))
  )
  // Predicates carry source-derived ephemeral identities. New upstream code
  // must not masquerade as a previously admitted predicate implementation.
  expect(actual).not.toBe(fixture.cases[name])
})
