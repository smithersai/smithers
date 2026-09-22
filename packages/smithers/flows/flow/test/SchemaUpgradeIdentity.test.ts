/**
 * A declaration's schema identity must not move when `effect` is upgraded.
 *
 * Every call node folds what its callee accepts and produces into the material
 * a step key is derived from, so a projection that changed shape under an
 * upstream release would re-key every recorded step in every journal at once,
 * with nothing in the failure to say that a dependency bump did it.
 *
 * The fixture beside this file is the answer the reviewed `effect` 4.0.0-rc.112
 * tarball produced, recovered from the capture `@smthrs/core` kept while it
 * owned this projection; its `producer` block records the source revision and
 * the tarball integrity. Nothing here was regenerated under a newer `effect`,
 * so a case that goes red means the upgrade moved the identity.
 */
import { canonicalize } from "@smthrs/canonical/Serializer"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Action from "../src/Action/index.ts"
import * as Flow from "../src/Flow/index.ts"
import * as Graph from "../src/Graph.ts"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/effect-rc112-schema-identity.json", import.meta.url), "utf8")
) as { readonly documents: Readonly<Record<string, string>> }

/**
 * The identity one schema contributes, read off the graph rather than computed
 * beside it: this is the value a step key is derived from, not a restatement
 * of how it is built.
 */
const identityOf = (tag: string, schema: Schema.Top): unknown => {
  const declared = Action.make(`schema-identity/${tag}`, { payload: {}, success: schema })
  const flow = Flow.make(`schema-identity/${tag}-flow`, {
    payload: {},
    success: Schema.Unknown,
    body: () => declared.call({})
  })
  const node = Graph.nodes(Graph.build(flow, {})).find((candidate) => candidate.kind === "ActionCall")!
  return (node.draft.material.body as {
    readonly declaration: { readonly success: unknown }
  }).declaration.success
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
} satisfies Record<string, Schema.Top>

describe("schema identity across an effect upgrade", () => {
  it.each(Object.entries(schemas))("retains the pre-upgrade identity for %s", (name, schema) => {
    expect(canonicalize(identityOf(name, schema))).toBe(fixture.documents[name])
  })

  it("covers every schema the capture recorded", () => {
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(fixture.documents).sort())
  })

  it("does not distinguish two spellings of one constraint", () => {
    // What this identity does NOT do, stated where the pin lives. The
    // projection is JSON-Schema-shaped, so a check contributes the constraint
    // it documents and not the predicate that enforces it: two separately
    // constructed `isMinLength(2)` filters are one identity, and so is a
    // replacement implementation of the same constraint. An author who changes
    // what a codec DOES and needs the call re-keyed renames the declaration,
    // which is the limit `Graph.schemaIdentity` states in full.
    expect(canonicalize(identityOf("rebuilt", Schema.String.check(Schema.isMinLength(2)))))
      .toBe(fixture.documents["checked"])
  })
})
