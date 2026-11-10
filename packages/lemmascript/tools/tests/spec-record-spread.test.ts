import assert from "node:assert/strict";
import test from "node:test";
import { parseExpr } from "../src/specparser.js";

test("a record literal may begin with a spread", () => {
  const parsed = parseExpr("{ ...state, menu: !state.menu }");
  assert.equal(parsed.kind, "record");
  assert.deepEqual(parsed.kind === "record" ? parsed.fields.map((field) => field.name) : [], ["menu"]);
  assert.equal(parsed.kind === "record" ? parsed.spread?.kind : undefined, "var");
});

test("a spread alone is a record", () => {
  const parsed = parseExpr("{ ...state }");
  assert.equal(parsed.kind === "record" ? parsed.fields.length : -1, 0);
  assert.equal(parsed.kind === "record" ? parsed.spread?.kind : undefined, "var");
});

test("a spread after a field is refused, matching the checked object form", () => {
  assert.throws(() => parseExpr("{ menu: true, ...state }"));
});
