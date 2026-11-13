import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, test } from "vitest"

test("the timeline eval encloses acquisition, grading, artifacts and assertions in its scope lifetime", () => {
  const source = ts.createSourceFile("timeline.eval.ts", readFileSync(new URL("./timeline.eval.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
  const call = source.statements.find(statement =>
    ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
    statement.expression.arguments.some(argument => ts.isArrowFunction(argument) && argument.body.getText(source).includes("Scope.make()")),
  )
  expect(call).toBeDefined()
  const callback = (call as ts.ExpressionStatement).expression as ts.CallExpression
  const body = (callback.arguments.find(ts.isArrowFunction) as ts.ArrowFunction).body as ts.Block
  const [acquire, lifetime] = body.statements
  expect(acquire!.getText(source)).toContain("Scope.make()")
  expect(lifetime && ts.isTryStatement(lifetime)).toBe(true)
  if (lifetime === undefined || !ts.isTryStatement(lifetime)) return
  expect(body.statements).toHaveLength(2)
  expect(lifetime.finallyBlock?.getText(source)).toContain("await Effect.runPromise(Scope.close(scope, Exit.void))")
  for (const operation of ["resolver.resolve(seat)", "engineFor(real, spent)", "gradeFixture(engine, fixture)", "writeFileSync(", "expect(results"]) {
    expect(lifetime.tryBlock.getText(source)).toContain(operation)
  }
})
