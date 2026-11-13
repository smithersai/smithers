import { readFile } from "node:fs/promises"
import ts from "typescript"
import { expect, test } from "vitest"

// The account cleanup is registered with Playwright, outside the success path and browser/device fixtures.
test("the BYOK journey restores the account in a trace-free afterEach using the independent request fixture", async () => {
  const text = await readFile(new URL("./byok-first.spec.ts", import.meta.url), "utf8")
  const source = ts.createSourceFile("byok-first.spec.ts", text, ts.ScriptTarget.Latest, true)
  const calls = source.statements.filter(ts.isExpressionStatement).map(statement => statement.expression).filter(ts.isCallExpression)
  const cleanup = calls.find(call => call.expression.getText(source) === "test.afterEach")
  expect(cleanup, "restoration must run after assertion failures and timeouts").toBeDefined()
  const hook = cleanup!.arguments[0]!
  expect(ts.isArrowFunction(hook)).toBe(true)
  const callback = hook as ts.ArrowFunction
  expect(callback.parameters[0]!.name.getText(source)).toBe("{ request }")
  expect(callback.body.getText(source)).toContain("await restorePersonalModel(request)")
  const use = calls.find(call => call.expression.getText(source) === "test.use")
  expect(use?.arguments[0]?.getText(source)).toBe('{ trace: "off" }')
})
