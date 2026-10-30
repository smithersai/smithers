import { readFileSync } from "node:fs"
import * as ts from "typescript"
import { expect, it } from "vitest"

it("dispatch preserves the driver's declared cycle failure in its Effect type", () => {
  // The package check compiles this signature and its implementation. This
  // regression guards the private annotation without loading the whole SDK's
  // type graph into a coverage worker a second time.
  const path = new URL("../src/FlowEngine/Trampoline.ts", import.meta.url)
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  let dispatch: ts.VariableDeclaration | undefined
  let contract: ts.TypeAliasDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "dispatch") dispatch = node
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "Dispatch") contract = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(dispatch).toBeDefined()
  expect(contract).toBeDefined()
  const implementation = dispatch!.initializer!
  expect(ts.isArrowFunction(implementation)).toBe(true)
  expect((implementation as ts.ArrowFunction).type?.getText(source)).toBe("Dispatch")
  expect(ts.isTypeReferenceNode(contract!.type)).toBe(true)
  const result = contract!.type as ts.TypeReferenceNode
  expect(result.typeName.getText(source)).toBe("Effect.Effect")
  expect(result.typeArguments?.[1]?.getText(source)).toBe("FlowRuntime.FlowCycleDetected")
})
