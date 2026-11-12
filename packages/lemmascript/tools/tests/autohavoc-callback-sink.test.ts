import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { autoHavocModule } from "../src/autohavoc.ts";

const header = `//@ autohavoc

//@ extern
//@ requires x > 0
declare function sink(x: number): number;
`;

function autohavoc(body: string) {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.createSourceFile("callback-sink.ts", header + body);
  assert.deepEqual(project.getPreEmitDiagnostics().map(d => d.getMessageText()), [], "the regression must be valid TypeScript");
  return autoHavocModule(narrowModule(resolveModule(extractModule(source))));
}

const unchecked = /contracted call sink inside a callback of an unmodellable call would go unchecked/;

test("a contracted call in the callback of a dropped statement fails generation", () => {
  assert.throws(() => autohavoc(`export function each(xs: number[]): void {
  xs.forEach(x => sink(x));
}
`), unchecked);
});

test("a contracted call in a callback nested under a havoc'd value fails generation", () => {
  assert.throws(() => autohavoc(`export function logged(xs: number[]): void {
  console.log(xs.map(x => [1].map(y => sink(x + y))));
}
`), unchecked);
});

test("a contracted argument of a havoc'd call is still hoisted and checked", () => {
  const [fn] = autohavoc(`export function direct(x: number): void {
  console.log(sink(x), [x].map(y => y + 1));
}
`).functions;
  assert.equal(fn.body.length, 1);
  const [stmt] = fn.body;
  assert.equal(stmt.kind, "expr");
  if (stmt.kind !== "expr") return;
  assert.equal(stmt.expr.kind, "call");
  if (stmt.expr.kind !== "call") return;
  assert.equal(stmt.expr.fn.kind === "var" && stmt.expr.fn.name, "sink");
});
