import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleDafny } from "../src/transform.js";
import { emitDafnyFile } from "../src/dafny-emit.js";
import { absentOrLong, bothBounded, eitherAbsentOrLonger } from "../fixtures/optional-or-narrowing.ts";

function emitted(name: string): string {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
}

test("an absent-or disjunction agrees with source execution", () => {
  assert.deepEqual([absentOrLong(undefined), absentOrLong("a"), absentOrLong("ab")], [true, false, true]);
  assert.deepEqual([bothBounded(undefined, undefined), bothBounded("", undefined), bothBounded("a", "123456789")], [true, false, false]);
  assert.deepEqual([eitherAbsentOrLonger(undefined, "x"), eitherAbsentOrLonger("ab", undefined), eitherAbsentOrLonger("a", "ab")], [true, true, false]);
});

test("the right operand of x === undefined || P(x) reads the narrowed value in Dafny", () => {
  const output = emitted("optional-or-narrowing");
  // Each disjunction is a match whose None arm is true; no call or length receives the Option itself.
  assert.match(output, /match text \{ case Some\((\w+)\) => longEnough\(\1\) case None => true \}/, output);
  assert.doesNotMatch(output, /longEnough\(text\)/, output);
  assert.match(output, /match a \{ case Some\(i_a_val\) => \(\|i_a_val\| > 0\) case None => true \}/, output);
  assert.match(output, /match b \{ case Some\(i_b_val\) => \(\|i_b_val\| < 9\) case None => true \}/, output);
  // A chain of absence facts nests one match per fact.
  assert.match(output, /match a \{ case Some\(i_a_val\) => \(match b \{ case Some\(i_b_val\) => \(\|i_a_val\| > \|i_b_val\|\) case None => true \}\) case None => true \}/, output);
});

test("a disjunction that never reads the checked value keeps its shape", () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const source = project.createSourceFile("plain.ts", `
export function plain(x: number | undefined, flag: boolean): boolean {
  //@ ensures \\result === (x === undefined || flag)
  return x === undefined || flag
}`);
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  const output = emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
  assert.match(output, /\(\(match x \{ case Some\(i_\) => false case None => true \}\) \|\| flag\)/, output);
  assert.doesNotMatch(output, /case Some\(i_x_val\)/, output);
});
