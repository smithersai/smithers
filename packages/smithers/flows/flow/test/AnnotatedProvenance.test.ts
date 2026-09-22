import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Schema } from "effect"
import * as DeclarationSite from "../src/internal/DeclarationSite.ts"

const Note = Context.Reference<string>("test/AnnotatedProvenance/Note", { defaultValue: () => "" })
const DeclaredAction = Action.make("annotated-provenance/action", { payload: {} })
const DeclaredFlow = Flow.make("annotated-provenance/flow", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

describe("annotated declaration provenance", () => {
  it("keeps the original flow location through both annotation operations", () => {
    const original = DeclarationSite.declaredAt(DeclaredFlow)
    expect(original?.path.endsWith("test/AnnotatedProvenance.test.ts")).toBe(true)
    for (
      const copy of [
        DeclaredFlow.annotate(Note, "one"),
        DeclaredFlow.annotateMerge(Context.make(Note, "two")),
        DeclaredFlow.annotate(Note, "one").annotateMerge(Context.make(Note, "two"))
      ]
    ) {
      const node = Graph.nodes(Graph.build(copy, {})).find((entry) => entry.ast._tag === "FlowCall")
      expect(node?.declaredAt).toEqual(original)
    }
  })

  it("keeps the original action location instead of the annotation call site", () => {
    const original = DeclarationSite.declaredAt(DeclaredAction)
    expect(original?.path.endsWith("test/AnnotatedProvenance.test.ts")).toBe(true)
    for (
      const copy of [
        DeclaredAction.annotate(Note, "one"),
        DeclaredAction.annotateMerge(Context.make(Note, "two")),
        DeclaredAction.annotate(Note, "one").annotateMerge(Context.make(Note, "two"))
      ]
    ) {
      const node = Graph.nodes(Graph.build(copy.call({}))).find((entry) => entry.ast._tag === "ActionCall")
      expect(node?.declaredAt).toEqual(original)
    }
  })

  it("does not invent author provenance when annotating a system declaration", () => {
    expect(DeclarationSite.declaredAt(Sleep.action)).toBeUndefined()
    expect(DeclarationSite.declaredAt(Sleep.action.annotate(Note, "one"))).toBeUndefined()
    expect(DeclarationSite.declaredAt(Sleep.action.annotateMerge(Context.make(Note, "two"))))
      .toBeUndefined()
  })
})
