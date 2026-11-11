import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern, RegexRefused, testPattern } from "../src/regex.ts";

// The patterns VibeLang's history and wiki scripts test, and the subset's corners.
const patterns = [
  "[.!?][\"'`)\\]]*$", "^([a-z]+)(?:\\(([^)]*)\\))?!?:\\s", "^([A-Za-z][\\w./-]*):\\s", "^[A-Za-z0-9][A-Za-z0-9-]*:", "^[ \\t]",
  "^Mythical:\\s*(m\\d+)$", "^decisions\\/[0-9]{4}-", "VL-[0-9]+", "\\.md$", "^(Validation|Tests?|Regression|Before|After):\\s*(.+)$",
  "^(?:[A-Z][\\w-]*:\\s|[-*•]\\s|\\d+[.)]\\s)", "a{2,3}b", "x{0,}y", "(ab|c)+d?", "[^a-c]+", ".", "^$", "", "a*?b+?",
];
const alphabet = ["a", "b", "c", "d", "x", "y", ".", "!", "?", ")", "]", "'", ":", " ", "\t", "\n", "-", "(", "m", "1", "7", "V", "L", "M", "T", "e", "s", "/", "•", " "];

function* strings(next: () => number, count: number) {
  for (let n = 0; n < count; n++) {
    const length = next() % 9;
    let s = "";
    for (let i = 0; i < length; i++) s += alphabet[next() % alphabet.length];
    yield s;
  }
}

test("the language semantics answers test exactly as the native RegExp", () => {
  let state = 20261111;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
  const samples = ["Mythical: m7", "fix(compiler): a", "docs: x", "Tests: ok", "- item", "12) x", "decisions/0018-proofs", "VL-29", "a.md", "Done.)", "aab", "abcd"];
  for (const source of patterns) {
    const native = new RegExp(source);
    const parsed = parsePattern(source, "");
    for (const s of [...samples, ...strings(next, 400)]) assert.equal(testPattern(parsed, s), native.test(s), `/${source}/ on ${JSON.stringify(s)}`);
  }
});

test("patterns outside the subset are refused by name", () => {
  for (const [source, flags, why] of [["\\bnyc-\\d+\\b", "", /word boundary/], ["a(?=b)", "", /lookaround/], ["(a)\\1", "", /backreference/],
    ["a", "i", /flags/], ["a", "g", /flags/], ["^a|b", "", /alternation beside an anchor/], ["a^b", "", /anchor/], ["\\p{L}", "", /escape/]] as const) {
    assert.throws(() => parsePattern(source, flags), (e: unknown) => e instanceof RegexRefused && why.test((e as Error).message), `/${source}/${flags}`);
  }
});

test("a contract's \\matches names the same test as the pattern's literal", async () => {
  const { parseExpr } = await import("../src/specparser.ts");
  const { regexTestName } = await import("../src/regex.ts");
  const parsed = parseExpr('\\matches("^[ \\\\t]", line)');
  assert.equal(parsed.kind, "call");
  assert.deepEqual(parsed.kind === "call" ? parsed.fn : undefined, { kind: "var", name: regexTestName("^[ \\t]", "") });
  assert.throws(() => parseExpr('\\matches("\\\\bx", s)'), /word boundary/);
});
