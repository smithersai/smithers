import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { suffix, replyId, pastEnd, emptyTail } from "../fixtures/safe-slice-suffix.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string, safe: boolean): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("slice.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "slice.ts", resolveOptions({ "safe-slice": safe, "dafny-library": "local" }, "test"));
}

const SOURCE = [
  "export function tail(xs: ReadonlyArray<number>, n: number): ReadonlyArray<number> { return xs.slice(n); }",
  "export function rest(s: string, n: number): string { return s.slice(n); }",
  "export function part(s: string, a: number, b: number): string { return s.slice(a, b); }",
].join("\n");

test("the fixture's slices clamp like JavaScript", () => {
  assert.deepEqual(suffix([1, 2, 3], 5), []);
  assert.deepEqual(suffix([1, 2, 3], -1), [3]);
  assert.deepEqual(suffix([1, 2, 3], -9), [1, 2, 3]);
  assert.equal(replyId(""), "r");
  assert.equal(replyId("p7"), "r7");
  assert.equal(pastEnd("ab"), "");
  assert.deepEqual(emptyTail([1]), []);
});

test("safe-slice clamps one-argument array slices and every string slice", () => {
  const output = emit(SOURCE, true);
  assert.match(output, /SafeSlice\(xs, n, \|xs\|\)/);
  assert.match(output, /SafeSlice\(s, n, \|s\|\)/);
  assert.match(output, /SafeSlice\(s, a, b\)/);
  assert.match(output, /function SafeSlice/);
});

test("without safe-slice the direct Dafny slices are unchanged", () => {
  const output = emit(SOURCE, false);
  assert.match(output, /xs\[n\.\.\]/);
  assert.match(output, /s\[n\.\.\]/);
  assert.match(output, /s\[a\.\.b\]/);
  assert.doesNotMatch(output, /SafeSlice/);
});
