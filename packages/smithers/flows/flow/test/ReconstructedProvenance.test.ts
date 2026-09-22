import { Action, Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Schema } from "effect"
import { expect, it } from "vitest"
import * as DeclarationSite from "../src/internal/DeclarationSite.ts"

const body = Node.capture({}, () => Node.succeed("value"))
const sourceFlow = Flow.make("reconstructed/flow", { payload: {}, success: Schema.String, body })
const sourceAction = Action.make("reconstructed/action", { payload: {} })
const note = Context.Service<string>("reconstructed/note")
const declarationOf = (node: Node.Any) => {
  if (node.ast._tag !== "FlowCall" && node.ast._tag !== "ActionCall") throw new Error("expected a call")
  return Node.declaration(node.ast)
}

it("reconstructs a flow with the source site and its own call declaration", () => {
  const flow = Flow.make("reconstructed/flow", {
    declaredFrom: sourceFlow,
    payload: {},
    success: Schema.String,
    body
  })
  expect(DeclarationSite.declaredAt(flow)).toEqual(DeclarationSite.declaredAt(sourceFlow))
  expect(declarationOf(flow.call({}))).toBe(flow)
  expect(DeclarationSite.declaredAt(flow.annotate(note, "changed"))).toEqual(DeclarationSite.declaredAt(sourceFlow))
  expect(Graph.drafts(Graph.build(flow, {}))).toEqual(Graph.drafts(Graph.build(sourceFlow, {})))
})

it("reconstructs an action with fresh closures and preserves the site through annotations", () => {
  const action = Action.make("reconstructed/action", {
    declaredFrom: sourceAction,
    payload: {},
    tier: "irreversible"
  })
  expect(DeclarationSite.declaredAt(action)).toEqual(DeclarationSite.declaredAt(sourceAction))
  expect(declarationOf(action.call({}))).toBe(action)
  expect(declarationOf(action.call({}))).not.toBe(sourceAction)
  expect(action.tier).toBe("irreversible")
  const annotated = action.annotateMerge(Context.make(note, "changed"))
  expect(declarationOf(annotated.call({}))).toBe(annotated)
  expect(DeclarationSite.declaredAt(annotated)).toEqual(DeclarationSite.declaredAt(sourceAction))
})

it("supports the same origin on system action construction", () => {
  const action = Action.makeSystem("reconstructed/system", { payload: {}, declaredFrom: sourceAction })
  expect(DeclarationSite.declaredAt(action)).toEqual(DeclarationSite.declaredAt(sourceAction))
  expect(declarationOf(action.call({}))).toBe(action)
})

it("preserves absent provenance and excludes the source reference from key material", () => {
  const source = {}
  const flow = Flow.make("reconstructed/flow", { payload: {}, success: Schema.String, body, declaredFrom: source })
  const action = Action.make("reconstructed/action", { payload: {}, declaredFrom: source })
  const system = Action.makeSystem("reconstructed/system", { payload: {}, declaredFrom: source })
  for (const declaration of [flow, action, system]) {
    expect(DeclarationSite.declaredAt(declaration)).toBeUndefined()
    expect(DeclarationSite.declaredAt(declaration.annotate(note, "changed"))).toBeUndefined()
  }
  expect(Graph.drafts(Graph.build(flow, {}))).toEqual(Graph.drafts(Graph.build(sourceFlow, {})))
  expect(Graph.drafts(Graph.build(action.call({})))).toEqual(Graph.drafts(Graph.build(sourceAction.call({}))))
})
