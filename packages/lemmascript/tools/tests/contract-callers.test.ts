import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";
import { guardedIndex, guardedOr, lastNonzero, trailingZeros } from "../fixtures/contract-callers.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("callers.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "callers.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

const fixture = readFileSync(new URL("../fixtures/contract-callers.ts", import.meta.url), "utf8");

test("the fixture answers as its contracts say", () => {
  assert.equal(lastNonzero([0, 3, 0]), 3);
  assert.equal(lastNonzero([0, 0]), 0);
  assert.equal(trailingZeros([1, 0, 0]), 2);
  assert.equal(trailingZeros([]), 0);
});

test("a function body and a method call the callee's lemma before the call", () => {
  const output = emit(fixture);
  const body = output.slice(output.indexOf("function lastNonzero"), output.indexOf("lemma lastNonzero_ensures"));
  assert.match(body, /zerosStart_ensures\(xs, \|xs\|\);\n\s*var end := zerosStart\(xs, \|xs\|\);/);
  const method = output.slice(output.indexOf("method trailingZeros"));
  assert.match(method, /zerosStart_ensures\(xs, \|xs\|\);\n\s*var .* := zerosStart\(xs, \|xs\|\);/);
});

test("a recursive function's body does not call its own lemma; the lemma calls itself, with the decreases clause", () => {
  const output = emit(fixture);
  const fn = output.slice(output.indexOf("function zerosStart"), output.indexOf("lemma zerosStart_ensures"));
  assert.doesNotMatch(fn, /zerosStart_ensures/);
  const lemma = output.slice(output.indexOf("lemma zerosStart_ensures"), output.indexOf("function lastNonzero"));
  assert.match(lemma, /decreases end/);
  assert.match(lemma, /zerosStart_ensures\(xs, \(end - 1\)\);/);
});

test("a companion lemma substitutes a let's value instead of declaring a local", () => {
  const output = emit(fixture);
  const lemma = output.slice(output.indexOf("lemma lastNonzero_ensures"), output.indexOf("method trailingZeros"));
  assert.match(lemma, /\{\n\s*zerosStart_ensures\(xs, \|xs\|\);\n\}/);
  assert.doesNotMatch(lemma, /var /);
});

test("a call under && gets no lemma call, and a call in a branch gets it inside that branch", () => {
  const output = emit(`
//@ verify
//@ requires 0 < n
//@ ensures \\result > 0
export function positive(n: number): number { return n }

//@ verify
export function guarded(n: number): boolean { return n > 0 && positive(n) > 0 }

//@ verify
export function branch(n: number): number { return n > 0 ? positive(n) : 1 }
`);
  const callers = output.slice(output.indexOf("function guarded"));
  assert.doesNotMatch(callers.slice(0, callers.indexOf("function branch")), /positive_ensures/);
  const branch = callers.slice(callers.indexOf("function branch"));
  assert.doesNotMatch(branch.slice(0, branch.indexOf("if ")), /positive_ensures/);
  assert.match(branch, /if \(n > 0\) then\n\s*positive_ensures\(n\);\n\s*positive\(n\)/);
});

test("a companion lemma guards contracts on short-circuit operands", () => {
  const output = emit(`
//@ verify
//@ requires 0 < n
//@ ensures \\result == n
export function positive(n: number): number { return n }
//@ verify
//@ ensures \\result == (n > 0 && positive(n) > 0)
export function conjunction(n: number): boolean { return n > 0 && positive(n) > 0 }
//@ verify
//@ ensures \\result == (n <= 0 || positive(n) > 0)
export function disjunction(n: number): boolean { return n <= 0 || positive(n) > 0 }
`);
  const and = output.slice(output.indexOf("lemma conjunction_ensures"), output.indexOf("function disjunction"));
  assert.match(and, /if \(n > 0\) \{\s*positive_ensures\(n\);\s*\}/);
  const or = output.slice(output.indexOf("lemma disjunction_ensures"));
  assert.match(or, /if !\(\(n <= 0\)\) \{\s*positive_ensures\(n\);\s*\}/);
});

test("guarded calls keep the empty and nonempty runtime cases", () => {
  assert.deepEqual(["", "9", "8"].map(guardedIndex), [false, true, false]);
  assert.deepEqual(["", "9", "8"].map(guardedOr), [true, true, false]);
});

test("a pure call in a method condition stays under its index guard", () => {
  const output = emit(`
//@ verify
//@ ensures \\result == (n == 57)
export function nine(n: number): boolean { return n === 57 }
//@ verify
//@ ensures \\result == (text.length > 0 && nine(text.charCodeAt(0)))
export function guardedIndex(text: string): boolean {
  let found = false
  if (text.length > 0 && nine(text.charCodeAt(0))) found = true
  return found
}
`);
  const method = output.slice(output.indexOf("method guardedIndex"));
  assert.match(method, /if \(\|text\| > 0\) \{/);
  const body = method.slice(method.indexOf("{") + 1);
  assert.doesNotMatch(body.slice(0, body.indexOf("if ")), /nine\(/);
});
