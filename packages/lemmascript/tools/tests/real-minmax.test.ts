import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { clampedTop, span, positive, smaller } from "../fixtures/real-minmax.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("clamp.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "clamp.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("the fixture's clamps run on fractional values", () => {
  assert.equal(clampedTop(72.5, 0, false), 72.5);
  assert.equal(clampedTop(10.25, 0, false), 60);
  assert.equal(span(2.5, 3), 1);
  assert.equal(span(1.5, 4), 2.5);
  assert.equal(positive(-0.5), 0);
  assert.equal(smaller(3, 2), 2);
});

test("real min and max use the real helpers and lift integer operands", () => {
  const output = emit("type real = number\nexport function f(x: real, c: boolean): real { return Math.max(60, Math.min(x, c ? x : 80)); }");
  assert.match(output, /MathMaxReal\(\(60 as real\), MathMinReal\(x, \(if c then x else \(80 as real\)\)\)\)/);
  assert.match(output, /function MathMaxReal\(a: real, b: real\): real/);
});

test("integer min and max are unchanged", () => {
  const output = emit("export function f(a: number, b: number): number { return Math.max(a, Math.min(b, 3)); }");
  assert.match(output, /MathMax\(a, MathMin\(b, 3\)\)/);
  assert.doesNotMatch(output, /MathMaxReal|MathMinReal/);
});

test("a real else branch and a trailing integral operand are lifted symmetrically", () => {
  const output = emit("type real = number\nexport function f(x: real, c: boolean): real { return Math.min(c ? 0 : x, Math.max(x, 1)); }");
  assert.match(output, /MathMinReal\(\(if c then \(0 as real\) else x\), MathMaxReal\(x, \(1 as real\)\)\)/);
});
