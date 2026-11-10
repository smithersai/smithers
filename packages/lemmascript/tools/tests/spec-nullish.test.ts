import assert from "node:assert/strict";
import test from "node:test";
import { parseExpr } from "../src/specparser.js";

test("a contract may coalesce an optional with ??", () => {
  const parsed = parseExpr("box.runs ?? []");
  assert.equal(parsed.kind, "nullish");
});

test("?? binds looser than || and tighter than a conditional", () => {
  const parsed = parseExpr("a || b ?? c ? d : e");
  assert.equal(parsed.kind, "conditional");
  const cond = parsed.kind === "conditional" ? parsed.cond : undefined;
  assert.equal(cond?.kind, "nullish");
  assert.equal(cond?.kind === "nullish" ? cond.left.kind : undefined, "binop");
});

test("a lone ? is still the conditional", () => {
  assert.equal(parseExpr("a ? b : c").kind, "conditional");
});
