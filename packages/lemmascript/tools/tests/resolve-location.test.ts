import assert from "node:assert/strict";
import test from "node:test";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";

// An unsupported construct deep inside one long statement (the app's `update` is one `Message.match` call over 150
// lines) must be reported at its own line, so a failing whole-module extraction names the construct to fix.
function resolveText(text: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: ScriptTarget.ESNext } });
  return () => resolveModule(extractModule(project.createSourceFile("located.ts", text)));
}

const source = [
  "type R = { a: number; b: number }",                                   // 1
  "",                                                                    // 2
  "//@ verify",                                                          // 3
  "export function patched(y: R): R {",                                  // 4
  "  const kept = y",                                                    // 5
  "  return {",                                                          // 6
  "    ...JSON.parse(\"{}\"),",                                          // 7
  "    ...JSON.parse(\"{}\"),",                                          // 8
  "  }",                                                                 // 9
  "}",                                                                   // 10
].join("\n");

test("a resolution error names its function and the line of the innermost construct", () => {
  assert.throws(resolveText(source), (err: Error) => {
    assert.match(err.message, /^patched line 8: object spread merge \{ \.\.\.a, \.\.\.b \} needs a known record type/);
    return true;
  });
});

test("a construct inside a larger expression keeps its own line, once, not the enclosing statement's", () => {
  const nested = source.replace("  return {", "  const f = (n: number) => n\n  return f(0) === 0 && {");
  assert.throws(resolveText(nested), (err: Error) => {
    assert.match(err.message, /^patched line 9: object spread merge/);
    assert.doesNotMatch(err.message, /line \d+: .*line \d+:/);
    return true;
  });
});
