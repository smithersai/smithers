import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";
import { lastIndexByKey, reach } from "../fixtures/map-set.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("map.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "map.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("the fixture keeps each key's last index", () => {
  const byKey = lastIndexByKey([{ key: "a" }, { key: "b" }, { key: "a" }]);
  assert.deepEqual([...byKey], [["a", 2], ["b", 1]]);
});

test("a map lookup guarded by `k in m` on the left of ==> indexes a sequence as a value", () => {
  const output = emit(`
//@ verify
//@ ensures forall(k: string, k in m ==> xs[m[k]] == k)
export function f(m: Map<string, number>, xs: ReadonlyArray<string>): boolean { return true }
`);
  assert.match(output, /\(k in m\) ==> \(xs\[m\[k\]\] == k\)/);
  assert.doesNotMatch(output, /Some\(m\[k\]\)/);
});

test("the same narrowing holds on the right of &&", () => {
  const output = emit(`
//@ verify
//@ ensures \\result == (k in m && xs[m[k]] == k)
export function f(m: Map<string, number>, xs: ReadonlyArray<string>, k: string): boolean { return k in m }
`);
  assert.doesNotMatch(output, /Some\(m\[k\]\)/);
});

test("an unguarded map lookup stays optional", () => {
  const output = emit(`
//@ verify
//@ ensures \\result == (m[k] == 1)
export function f(m: Map<string, number>, k: string): boolean { return m.get(k) === 1 }
`);
  assert.doesNotMatch(output, /res == \(m\[k\] == 1\)/);
});

test("the fixture's walk reaches every child once, through its map", () => {
  const children = new Map<string, ReadonlyArray<string>>([["a", ["b", "c"]], ["b", ["a"]], ["c", []]]);
  assert.deepEqual([...reach(children, ["a"])].sort(), ["a", "b", "c"]);
  assert.deepEqual([...reach(children, ["x"])], []);
});

test("a contract's m.keys() is the map's key set", () => {
  const output = emit(`
//@ verify
//@ ensures \\result == (k in m.keys())
export function f(m: Map<string, number>, k: string): boolean { return m.has(k) }
`);
  assert.match(output, /\(k in m\.Keys\)/);
});

test("a loop may decrease a map's keys minus a set", () => {
  const output = emit(`
//@ verify
export function f(m: Map<string, number>, s: Set<string>): number {
  let n = 0
  while (n < 1) {
    //@ decreases m.keys() - s
    n = n + 1
  }
  return n
}
`);
  assert.match(output, /decreases \(?m\.Keys - s\)?/);
});

test("an optional result checked present on the left of && is the value on the right", () => {
  for (const contract of ["\\result != undefined && \\result.length == 0", "b ==> \\result != undefined && \\result.length == 0"]) {
    const output = emit(`
//@ verify
//@ ensures ${contract}
export function f(b: boolean): ReadonlyArray<number> | undefined { return [] }
`);
    assert.doesNotMatch(output, /\|f\(b\)\|/, contract);
    assert.match(output, /case Some\((\w+)\) => \(\|\1\| == 0\) case None => false/, contract);
  }
});

test("a premise's presence check still binds the conclusion when the premise is a conjunction", () => {
  const output = emit(`
//@ verify
//@ ensures \\result != undefined && b ==> \\result.length == 0
export function f(b: boolean): ReadonlyArray<number> | undefined { return [] }
`);
  assert.doesNotMatch(output, /\|f\(b\)\|/);
  assert.match(output, /case Some\((\w+)\) => \(b ==> \(\|\1\| == 0\)\) case None => true/);
});

test("a right side that already coalesces the checked value keeps its own match", () => {
  const output = emit(`
export interface W { readonly step: number }
export interface R { readonly w?: W }
//@ verify
//@ ensures \\result.w != undefined && (\\result.w ?? { step: 1 }) == { step: 1 }
export function f(): R { return { w: { step: 1 } } }
`);
  assert.doesNotMatch(output, /match \w+_val \{ case Some/, "a bound value is never matched as an Option");
});

test("a record literal default of ?? builds the left's type", () => {
  const output = emit(`
export interface W { readonly step: number }
export interface R { readonly w?: W }
//@ verify
//@ ensures (\\result.w ?? { step: 1 }) == { step: 1 }
export function f(): R { return { w: { step: 1 } } }
`);
  assert.doesNotMatch(output, /case None => R\(/);
  assert.match(output, /case None => W\(1\)/);
});
