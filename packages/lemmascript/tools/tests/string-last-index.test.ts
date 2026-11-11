import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { lastAt, emptyAtEnd, lastSegment } from "../fixtures/string-last-index.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny, transformModuleLean } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";

function sourceModule(text: string) {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("last.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

test("the fixture runs as JavaScript's lastIndexOf", () => {
  for (const s of ["", "a", "aa", "a/b/c", "/", "abc"]) {
    for (const sub of ["", "a", "aa", "/", "abcd"]) assert.equal(lastAt(s, sub), s.lastIndexOf(sub));
    assert.equal(emptyAtEnd(s), s.length);
  }
  assert.equal(lastSegment("vibelang/Post"), "Post");
  assert.equal(lastSegment("Post"), "Post");
  assert.equal(lastSegment("a/"), "");
});

test("Dafny emits the last-match helper only when a module calls lastIndexOf", () => {
  const { typesFile, defFile } = transformModuleDafny(sourceModule(
    'export function last(s: string): number { return s.lastIndexOf("/"); }'));
  const output = emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
  assert.match(output, /StringLastIndexOf\(s, "\/"\)/);
  assert.match(output, /function StringLastIndexOf\(s: string, sub: string\): int/);
  const plain = transformModuleDafny(sourceModule('export function first(s: string): number { return s.indexOf("/"); }'));
  assert.doesNotMatch(emitDafnyFile({ ...plain.defFile, decls: [...(plain.typesFile?.decls ?? []), ...plain.defFile.decls] }), /StringLastIndexOf/);
});

test("a lastIndexOf position is refused, never dropped", () => {
  const { typesFile, defFile } = transformModuleDafny(sourceModule(
    'export function last(s: string, p: number): number { return s.lastIndexOf("/", p); }'));
  assert.throws(() => emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] }), /lastIndexOf.*position/);
});

test("Lean refuses lastIndexOf by name", () => {
  const { typesFile, defFile } = transformModuleLean(sourceModule(
    'export function last(s: string): number { return s.lastIndexOf("/"); }'));
  resetLeanModule();
  assert.throws(() => emitLeanFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] }), /lastIndexOf/);
});
