import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { classify, classifyContent } from "../fixtures/negated-array-ternary.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny, transformModuleLean } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";

function fixture() {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/negated-array-ternary.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

test("negated Array.isArray ternaries agree with source execution for both variants", () => {
  for (const value of ["", "text", [], [0]] as (string | number[])[]) {
    const expected = Array.isArray(value) ? 2 : 1;
    assert.equal(classify(value), expected);
    assert.equal(classifyContent({ content: value }), expected);
  }
  for (const fn of fixture().functions) {
    const statement = fn.body[0];
    assert.equal(statement.kind, "return");
    if (statement.kind !== "return") continue;
    const value = statement.value;
    assert.equal(value.kind, "tagMatch");
    if (value.kind !== "tagMatch") continue;
    assert.equal(value.cases[0].variant, "NonArrayBranch");
    assert.deepEqual(value.cases[0].body, { kind: "num", value: 1, ty: { kind: "nat" } });
    assert.deepEqual(value.fallthrough, { kind: "num", value: 2, ty: { kind: "nat" } });
  }
});

test("Dafny preserves the branches of negated array tests on variables and paths", () => {
  const { typesFile, defFile } = transformModuleDafny(fixture());
  const output = emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
  assert.equal([...output.matchAll(/case NonArrayBranch\([^)]*\) =>\s+1\s+case _ =>\s+2/g)].length, 2, output);
});

test("Lean preserves the branches of negated array tests on variables and paths", () => {
  const { typesFile } = transformModuleLean(fixture());
  assert.ok(typesFile);
  resetLeanModule();
  const output = emitLeanFile(typesFile);
  assert.equal([...output.matchAll(/\| \.NonArrayBranch [^\n]+ =>\s+1\s+\| _ =>\s+2/g)].length, 2, output);
});
