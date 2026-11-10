import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpr } from "../src/specparser.ts";
test("array-valued contract spreads retain literal groups and spread order", () => {
  const variable = (name: string) => ({ kind: "var", name });
  const literal = (name: string) => ({ kind: "arrayLiteral", elems: [variable(name)] });
  const concat = (left: unknown, right: unknown) => ({ kind: "binop", op: "arrayConcat", left, right });
  assert.deepEqual(parseExpr("[a, ...xs, b, ...ys]"), concat(concat(concat(literal("a"), variable("xs")), literal("b")), variable("ys")));
  assert.deepEqual(parseExpr("[...xs]"), variable("xs"));
  assert.deepEqual(parseExpr("[a, b]"), { kind: "arrayLiteral", elems: [variable("a"), variable("b")] });
});
