import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleDafny } from "../src/transform.js";
import { emitDafnyFile } from "../src/dafny-emit.js";
import { ops, saves } from "../fixtures/union-search.ts";

function emitted(): string {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/union-search.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
}

test("the fixture's functions agree with source execution", () => {
  assert.deepEqual(ops(), ["read", "save", "draft"]);
  assert.deepEqual([saves(["read"]), saves(["draft", "save"])], [false, true]);
});

test("a string literal searched for in a string-union array is the union's member", () => {
  const output = emitted();
  // A Dafny string literal against seq<Op> is a type error; each search names the constructor instead.
  for (const member of ["read", "save", "draft"]) assert.doesNotMatch(output, new RegExp(`"${member}" in `), output);
  assert.doesNotMatch(output, /SeqIndexOf\(ops, "save"\)/, output);
});
