import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("lift.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "lift.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

// `counted` has a loop, so it becomes a Dafny method; a method call cannot stand inside an expression.
const source = `
//@ verify
//@ ensures \\result.items.length == n
export function counted(n: number): { readonly items: Array<number>; readonly total: number } {
  const items: Array<number> = []
  while (items.length < n) {
    //@ invariant items.length <= n
    //@ decreases n - items.length
    items.push(0)
  }
  return { items, total: items.length }
}
`;

test("a field read of a method call's result binds the call first", () => {
  const output = emit(source + `
//@ verify
//@ requires n >= 0
//@ ensures \\result.length == n
export function itemsOf(n: number): Array<number> {
  return counted(n).items
}
`);
  const method = output.slice(output.indexOf("method itemsOf"));
  assert.match(method, /var (\w+) := counted\(n\);[\s\S]*\1\.items/);
  assert.doesNotMatch(method, /counted\(n\)\.items/);
});

test("an array length of a method call's result binds the call first", () => {
  const output = emit(source + `
//@ verify
//@ requires n >= 0
//@ ensures \\result == n
export function sizeOf(n: number): number {
  return counted(n).items.length
}
`);
  const method = output.slice(output.indexOf("method sizeOf"));
  assert.match(method, /var (\w+) := counted\(n\);[\s\S]*\|\1\.items\|/);
});

test("a field read under && binds the call only behind the left operand", () => {
  const output = emit(source + `
//@ verify
//@ requires n >= 0
export function someTotal(n: number): boolean {
  return n > 2 && counted(n).total > 2
}
`);
  const method = output.slice(output.indexOf("method someTotal"));
  const guard = method.indexOf("n > 2");
  const call = method.indexOf(":= counted(n)");
  assert.ok(guard >= 0 && call > guard, method);
  assert.match(method, /if \(?n > 2\)?/);
});
