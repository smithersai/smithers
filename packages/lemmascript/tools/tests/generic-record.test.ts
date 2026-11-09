import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { next, swap, appended } from "../fixtures/generic-record.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("page.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "page.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("the fixture's generic records run", () => {
  assert.deepEqual(next({ seq: 1, items: ["a"] }), { seq: 2, items: ["a"] });
  assert.deepEqual(swap({ left: 1, right: 2 }), { left: 2, right: 1 });
  assert.deepEqual(appended({ seq: 0, items: [1] }, 2), [1, 2]);
});

test("generic interfaces and object aliases emit their type parameters", () => {
  const output = emit("export interface Page<C> { readonly seq: number; readonly items: ReadonlyArray<C> }\n"
    + "export type Pair<A> = { readonly left: A; readonly right: A }\n"
    + "export function f<C>(p: Page<C>, q: Pair<C>): Page<C> { return p; }");
  assert.match(output, /datatype Page<C> = Page\(seq_: int, items: seq<C>\)/);
  assert.match(output, /datatype Pair<A> = Pair\(left: A, right: A\)/);
});

test("a plain record is unchanged", () => {
  const output = emit("export interface Spot { readonly y: number }\nexport function f(s: Spot): Spot { return s; }");
  assert.match(output, /datatype Spot = Spot\(y: int\)/);
});

test("a generic interface used by a verified function keeps its parameter", () => {
  const output = emit("export interface Page<C> { readonly seq: number; readonly items: ReadonlyArray<C> }\n"
    + "//@ verify\n//@ ensures \\result.seq == p.seq\nexport function f<C>(p: Page<C>): Page<C> { return p; }");
  assert.match(output, /datatype Page<C> = Page\(seq_: int, items: seq<C>\)/);
});
