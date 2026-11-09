import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { guardedReturn, guardedConditional, type Box } from "../fixtures/optional-guard-order.ts";
import { extractConjunct } from "../src/condition-facts.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny, transformModuleLean } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";
import type { TExpr } from "../src/typedir.ts";

const atom = (name: string): TExpr => ({ kind: "var", name, ty: { kind: "bool" } });
const and = (left: TExpr, right: TExpr): TExpr => ({ kind: "binop", op: "&&", left, right, ty: { kind: "bool" } });
const [a, b, c, noise] = ["a", "b", "c", "noise"].map(atom);
const parse = (e: TExpr) => e.kind === "var" && e.name !== "noise" ? e.name : null;

for (const [name, condition, expected] of [
  ["left-associated", and(and(a, b), c), { check: "a", restCond: and(b, c) }],
  ["right-associated", and(a, and(b, c)), { check: "a", restCond: and(b, c) }],
  ["nested after an unrelated guard", and(and(noise, a), b), { check: "a", restCond: and(noise, b) }],
  ["right subtree", and(noise, and(a, b)), { check: "a", restCond: and(noise, b) }],
  ["right operand only", and(and(noise, noise), a), { check: "a", restCond: and(noise, noise) }],
  ["no matching conjunct", and(noise, noise), null],
] as const) {
  test(`extracts the first matching conjunct in source order: ${name}`, () => {
    assert.deepEqual(extractConjunct(condition, parse), expected);
  });
}

function fixture() {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/optional-guard-order.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

test("dependent optional checks unwrap the root before its fields in code and specs", () => {
  const inputs: (Box | undefined)[] = [undefined, {}, { inner: {} }, { inner: { value: 0 } }, { inner: { value: -7 } }];
  for (const fn of [guardedReturn, guardedConditional]) {
    assert.deepEqual(inputs.map(value => fn(value)), [-1, -1, -1, 0, -7]);
  }
  for (const fn of fixture().functions) {
    const first = fn.body[0];
    const body = first.kind === "return" ? first.value : first;
    for (const match of [body, fn.ensures[3]]) {
      assert.equal(match.kind, "someMatch");
      if (match.kind !== "someMatch") continue;
      assert.equal(match.scrutinee.kind, "var", "the outer match must bind box before any field access");
      if (match.scrutinee.kind === "var") assert.equal(match.scrutinee.name, "box");
    }
  }
});

test("both backends keep dependent field reads inside the root's match", () => {
  const mod = fixture();
  const dafny = transformModuleDafny(mod);
  const dafnyText = emitDafnyFile({ ...dafny.defFile, decls: [...(dafny.typesFile?.decls ?? []), ...dafny.defFile.decls] });
  const lean = transformModuleLean(mod);
  assert.ok(lean.typesFile);
  resetLeanModule();
  const leanText = emitLeanFile(lean.typesFile);
  for (const output of [dafnyText, leanText]) {
    assert.match(output, /match box/);
    assert.doesNotMatch(output, /\bbox\.inner\b/, "box is optional; field reads must use its unwrapped binder");
  }
});
