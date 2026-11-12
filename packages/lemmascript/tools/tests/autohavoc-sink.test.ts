import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { autoHavocModule } from "../src/autohavoc.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("sink.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const typed = autoHavocModule(narrowModule(resolveModule(extractModule(source))));
  const { typesFile, defFile } = transformModuleDafny(typed);
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "sink.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

const sinkDecl = `
//@ extern
//@ requires x > 0
declare function sink(x: number): unknown;
`;

function method(output: string, name: string): string {
  const start = output.indexOf(`method ${name}`);
  assert.ok(start >= 0, `${name} is emitted:\n${output}`);
  const end = output.indexOf("\n}", start);
  return output.slice(start, end);
}

test("a contracted call with an unknown result survives as a statement", () => {
  const output = emit(`${sinkDecl}
//@ autohavoc
export function direct(x: number): void { sink(x); }
`);
  assert.match(method(output, "direct"), /sink\(x\)/);
});

test("a contracted call with an unknown result survives as an initializer and a return value", () => {
  const output = emit(`${sinkDecl}
//@ autohavoc
export function initializer(x: number): number { const r = sink(x); return 1; }

//@ autohavoc
export function returned(x: number): unknown { return sink(x); }
`);
  assert.match(method(output, "initializer"), /sink\(x\)/);
  assert.match(method(output, "returned"), /sink\(x\)/);
});

test("a contracted call with an unknown result nested in a havoc keeps its call", () => {
  const output = emit(`${sinkDecl}
declare const opaque: unknown;

//@ autohavoc
export function nested(x: number): void { (opaque as any).send(sink(x)); }
`);
  assert.match(method(output, "nested"), /sink\(x\)/);
});
